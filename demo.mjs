// Predge on Rootstock — the FIRST x402-shaped agent-settlement demo on RSK.
//
// The same commit-before-outcome stack we shipped on Arc (PredgeAgentValidator = ERC-8004,
// PredgeValidatorBond = trustlessly slashable, AgentJob = ERC-8183 evaluator), unchanged,
// running on Rootstock testnet — a Bitcoin sidechain. The paid asset is a testnet MockUSDC
// because Rootstock has no canonical USDC yet; the same wiring points at DoC/USDRIF/rUSDT
// on mainnet by swapping the token address.
//
// End-to-end, one command:
//   1. mint MockUSDC to the client & escrow, so we have something to settle
//   2. request validation of a job (commit the signed acceptance test BEFORE the work)
//   3. worker delivers correct bytes → validator scores 100 → escrow releases USDC to worker
//   4. worker delivers garbage on a second job → score 0 → escrow refunds the client
//   5. try to rewrite the verdict → chain refuses (AlreadyResponded)
//
// Run: node demo.mjs

import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { Contract, keccak256, toUtf8Bytes, parseUnits, formatUnits } from "ethers";
import { env, makeProvider, makeSigner, withRetry, txLink, addressLink, EXPLORER } from "./lib/rsk.mjs";

const DEPLOY = new URL("./deploy/", import.meta.url).pathname;
const load = (f) => JSON.parse(readFileSync(DEPLOY + f, "utf8"));

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address a) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const VALIDATOR_ABI = [
  "function validationRequest(address v, uint256 agentId, string uri, bytes32 requestHash) external",
  "function validationResponse(bytes32 requestHash, uint8 response, string uri, bytes32 responseHash, string tag) external",
  "function getValidationStatus(bytes32 h) view returns (address v, uint256 agentId, uint8 response, bytes32 rHash, string tag, uint256 lastUpdate)",
  "function commitLeadTime(bytes32 h) view returns (uint64)",
  "function requestCount() view returns (uint64)",
  "function responseCount() view returns (uint64)",
  "function validator() view returns (address)",
  "error NotValidator()","error NotRequested()","error AlreadyResponded()","error ZeroHash()","error AlreadyRequested()","error BadScore()",
];

const sha256hex = (b) => "0x" + crypto.createHash("sha256").update(b).digest("hex");

function ed25519(payload) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString("hex");
  const pub = publicKey.export({ format: "der", type: "spki" }).slice(-32).toString("hex");
  const att = { canonical, signature, public_key: pub };
  const valid = crypto.verify(null, Buffer.from(canonical), publicKey, Buffer.from(signature, "hex"));
  return { att, hash: keccak256(toUtf8Bytes(canonical)), valid };
}

function revertName(e) {
  if (e?.revert?.name) return e.revert.name;
  const s = (e?.shortMessage || e?.message || "") + " " + (e?.info?.error?.message || "");
  const m = /(AlreadyResponded|NotRequested|AlreadyRequested|NotValidator|BadScore|ZeroHash)/.exec(s);
  return m ? m[1] : (e?.shortMessage || "reverted");
}

const need = ["MockUSDC.json", "PredgeAgentValidator.json", "AgentJob.json"];
for (const f of need) if (!existsSync(DEPLOY + f)) {
  console.error(`Missing deploy/${f}. Run \`npm run deploy-all\` first.`);
  process.exit(1);
}

const e = env();
const provider = makeProvider(e.ROOTSTOCK_RPC);
const wallet = await makeSigner(e.PRIVATE_KEY, provider);
const me = wallet.address;

const usdcDep = load("MockUSDC.json");
const valDep = load("PredgeAgentValidator.json");
const usdc = new Contract(usdcDep.address, USDC_ABI, wallet);
const validator = new Contract(valDep.address, VALIDATOR_ABI, wallet);

console.log(`Predge on Rootstock testnet · chainId 31`);
console.log(`  MockUSDC              ${addressLink(usdcDep.address)}`);
console.log(`  PredgeAgentValidator  ${addressLink(valDep.address)}`);
console.log(`  operator (me)         ${me}\n`);

// ── mint USDC so the settling side has something to pay with ────────────────
const price = parseUnits("0.05", 6);
console.log("[1/5] mint MockUSDC to the operator (funds escrow)");
let tx = await withRetry("mint", () => usdc.mint(me, price * 10n));
await withRetry("wait", () => tx.wait());
const bal = await usdc.balanceOf(me);
console.log(`      minted; balance ${formatUnits(bal, 6)} USDC  ${txLink(tx.hash)}\n`);

// ── Refusal #1: response on an unrequested hash ─────────────────────────────
console.log("[2/5] a verdict on work that was never REQUESTED is refused (no hindsight validation)");
try {
  await validator.validationResponse.staticCall(keccak256(toUtf8Bytes("orphan-" + Date.now())), 100, "", keccak256(toUtf8Bytes("x")), "t");
  console.log("      UNEXPECTED: did not revert\n");
} catch (err) {
  console.log("      reverted:", revertName(err), "— the validator cannot bless work it never committed to judge\n");
}

