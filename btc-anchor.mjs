// btc-anchor.mjs — post a Predge merkle root as an OP_RETURN transaction on Bitcoin
// TESTNET, then record the resulting Bitcoin txid on Rootstock via VerdictAnchor.
//
// Flow, in order:
//   1. Read our Rootstock VerdictAnchor and find the most recent unrooted-to-BTC batch
//      (or take an explicit --batch <id>).
//   2. Build a Bitcoin TX: spend one of our confirmed UTXOs (P2WPKH), add an OP_RETURN
//      output carrying the 32-byte merkle root, send change back to ourselves.
//   3. Sign locally with @noble/secp256k1.
//   4. Broadcast via mempool.space testnet API — free, no key needed.
//   5. Wait for a block to include it, get {txid, block_height, block_time}.
//   6. Call VerdictAnchor.recordBtcAnchor(batchId, txid, blockHeight, blockTime) on Rootstock.
//
// After this runs once, altering a Predge verdict later requires rewriting a Bitcoin block —
// which is the "Bitcoin-final" claim, backed by an actual on-chain fact instead of a promise.
//
// Usage:
//   node btc-anchor.mjs                            anchor the latest un-anchored batch
//   node btc-anchor.mjs --batch 1                  anchor a specific batch id
//   node btc-anchor.mjs --dry-run --batch 1        build + print, don't broadcast

import { readFileSync, existsSync } from "node:fs";
import crypto from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import * as noble from "@noble/secp256k1";
import { Contract } from "ethers";
import { env, makeProvider, makeSigner, withRetry, txLink, addressLink } from "./lib/rsk.mjs";

// bitcoinjs-lib v6 requires a full ECC provider; @bitcoinerlab/secp256k1 is the canonical
// pure-JS one that passes its strict initEccLib validation. We keep @noble/secp256k1 as well
// for raw preimage signing when we need direct control (e.g. building the witness by hand).
bitcoin.initEccLib(ecc);

const NETWORK = bitcoin.networks.testnet;
const MEMPOOL_BASE = "https://mempool.space/testnet/api";

const DEPLOY = new URL("./deploy/", import.meta.url).pathname;
const ANCHOR_ABI = [
  "function commitRoot(bytes32 merkleRoot, uint32 count) external returns (uint64 batchId)",
  "function recordBtcAnchor(uint64 batchId, bytes32 btcTxid, uint32 btcBlockHeight, uint64 btcAnchoredAt) external",
  "function batchOf(uint64) view returns (bytes32 merkleRoot, uint32 count, uint64 rskCommittedAt, uint64 btcAnchoredAt, bytes32 btcTxid, uint32 btcBlockHeight)",
  "function totalBatches() view returns (uint64)",
];

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const batchArgIdx = args.indexOf("--batch");
const explicitBatch = batchArgIdx >= 0 ? BigInt(args[batchArgIdx + 1]) : null;

// ── read BTC key ────────────────────────────────────────────────────────────
const btcEnvPath = new URL("./.env.btc", import.meta.url).pathname;
if (!existsSync(btcEnvPath)) {
  console.error("No .env.btc — run `node script/btc-genwallet.mjs` first.");
  process.exit(1);
}
const btcEnv = Object.fromEntries(
  readFileSync(btcEnvPath, "utf8").split("\n")
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]])
);
const priv = Buffer.from(btcEnv.BTC_PRIVKEY, "hex");
const pub = Buffer.from(btcEnv.BTC_PUBKEY, "hex");
const address = btcEnv.BTC_ADDRESS;

// ── connect to Rootstock, find batch to anchor ──────────────────────────────
const e = env();
const dep = JSON.parse(readFileSync(DEPLOY + "VerdictAnchor.json", "utf8"));
const provider = makeProvider(e.ROOTSTOCK_RPC);
const wallet = await makeSigner(e.PRIVATE_KEY, provider);
const anchor = new Contract(dep.address, ANCHOR_ABI, wallet);

console.log(`Predge BTC anchor — ${addressLink(dep.address)}`);
console.log(`  BTC (testnet) address: ${address}`);
console.log("");

async function findBatchToAnchor() {
  if (explicitBatch !== null) return explicitBatch;
  const total = await anchor.totalBatches();
  for (let id = total; id > 0n; id--) {
    const b = await anchor.batchOf(id);
    if (b[4] === "0x0000000000000000000000000000000000000000000000000000000000000000") return id;
  }
  return null;
}

const batchId = await findBatchToAnchor();
if (batchId === null) {
  console.error("No un-anchored batch found. Run `node anchor.mjs demo` to create one first.");
  process.exit(1);
}
const batch = await anchor.batchOf(batchId);
const merkleRoot = batch[0];
const count = Number(batch[1]);
console.log(`[1/6] batch to anchor: id=${batchId}  root=${merkleRoot}  count=${count}`);

// ── fetch UTXOs from mempool.space ──────────────────────────────────────────
async function api(path) {
  const r = await fetch(MEMPOOL_BASE + path);
  if (!r.ok) throw new Error(`mempool.space ${path} → ${r.status} ${await r.text()}`);
  return r.text();
}

