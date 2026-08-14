// Predge on Rootstock — capital behind a verdict, denominated in BITCOIN.
//
// The bond contract accepts native value (msg.value). On Circle Arc that means USDC (Arc's
// USDC-gas chain). On Rootstock that means **rBTC** — Bitcoin brought over the 2-way peg,
// merge-mined and secured by ~80% of Bitcoin hashrate. So on Rootstock a "slashable bond
// behind an agent's verdict" is literally Bitcoin at risk. Nobody else in the x402 / ERC-8004
// space ships that: not aibtcdev, not stx402-agents, not x402-recourse-stacks, not any of the
// 5+ x402-on-Rootstock repos.
//
// Because the acceptance test is deterministic (sha256 over the delivered bytes), the slash
// is trustless — anyone submits the actual delivered bytes and the contract recomputes the
// hash on-chain. No arbiter, no DAO vote, no keeper signature. An honest verdict is
// unslashable; a dishonest one loses its Bitcoin stake to whoever proves it wrong.
//
// Run: node bond.mjs demo    (live on Rootstock testnet)

import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { Contract, keccak256, toUtf8Bytes, parseEther, formatEther } from "ethers";
import { env, makeProvider, makeSigner, withRetry, txLink, addressLink, EXPLORER } from "./lib/rsk.mjs";

const DEPLOYMENT = new URL("./deploy/PredgeValidatorBond.json", import.meta.url).pathname;
if (!existsSync(DEPLOYMENT)) {
  console.error("No deploy/PredgeValidatorBond.json — run `node script/deploy-bond.mjs` first.");
  process.exit(1);
}
const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));

const BOND_ABI = [
  "function stakeAndCommit(bytes32 requestHash, bytes32 expected) external payable",
  "function recordScore(bytes32 requestHash, uint8 score) external",
  "function challenge(bytes32 requestHash, bytes deliverable) external",
  "function reclaim(bytes32 requestHash) external",
  "function wouldSlash(bytes32 requestHash, bytes deliverable) view returns (bool)",
  "function slashCount() view returns (uint64)",
  "function totalBonded() view returns (uint96)",
  "function disputeWindow() view returns (uint64)",
  "event Slashed(bytes32 indexed requestHash, address indexed challenger, uint96 bond, uint8 recordedScore, bytes32 deliveredHash)",
  "error NotValidator()","error ZeroHash()","error ZeroBond()","error AlreadyCommitted()","error NotCommitted()",
  "error AlreadyScored()","error NotScored()","error Closed()","error BadScore()","error VerdictHonest()","error WindowOpen()","error TransferFailed()",
];

const sha256hex = (b) => "0x" + crypto.createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function revertName(e) {
  if (e?.revert?.name) return e.revert.name;
  const s = (e?.shortMessage || e?.message || "") + " " + (e?.info?.error?.message || "");
  const m = /(VerdictHonest|NotScored|NotCommitted|AlreadyScored|Closed|WindowOpen|BadScore|ZeroBond)/.exec(s);
  return m ? m[1] : (e?.shortMessage || "reverted");
}

const e = env();
const provider = makeProvider(e.ROOTSTOCK_RPC);
const wallet = await makeSigner(e.PRIVATE_KEY, provider);
const contract = new Contract(dep.address, BOND_ABI, wallet);

