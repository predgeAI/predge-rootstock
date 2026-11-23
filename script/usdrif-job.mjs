// USDRIF job escrow on Rootstock testnet (chainId 31): AgentJobERC20 + the unchanged PredgeNoObjectionEvaluator.
// One CLI for deploy and for every step of a job, so job 2 (objection branch) runs end to end in USDRIF:
//   funding (approve + createJob), submission, objection, reviewer verdict, payout / refund, withdraw.
//
//   forge build                                                        # artifacts in out/
//   node script/usdrif-job.mjs deploy                                  # AgentJobERC20(USDRIF, 24d) + evaluator(10d)
//   node script/usdrif-job.mjs evidence --checklist fixtures/rerise-b2b-checklist.v1.json \
//        --files before.jpg,during1.jpg+during2.jpg,after.jpg,report.pdf,manifests.pdf,inspection.pdf --out ev.json
//   node script/usdrif-job.mjs create   --client <IBUKI> --provider <contractor> --amount 10 --evidence ev.json [--expiry-days 7]
//   node script/usdrif-job.mjs submit   --job <id> --evidence ev.json            # provider
//   node script/usdrif-job.mjs object   --job <id> --text "written objection"   # client (IBUKI)
//   node script/usdrif-job.mjs resolve  --job <id> --refund|--pay --text "reviewer decision"   # reviewer
//   node script/usdrif-job.mjs release  --job <id> --evidence ev.json            # anyone, after a silent objection period
//   node script/usdrif-job.mjs refund   --job <id>                               # anyone, after the evaluation window
//   node script/usdrif-job.mjs withdraw --as client|provider [--to <addr>]
//   node script/usdrif-job.mjs status   --job <id> [--tz Asia/Tokyo]            # read-only, deadlines in UTC + local
//   node script/usdrif-job.mjs e2e --rpc http://127.0.0.1:8545                  # full objection branch on a LOCAL fork
//
// Signing: a step is signed only if the script holds the key of the address that must act (test wallets in
// $PREDGE_RSK_KEYS, default ~/.predge-rsk: testnet-deployer.json, testnet-roles.json; or PRIVATE_KEY in .env for
// the deployer). Otherwise it prints the unsigned transaction(s) (to + data) for the party's own wallet, e.g. IBUKI's
// MetaMask. Keys are never printed. Writes to the public testnet need CONFIRM_TESTNET=rootstock-testnet.
import { JsonRpcProvider, Wallet, Contract, ContractFactory, AbiCoder, Interface, sha256, keccak256, toUtf8Bytes, getBytes, concat, getAddress, parseUnits, formatUnits } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readJobDeadlines } from "../sdk/deadlines.mjs";