console.log(`[2/6] fetching UTXOs for ${address}`);
const utxos = JSON.parse(await api(`/address/${address}/utxo`));
if (utxos.length === 0) {
  console.error(`\nNo UTXOs for ${address}. Fund the address at:`);
  console.error(`  https://bitcoinfaucet.uo1.net/  (fastest, no captcha)`);
  console.error(`  https://coinfaucet.eu/en/btc-testnet/  (backup)`);
  console.error(`  Any amount ≥ ~2000 sats works. Wait for one confirmation, then re-run.`);
  process.exit(1);
}
const confirmed = utxos.filter((u) => u.status?.confirmed);
if (confirmed.length === 0) {
  console.error(`Have ${utxos.length} unconfirmed UTXO(s). Wait for one confirmation, then re-run.`);
  process.exit(1);
}
// biggest confirmed UTXO — simplest input policy
const utxo = confirmed.sort((a, b) => b.value - a.value)[0];
console.log(`      using UTXO ${utxo.txid}:${utxo.vout} · ${utxo.value} sats`);

// ── estimate fee from mempool.space, size the tx (fallback to 1 sat/vB for testnet) ─
let feeRate = 1;
try {
  const fees = JSON.parse(await api("/v1/fees/recommended"));
  feeRate = Math.max(fees.economyFee || 1, 1); // sats/vB, minimum 1
} catch (e) {
  console.log(`      fees API unavailable (${e?.message?.slice(0, 60) || e}); falling back to 1 sat/vB (testnet-safe)`);
}
// A P2WPKH input + 2 outputs (OP_RETURN + change) is ~150 vB.
const estimatedVBytes = 150;
const fee = feeRate * estimatedVBytes;
const change = utxo.value - fee;
if (change < 546) throw new Error(`UTXO too small (${utxo.value} sats) for fee ${fee} + dust threshold`);
console.log(`[3/6] fee ${fee} sats (${feeRate} sat/vB × ~${estimatedVBytes} vB), change ${change} sats`);

// ── build the transaction with PSBT ─────────────────────────────────────────
const rawInputTxHex = await api(`/tx/${utxo.txid}/hex`);
const rawInputTx = Buffer.from(rawInputTxHex, "hex");
const psbt = new bitcoin.Psbt({ network: NETWORK });
psbt.addInput({
  hash: utxo.txid,
  index: utxo.vout,
  witnessUtxo: {
    script: bitcoin.address.toOutputScript(address, NETWORK),
    value: utxo.value,
  },
  nonWitnessUtxo: rawInputTx,
});
// OP_RETURN with our 32-byte merkle root
const opReturnScript = bitcoin.script.compile([
  bitcoin.opcodes.OP_RETURN,
  Buffer.from(merkleRoot.slice(2), "hex"),
]);
psbt.addOutput({ script: opReturnScript, value: 0 });
psbt.addOutput({ address, value: change });

// ── sign with a bitcoinSigner-shaped object over @bitcoinerlab/secp256k1 ────
const signer = {
  publicKey: pub,
  sign: (hash) => Buffer.from(ecc.sign(hash, priv)),
};
psbt.signInput(0, signer);
psbt.finalizeAllInputs();
const rawTxHex = psbt.extractTransaction().toHex();
const txid = psbt.extractTransaction().getId();
console.log(`[4/6] signed tx · txid ${txid}`);
console.log(`      raw hex: ${rawTxHex.slice(0, 60)}…${rawTxHex.slice(-20)}  (${rawTxHex.length / 2} bytes)`);

if (DRY) {
  console.log("\n--dry-run: NOT broadcasting. Above is what would have been sent.");
  process.exit(0);
}

// ── broadcast ───────────────────────────────────────────────────────────────
console.log("[5/6] broadcasting to mempool.space/testnet");
const broadcastRes = await fetch(MEMPOOL_BASE + "/tx", { method: "POST", body: rawTxHex });
const broadcastBody = await broadcastRes.text();
if (!broadcastRes.ok) throw new Error(`broadcast failed: ${broadcastRes.status} ${broadcastBody}`);
const broadcastTxid = broadcastBody.trim();
console.log(`      broadcast ok · https://mempool.space/testnet/tx/${broadcastTxid}`);

// ── wait for confirmation ───────────────────────────────────────────────────
console.log(`[6/6] waiting for block confirmation (testnet block time ~10min, be patient)`);
let confirmedAt, blockHeight;
for (let i = 0; i < 60; i++) { // up to ~60 min
  await new Promise((r) => setTimeout(r, 60_000));
  const st = await fetch(MEMPOOL_BASE + `/tx/${broadcastTxid}/status`);
  if (!st.ok) continue;
  const s = await st.json();
  if (s.confirmed) { confirmedAt = s.block_time; blockHeight = s.block_height; break; }
  console.log(`      still unconfirmed (poll ${i + 1}/60)…`);
}
if (!confirmedAt) {
  console.error("      not confirmed after ~60 min. Re-run without --batch once confirmed to record it.");
  process.exit(1);
}
console.log(`      confirmed in block ${blockHeight} at ${new Date(confirmedAt * 1000).toISOString()}`);

// ── record on Rootstock ─────────────────────────────────────────────────────
console.log("[7/7] recording Bitcoin anchor on Rootstock VerdictAnchor");
const btcTxidBytes32 = "0x" + broadcastTxid;
const tx = await withRetry("recordBtcAnchor", () =>
  anchor.recordBtcAnchor(batchId, btcTxidBytes32, blockHeight, confirmedAt)
);
await withRetry("wait", () => tx.wait());
console.log(`      recorded · ${txLink(tx.hash)}`);
console.log("");
console.log("ANCHOR COMPLETE.");
console.log(`  batchId          ${batchId}`);
console.log(`  merkleRoot       ${merkleRoot}`);
console.log(`  Bitcoin txid     https://mempool.space/testnet/tx/${broadcastTxid}`);
console.log(`  Bitcoin block    ${blockHeight}`);
console.log(`  Rootstock record ${txLink(tx.hash)}`);
console.log("");
console.log("altering any verdict in this batch now requires rewriting Bitcoin block", blockHeight);