async function cmdDemo() {
  const window = await withRetry("disputeWindow", () => contract.disputeWindow());
  const bond = parseEther("0.0001"); // 0.0001 tRBTC — Bitcoin at risk, not stablecoin at risk
  const stamp = Date.now();
  console.log(`Predge on Rootstock testnet — capital behind a verdict, denominated in BITCOIN (rBTC)`);
  console.log(`  PredgeValidatorBond   ${addressLink(dep.address)}`);
  console.log(`  disputeWindow ${window}s · bond ${formatEther(bond)} tRBTC per verdict\n`);

  // ── Job A — honest verdict, unslashable ──────────────────────────────────
  const reqA = keccak256(toUtf8Bytes(`bond-A-${stamp}`));
  const wantA = Buffer.from("extract-large-trades -> 4213 rows");
  const expA = sha256hex(wantA);
  console.log("[1/5] validator STAKES BITCOIN (rBTC) and commits the deterministic test (Job A, honest)");
  let tx = await withRetry("stakeAndCommit", () => contract.stakeAndCommit(reqA, expA, { value: bond }));
  await withRetry("wait", () => tx.wait());
  console.log(`      staked ${formatEther(bond)} tRBTC + committed expected  ${txLink(tx.hash)}`);
  tx = await withRetry("recordScore", () => contract.recordScore(reqA, 100));
  await withRetry("wait", () => tx.wait());
  console.log("      recorded verdict DELIVERED (score 100) — the claim the bond backs\n");

  console.log("[2/5] the verdict is HONEST (bytes really match) → a challenge cannot take the bond");
  console.log("      wouldSlash(correct bytes):", await withRetry("wouldSlash", () => contract.wouldSlash(reqA, wantA)));
  try {
    await contract.challenge.staticCall(reqA, wantA);
    console.log("      UNEXPECTED: challenge did not revert");
  } catch (err) {
    console.log("      challenge reverts:", revertName(err), "— you cannot grief an honest validator\n");
  }

  console.log("[3/5] after the dispute window with no successful challenge, the validator reclaims");
  await sleep(Number(window) * 1000 + 1500);
  tx = await withRetry("reclaim", () => contract.reclaim(reqA));
  await withRetry("wait", () => tx.wait());
  console.log(`      reclaimed ${formatEther(bond)} tRBTC  ${txLink(tx.hash)}\n`);

  // ── Job B — a lie, slashed on-chain ──────────────────────────────────────
  const reqB = keccak256(toUtf8Bytes(`bond-B-${stamp}`));
  const wantB = Buffer.from("audited Q2 revenue: 1,284,300 USDC");
  const expB = sha256hex(wantB);
  const garbage = Buffer.from("lol here is a random number 42");
  console.log("[4/5] validator stakes BITCOIN, but LIES: claims DELIVERED while real bytes are garbage");
  tx = await withRetry("stakeAndCommit", () => contract.stakeAndCommit(reqB, expB, { value: bond }));
  await withRetry("wait", () => tx.wait());
  tx = await withRetry("recordScore", () => contract.recordScore(reqB, 100));
  await withRetry("wait", () => tx.wait());
  console.log(`      staked ${formatEther(bond)} tRBTC, recorded DELIVERED (the lie)  ${txLink(tx.hash)}`);
  console.log("      wouldSlash(the garbage actually delivered):", await withRetry("wouldSlash", () => contract.wouldSlash(reqB, garbage)));

  console.log("\n[5/5] anyone submits the garbage → contract recomputes sha256 → BITCOIN BOND SLASHED to challenger");
  const totalBefore = await withRetry("totalBonded", () => contract.totalBonded());
  tx = await withRetry("challenge", () => contract.challenge(reqB, garbage));
  await withRetry("wait", () => tx.wait());
  const totalAfter = await withRetry("totalBonded", () => contract.totalBonded());
  console.log(`      slash tx     ${txLink(tx.hash)}`);
  console.log(`      Bitcoin at risk ${formatEther(totalBefore)} → ${formatEther(totalAfter)} tRBTC (the lie cost the validator its BTC stake)`);
  const slashes = await withRetry("slashCount", () => contract.slashCount());
  console.log(`      total slashes on this contract: ${slashes}`);
  console.log("      (demo: one operator plays validator+challenger; in production the challenger is anyone)\n");

  console.log("this is what nobody else in the x402/ERC-8004 space ships on a Bitcoin sidechain:");
  console.log("Bitcoin-collateralized, trustlessly-slashable, commit-before-outcome verdict.");
  console.log(EXPLORER + "/address/" + dep.address);
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const [cmd] = process.argv.slice(2);
  if (cmd === "demo") await cmdDemo();
  else console.log("Predge on Rootstock — Bitcoin-collateralized verdict bond\n\n  node bond.mjs demo    stake rBTC → honest survives → lie slashed, live on Rootstock testnet");
}