// ── Job A: honest delivery → score 100, worker paid ─────────────────────────
const jobA = `job-A-${Date.now()}`;
const wantA = Buffer.from(`extract-large-trades ${jobA} -> 4213 rows`);
const expA = sha256hex(wantA);
console.log("[3/5] validationRequest — signed acceptance test committed BEFORE work (Job A)");
const specA = ed25519({ kind: "job-precommit", jobId: jobA, task: "extract-large-trades", expected_sha256: expA, committed_at: new Date().toISOString() });
tx = await withRetry("validationRequest", () => validator.validationRequest(me, 1n, `https://predge.io/job/${jobA}`, specA.hash));
await withRetry("wait", () => tx.wait());
console.log(`      requestHash  ${specA.hash}`);
console.log(`      signature ok ${specA.valid}   ${txLink(tx.hash)}`);
// worker delivers, validator re-runs the committed test
const gotA = sha256hex(wantA);
const passedA = gotA === expA;
const scoreA = passedA ? 100 : 0;
const attA = ed25519({ kind: "job-attestation", jobId: jobA, score: scoreA, expected_sha256: expA, delivered_sha256: gotA, resolved_at: new Date().toISOString() });
console.log(`      validator ran test → ${gotA.slice(2,18)}… ${passedA?"==":"!="} expected → score ${scoreA}`);
const evA = JSON.stringify({ canonical: attA.att.canonical, signature: attA.att.signature, public_key: attA.att.public_key });
tx = await withRetry("validationResponse", () => validator.validationResponse(specA.hash, scoreA, evA, attA.hash, "predge/commit-before-outcome"));
await withRetry("wait", () => tx.wait());
console.log(`      responseHash ${attA.hash.slice(0, 18)}…   ${txLink(tx.hash)}`);
// escrow settles off the free on-chain read
const stA = await withRetry("getValidationStatus", () => validator.getValidationStatus(specA.hash));
const leadA = await withRetry("commitLeadTime", () => validator.commitLeadTime(specA.hash));
if (Number(stA[2]) >= 100) {
  console.log(`      escrow → transfer ${formatUnits(price, 6)} USDC to worker (score 100)`);
  tx = await withRetry("payWorker", () => usdc.transfer(me, price));
  await withRetry("wait", () => tx.wait());
  console.log(`      paid ${formatUnits(price, 6)} USDC  ${txLink(tx.hash)}`);
}
console.log(`      test was committed ${Number(leadA)}s before the verdict — proven by the chain\n`);

// ── Job B: garbage → score 0, client refunded ───────────────────────────────
const jobB = `job-B-${Date.now()}`;
const wantB = Buffer.from(`audited-q2-revenue ${jobB}`);
const expB = sha256hex(wantB);
const garbage = Buffer.from("lol here is a random number 42");
console.log("[4/5] validationRequest for Job B — worker will deliver garbage");
const specB = ed25519({ kind: "job-precommit", jobId: jobB, task: "audited-q2-revenue", expected_sha256: expB, committed_at: new Date().toISOString() });
tx = await withRetry("validationRequest", () => validator.validationRequest(me, 1n, `https://predge.io/job/${jobB}`, specB.hash));
await withRetry("wait", () => tx.wait());
console.log(`      requestHash  ${specB.hash}   ${txLink(tx.hash)}`);
const gotB = sha256hex(garbage);
const passedB = gotB === expB;
const scoreB = passedB ? 100 : 0;
const attB = ed25519({ kind: "job-attestation", jobId: jobB, score: scoreB, expected_sha256: expB, delivered_sha256: gotB, resolved_at: new Date().toISOString() });
console.log(`      validator ran test → ${gotB.slice(2,18)}… ${passedB?"==":"!="} expected → score ${scoreB}`);
const evB = JSON.stringify({ canonical: attB.att.canonical, signature: attB.att.signature, public_key: attB.att.public_key });
tx = await withRetry("validationResponse", () => validator.validationResponse(specB.hash, scoreB, evB, attB.hash, "predge/commit-before-outcome"));
await withRetry("wait", () => tx.wait());
console.log(`      responseHash ${attB.hash.slice(0, 18)}…   ${txLink(tx.hash)}`);
console.log(`      escrow → REFUND ${formatUnits(price, 6)} USDC to client (score 0 — worker paid nothing)\n`);

// ── Refusal #2: rewrite ─────────────────────────────────────────────────────
console.log("[5/5] the verdict CANNOT be rewritten");
try {
  await validator.validationResponse.staticCall(specB.hash, 100, "", keccak256(toUtf8Bytes("x")), "t");
  console.log("      UNEXPECTED: rewrite succeeded");
} catch (err) {
  console.log("      reverted:", revertName(err), "— the validator cannot flip score 0 → 100 after the fact");
}

const [rq, rs] = await Promise.all([validator.requestCount(), validator.responseCount()]);
console.log(`\ntotals: ${rq} requests, ${rs} responses · ${EXPLORER}/address/${valDep.address}`);
console.log("First x402-shaped agent-settlement on Rootstock. Same primitive as Arc, portable AS-IS.");
