// Local fork of Rootstock testnet for testing the pilot pages end to end (no testnet writes, no real keys).
//   anvil --fork-url https://public-node.testnet.rsk.co --chain-id 31 --base-fee 0 &
//   node script/pilot-fork.mjs setup            # fresh AgentJobERC20 + PredgeNoObjectionEvaluator on the fork,
//                                               # reviewer = anvil dev account #3, client #1 gets 200 USDRIF
//   node script/pilot-fork.mjs warp --days 11   # move fork time forward (objection period, deadlines)
//   node script/pilot-fork.mjs balances
// Roles = anvil's public dev accounts: #1 client, #2 contractor, #3 reviewer (#0 deploys). Pages use them with
// ?devwallet=<n> on localhost (app/dev-wallet.js), which lets anvil sign; no private key is handled here.
import { JsonRpcProvider, ContractFactory, Contract, getAddress, parseUnits, formatUnits } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const RPC = opt("rpc", "http://127.0.0.1:8545");
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error("local fork only");
const provider = new JsonRpcProvider(RPC, 31, { staticNetwork: true, cacheTimeout: -1 });
const USDRIF = getAddress("0x8dbf326e12a9ff37ed6ddf75ada548c2640a6482");
const HOLDER = getAddress(opt("holder", "0xe38c86970543173d334b828485d8bc48d19ff701")); // USDRIF holder on testnet, impersonated on the fork only
const OUT = new URL("../deploy/pilot.local.json", import.meta.url).pathname;
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];
const art = (n) => JSON.parse(readFileSync(new URL(`../out/${n}.sol/${n}.json`, import.meta.url), "utf8"));

const accounts = async () => (await provider.send("eth_accounts", [])).map((a) => getAddress(a));

const commands = {
  async setup() {
    const [dep, client, contractor, reviewer] = await accounts();
    const s = await provider.getSigner(dep);
    const o = { type: 0, gasPrice: BigInt(await provider.send("eth_gasPrice", [])) };
    const J = art("AgentJobERC20"), E = art("PredgeNoObjectionEvaluator");
    const window = BigInt(Number(opt("window-days", 24)) * 86400), period = BigInt(Number(opt("objection-days", 10)) * 86400);
    const job = await new ContractFactory(J.abi, J.bytecode.object, s).deploy(USDRIF, window, o);
    await job.waitForDeployment();
    const ev = await new ContractFactory(E.abi, E.bytecode.object, s).deploy(await job.getAddress(), reviewer, period, o);
    await ev.waitForDeployment();
    await provider.send("anvil_impersonateAccount", [HOLDER]);
    await provider.send("anvil_setBalance", [HOLDER, "0x16345785D8A0000"]);
    const t = new Contract(USDRIF, ERC20, await provider.getSigner(HOLDER));
    const amt = parseUnits(opt("usdrif", "200"), 18);
    await (await t.transfer(client, amt, { type: 0, gasPrice: o.gasPrice })).wait();
    await provider.send("anvil_stopImpersonatingAccount", [HOLDER]);
    const rec = { rpc: RPC, escrow: await job.getAddress(), evaluator: await ev.getAddress(), token: USDRIF, roles: { deployer: dep, client, contractor, reviewer }, objectionDays: Number(period) / 86400, windowDays: Number(window) / 86400 };
    writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
    console.log(JSON.stringify(rec, null, 2));
    console.log(`\npages: http://localhost:8787/job2.html?rpc=${encodeURIComponent(RPC)}&escrow=${rec.escrow}&evaluator=${rec.evaluator}&devwallet=1`);
  },
  async warp() {
    const s = Math.round(Number(opt("days", 1)) * 86400);
    await provider.send("evm_increaseTime", [s]);
    await provider.send("evm_mine", []);
    const b = await provider.getBlock("latest");
    console.log(`fork time now ${new Date(b.timestamp * 1000).toISOString()} (+${s / 86400} d)`);
  },
  async balances() {
    const d = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
    const t = new Contract(USDRIF, ERC20, provider);
    for (const [r, a] of Object.entries(d?.roles || {})) console.log(r.padEnd(11), a, formatUnits(await t.balanceOf(a), 18), "USDRIF");
  },
};
if (!commands[cmd]) { console.log("usage: node script/pilot-fork.mjs setup|warp --days N|balances"); process.exit(1); }
await commands[cmd]();