// RIF US Dollar on Rootstock testnet. Lower-cased on purpose: the explorer spelling
// 0x8dbF326E12a9fF37ED6ddf75adA548c2640a6482 is the RSK (EIP-1191, chain 31) checksum, which ethers rejects.
const USDRIF = getAddress("0x8dbf326e12a9ff37ed6ddf75ada548c2640a6482");
const EXPLORER = "https://explorer.testnet.rootstock.io";
const DEPLOY_FILE = new URL("../deploy/AgentJobERC20-USDRIF.json", import.meta.url).pathname;

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const flag = (k) => rest.includes(`--${k}`);
const RPC = opt("rpc", process.env.ROOTSTOCK_RPC || "https://public-node.testnet.rsk.co");
const LOCAL = /127\.0\.0\.1|localhost/.test(RPC);
const provider = new JsonRpcProvider(RPC, 31, { staticNetwork: true, cacheTimeout: -1 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ keys (never printed)
function loadKeys() {
  const dir = process.env.PREDGE_RSK_KEYS || join(homedir(), ".predge-rsk");
  const keys = {};
  const read = (f) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null);
  const dk = read("testnet-deployer.json"), rk = read("testnet-roles.json");
  if (dk?.privateKey) keys.deployer = dk.privateKey;
  for (const r of ["client", "provider", "reviewer"]) if (rk?.[r]?.privateKey) keys[r] = rk[r].privateKey;
  const envFile = new URL("../.env", import.meta.url).pathname;
  if (!keys.deployer && existsSync(envFile)) {
    const m = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m.exec(readFileSync(envFile, "utf8"));
    if (m) keys.deployer = m[1];
  }
  const wallets = {};
  for (const [r, k] of Object.entries(keys)) wallets[r] = new Wallet(k, provider);
  return wallets;
}
const W = loadKeys();
/** The wallet we hold for `address`, if any. */
const walletFor = (address) => Object.values(W).find((w) => w.address.toLowerCase() === String(address).toLowerCase());

// ------------------------------------------------------------------ contracts
const art = (name) => {
  const p = new URL(`../out/${name}.sol/${name}.json`, import.meta.url).pathname;
  if (!existsSync(p)) throw new Error(`missing ${p}: run \`forge build\` first`);
  return JSON.parse(readFileSync(p, "utf8"));
};
const ERC20_ABI = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function transfer(address,uint256) returns (bool)"];
function deployed() {
  const f = opt("deploy-file", DEPLOY_FILE);
  if (!existsSync(f)) throw new Error(`no ${f}: run \`node script/usdrif-job.mjs deploy\` first`);
  const d = JSON.parse(readFileSync(f, "utf8"));
  return { d, job: new Contract(d.agentJobERC20, art("AgentJobERC20").abi, provider), ev: new Contract(d.evaluator, art("PredgeNoObjectionEvaluator").abi, provider), token: new Contract(d.token, ERC20_ABI, provider) };
}

// ------------------------------------------------------------------ tx helpers (Rootstock: legacy type-0 only)
async function txo() { return { type: 0, gasPrice: (BigInt(await provider.send("eth_gasPrice", [])) * 12n) / 10n }; }
function guardWrite() {
  const net = provider._network?.chainId;
  if (!LOCAL && process.env.CONFIRM_TESTNET !== "rootstock-testnet") throw new Error("writes to the public testnet need CONFIRM_TESTNET=rootstock-testnet");
  return net;
}
async function waitTx(label, txp) {
  const tx = await txp;
  let rc = null;
  for (let i = 0; i < 120 && !rc; i++) { rc = await provider.getTransactionReceipt(tx.hash); if (!rc) await sleep(LOCAL ? 200 : 5000); }
  if (!rc || rc.status !== 1) throw new Error(`${label}: failed ${tx.hash}`);
  console.log(`ok  ${label.padEnd(40)} ${LOCAL ? tx.hash : `${EXPLORER}/tx/${tx.hash}`}`);
  return rc;
}
/** Send `data` to `to` from `from` if we hold that key; otherwise print the unsigned tx for the party's wallet. */
async function act(label, from, to, data) {
  const w = walletFor(from);
  if (!w) {
    console.log(`\n[${label}] must be signed by ${from} (not a key this script holds). Send from that wallet on Rootstock testnet (chainId 31):`);
    console.log(JSON.stringify({ from, to, value: "0", data }, null, 2));
    return null;
  }
  guardWrite();
  return waitTx(label, w.sendTransaction({ to, data, ...(await txo()) }));
}

// ------------------------------------------------------------------ evidence (only hashes go on-chain)
function loadEvidence() {
  const f = opt("evidence");
  if (!f) throw new Error("--evidence <file> required (make one with the `evidence` command)");
  const e = JSON.parse(readFileSync(f, "utf8"));
  return { checklistDocHash: e.checklistDocHash, itemHashes: e.itemHashes };
}
const manifestOf = (e) => AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32[]"], [e.checklistDocHash, e.itemHashes]);
const textHash = (label) => { const f = opt("file"); return f ? sha256(readFileSync(f)) : keccak256(toUtf8Bytes(opt("text") ?? (() => { throw new Error(`--text "..." or --file <path> required for the ${label}`); })())); };
const jobIdArg = () => { const j = opt("job"); if (!j) throw new Error("--job <id> required"); return BigInt(j); };

// ------------------------------------------------------------------ commands
const commands = {
  async deploy() {
    guardWrite();
    const dep = W.deployer ?? (() => { throw new Error("no deployer key (PREDGE_RSK_KEYS/testnet-deployer.json or PRIVATE_KEY in .env)"); })();
    const windowDays = Number(opt("window-days", 24)), objectionDays = Number(opt("objection-days", 10));
    const reviewer = getAddress(opt("reviewer", W.reviewer?.address ?? ""));
    const token = getAddress(opt("token", USDRIF));
    const bal = await provider.getBalance(dep.address);
    console.log(`deployer ${dep.address}  tRBTC ${formatUnits(bal, 18)}`);
    const o = await txo();
    const J = art("AgentJobERC20"), E = art("PredgeNoObjectionEvaluator");
    const jf = new ContractFactory(J.abi, J.bytecode.object, dep);
    const window = BigInt(windowDays * 86400), period = BigInt(objectionDays * 86400);
    const job = await jf.deploy(token, window, o);
    await waitTx("deploy AgentJobERC20", Promise.resolve(job.deploymentTransaction()));
    const jobAddr = await job.getAddress();
    const ef = new ContractFactory(E.abi, E.bytecode.object, dep);
    const ev = await ef.deploy(jobAddr, reviewer, period, o);
    await waitTx("deploy PredgeNoObjectionEvaluator", Promise.resolve(ev.deploymentTransaction()));
    const rec = { chainId: 31, token, tokenSymbol: await new Contract(token, ERC20_ABI, provider).symbol(), agentJobERC20: jobAddr, evaluator: await ev.getAddress(), reviewer,
      evaluationWindowSeconds: Number(window), objectionPeriodSeconds: Number(period), deployer: dep.address,
      deployTxs: { agentJobERC20: job.deploymentTransaction().hash, evaluator: ev.deploymentTransaction().hash }, deployedAt: new Date().toISOString(),
      compiler: "solc 0.8.26, optimizer 200 runs, evm cancun (foundry.toml)" };
    const out = opt("deploy-file", LOCAL ? DEPLOY_FILE.replace(/\.json$/, ".local.json") : DEPLOY_FILE);
    writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
    console.log(JSON.stringify(rec, null, 2));
  },

  async evidence() {
    const cl = opt("checklist"), list = opt("files"), out = opt("out");
    if (!cl || !list || !out) throw new Error("--checklist <file> --files a,b+c,... --out <file> required");
    const checklistDocHash = sha256(readFileSync(cl));
    const items = list.split(",").map((entry) => {
      const files = entry.split("+");
      const hs = files.map((f) => sha256(readFileSync(f)));
      return { files, fileSha256: hs, itemHash: hs.length === 1 ? hs[0] : sha256(concat(hs.map(getBytes))) };
    });
    const e = { checklist: cl, checklistDocHash, items, itemHashes: items.map((i) => i.itemHash), rule: "itemHash = sha256(file), or sha256(concat(sha256(file_i))) for several files per item" };
    e.manifestSha256 = sha256(manifestOf(e));
    writeFileSync(out, JSON.stringify(e, null, 2) + "\n");
    console.log(`wrote ${out}: ${items.length} items, manifest sha256 ${e.manifestSha256}`);
  },

  async create() {
    const { job, ev, token } = deployed();
    const client = getAddress(opt("client") ?? (() => { throw new Error("--client <address> required (in job 2 this is IBUKI: only the client can object)"); })());
    const prov = getAddress(opt("provider") ?? (() => { throw new Error("--provider <address> required"); })());
    const e = loadEvidence();
    const dec = await token.decimals();
    const amount = parseUnits(opt("amount") ?? (() => { throw new Error("--amount <USDRIF> required"); })(), dec);
    const spec = await ev.specHashFor(e.checklistDocHash, e.itemHashes.length);
    const expiry = (await provider.getBlock("latest")).timestamp + Math.round(Number(opt("expiry-days", 7)) * 86400);
    const bal = await token.balanceOf(client);
    console.log(`client ${client}  USDRIF ${formatUnits(bal, dec)}  escrow ${formatUnits(amount, dec)}  provider ${prov}  expiry ${new Date(expiry * 1000).toISOString()}`);
    if (bal < amount) console.log(`WARNING: client holds less USDRIF than the escrow; createJob will revert until it is funded.`);
    const target = await job.getAddress();
    if ((await token.allowance(client, target)) < amount) await act("1/2 approve USDRIF", client, await token.getAddress(), token.interface.encodeFunctionData("approve", [target, amount]));
    const rc = await act("2/2 createJob (escrow USDRIF)", client, target, job.interface.encodeFunctionData("createJob", [prov, await ev.getAddress(), spec, expiry, amount]));
    if (rc) {
      const log = rc.logs.map((l) => { try { return job.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "JobCreated");
      console.log(`jobId ${log.args.jobId}`);
    } else console.log(`\nAfter both txs confirm: node script/usdrif-job.mjs status --job <id>  (the id is in the JobCreated event / jobCount ${await job.jobCount()} + 1)`);
  },

  async submit() {
    const { job } = deployed();
    const id = jobIdArg(), e = loadEvidence(), m = manifestOf(e);
    const j = await job.getJob(id);
    await act("submit evidence manifest", j.provider, await job.getAddress(), job.interface.encodeFunctionData("submit", [id, sha256(m), m]));
  },

  async object() {
    const { job, ev } = deployed();
    const id = jobIdArg(), h = textHash("objection");
    const j = await job.getJob(id);
    console.log(`objection hash ${h} (keep the written objection: only its hash goes on-chain)`);
    await act("client object", j.client, await ev.getAddress(), ev.interface.encodeFunctionData("object", [id, h]));
  },

  async resolve() {
    const { ev } = deployed();
    const id = jobIdArg();
    if (flag("pay") === flag("refund")) throw new Error("pass exactly one of --pay / --refund");
    const h = textHash("decision");
    await act(`reviewer resolve (${flag("pay") ? "pay provider" : "refund client"})`, await ev.reviewer(), await ev.getAddress(), ev.interface.encodeFunctionData("resolve", [id, flag("pay"), h]));
  },

  async release() {
    const { ev } = deployed();
    const id = jobIdArg(), e = loadEvidence();
    const from = opt("from", W.deployer?.address);
    await act("releaseOnSilence", from, await ev.getAddress(), ev.interface.encodeFunctionData("releaseOnSilence", [id, e.checklistDocHash, e.itemHashes]));
  },

  async refund() {
    const { job } = deployed();
    const from = opt("from", W.deployer?.address);
    await act("claimRefund", from, await job.getAddress(), job.interface.encodeFunctionData("claimRefund", [jobIdArg()]));
  },

  async withdraw() {
    const { job, token } = deployed();
    const who = opt("as");
    const addr = opt("address") ?? W[who]?.address ?? (() => { throw new Error("--as client|provider (a held key) or --address <addr>"); })();
    const c = await job.credit(addr);
    console.log(`${addr} credit ${formatUnits(c, await token.decimals())} USDRIF`);
    const to = opt("to");
    await act("withdraw", addr, await job.getAddress(), to ? job.interface.encodeFunctionData("withdrawTo", [getAddress(to)]) : job.interface.encodeFunctionData("withdraw", []));
  },

  async status() {
    const { job, ev, token } = deployed();
    const id = jobIdArg();
    const j = await job.getJob(id), dec = await token.decimals();
    const now = (await provider.getBlock("latest")).timestamp;
    const d = await readJobDeadlines({ job, evaluator: ev, jobId: id, now, timeZone: opt("tz", "UTC") });
    const o = await ev.objectionOf(id);
    console.log(JSON.stringify({ jobId: id.toString(), contract: await job.getAddress(), evaluator: await ev.getAddress(), state: d.state, client: j.client, provider: j.provider,
      escrowUSDRIF: formatUnits(j.escrow, dec), objected: d.objected, objection: { hash: o.hash, resolved: o.resolved },
      credit: { client: formatUnits(await job.credit(j.client), dec), provider: formatUnits(await job.credit(j.provider), dec) },
      contractUSDRIF: formatUnits(await token.balanceOf(await job.getAddress()), dec),
      deadlines: d.deadlines.map(({ key, who, utc, local, secondsLeft, active }) => ({ key, who, utc, local, active, hoursLeft: +(secondsLeft / 3600).toFixed(1) })) }, null, 2));
  },

  // Full job-2 objection branch on a LOCAL anvil fork of Rootstock testnet, with test wallets and real USDRIF code.
  //   anvil --fork-url https://public-node.testnet.rsk.co --chain-id 31 --base-fee 0 &
  //   node script/usdrif-job.mjs e2e --rpc http://127.0.0.1:8545
  async e2e() {
    if (!LOCAL) throw new Error("e2e only runs against a local fork (--rpc http://127.0.0.1:8545)");
    for (const r of ["deployer", "client", "provider", "reviewer"]) if (!W[r]) throw new Error(`e2e needs the ${r} test key`);
    for (const w of Object.values(W)) await provider.send("anvil_setBalance", [w.address, "0x16345785D8A0000"]); // 0.1 tRBTC, fork only
    const holder = getAddress(opt("holder", "0xe38c86970543173d334b828485d8bc48d19ff701")); // a USDRIF holder on testnet, impersonated on the fork only
    await provider.send("anvil_impersonateAccount", [holder]);
    await provider.send("anvil_setBalance", [holder, "0x16345785D8A0000"]);
    const t = new Contract(USDRIF, ERC20_ABI, provider);
    const amt = parseUnits("10", 18);
    const s = await provider.getSigner(holder);
    await waitTx("fork: fund client with 10 USDRIF", t.connect(s).transfer(W.client.address, amt, { type: 0 }));
    const file = DEPLOY_FILE.replace(/\.json$/, ".local.json");
    rest.push("--deploy-file", file);
    await commands.deploy();
    const evFile = join(tmpdir(), "usdrif-e2e-evidence.json");
    const cl = new URL("../fixtures/rerise-b2b-checklist.v1.json", import.meta.url).pathname;
    const items = JSON.parse(readFileSync(cl, "utf8")).items;
    const e = { checklistDocHash: sha256(readFileSync(cl)), itemHashes: items.map((x) => sha256(toUtf8Bytes(`sample:${x}`))) };
    writeFileSync(evFile, JSON.stringify(e));
    const run = async (c, args) => { rest.length = 0; rest.push("--rpc", RPC, "--deploy-file", file, ...args); await commands[c](); };
    const before = await t.balanceOf(W.client.address);
    await run("create", ["--client", W.client.address, "--provider", W.provider.address, "--amount", "10", "--evidence", evFile]);
    await run("submit", ["--job", "1", "--evidence", evFile]);
    await run("object", ["--job", "1", "--text", "written objection (fork dry run)"]);
    try { await run("release", ["--job", "1", "--evidence", evFile]); throw new Error("release should be on hold"); } catch (err) { if (/should be on hold/.test(err.message)) throw err; console.log("ok  releaseOnSilence refused while on hold"); }
    await run("resolve", ["--job", "1", "--refund", "--text", "reviewer: refund (fork dry run)"]);
    await run("withdraw", ["--as", "client"]);
    await run("status", ["--job", "1"]);
    const after = await t.balanceOf(W.client.address);
    if (after !== before) throw new Error(`client USDRIF ${after} != ${before}`);
    console.log("PASS e2e: funding, objection, verdict (refund) and payout all in USDRIF on the fork");
  },
};

if (!commands[cmd]) {
  console.log("usage: node script/usdrif-job.mjs <deploy|evidence|create|submit|object|resolve|release|refund|withdraw|status|e2e> [options]  (see header)");
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
