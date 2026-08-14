// Predge daily anchor batcher.
//
// End of day: scan the validator for every ValidationResponse; canonicalize each verdict as
// `sha256(requestHash | responseHash | uint8 score | tag)`; build a binary merkle root; commit
// that root on Rootstock via VerdictAnchor; and — separately — post the same 32 bytes as an
// OP_RETURN on Bitcoin L1 (out of scope for this file; the txid comes back here via
// `recordBtcAnchor`). Result: a Predge verdict cannot be silently altered without also altering
// a Bitcoin block.
//
// Merkle scheme is intentionally simple: pair-hash with sha256, duplicate the last leaf on odd
// counts, iterate until one root remains. Inclusion proofs are logN sibling hashes + a bit-path.
//
//   node anchor.mjs demo     seed 4 sample verdicts, commit a root, print an inclusion proof
//   node anchor.mjs commit   scan the deployed validator (all requests), commit today's root
//   node anchor.mjs record <batchId> <btcTxid> <btcBlockHeight> <btcAnchoredAt>

import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { Contract, keccak256, toUtf8Bytes } from "ethers";
import { env, makeProvider, makeSigner, withRetry, txLink, addressLink, EXPLORER } from "./lib/rsk.mjs";

const DEPLOY = new URL("./deploy/", import.meta.url).pathname;
const load = (f) => JSON.parse(readFileSync(DEPLOY + f, "utf8"));

const ANCHOR_ABI = [
  "function commitRoot(bytes32 merkleRoot, uint32 count) external returns (uint64 batchId)",
  "function recordBtcAnchor(uint64 batchId, bytes32 btcTxid, uint32 btcBlockHeight, uint64 btcAnchoredAt) external",
  "function batchOf(uint64) view returns (bytes32 merkleRoot, uint32 count, uint64 rskCommittedAt, uint64 btcAnchoredAt, bytes32 btcTxid, uint32 btcBlockHeight)",
  "function totalBatches() view returns (uint64)",
  "event RootCommitted(uint64 indexed batchId, bytes32 indexed merkleRoot, uint32 count, uint64 rskCommittedAt)",
];
const VAL_ABI = [
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
];

// sha256 leaf: the exact 32 bytes we'll want to (a) commit as a batch and (b) post to OP_RETURN
export function leafOf({ requestHash, responseHash, score, tag }) {
  const buf = Buffer.concat([
    Buffer.from(requestHash.slice(2), "hex"),
    Buffer.from(responseHash.slice(2), "hex"),
    Buffer.from([score & 0xff]),
    Buffer.from(tag || "", "utf8"),
  ]);
  return "0x" + crypto.createHash("sha256").update(buf).digest("hex");
}

// pair-hash, duplicate-last on odd — the least surprising sha256 merkle
export function merkleRoot(leavesHex) {
  if (leavesHex.length === 0) throw new Error("empty batch");
  let layer = leavesHex.map((h) => Buffer.from(h.slice(2), "hex"));
  while (layer.length > 1) {
    if (layer.length % 2 === 1) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(crypto.createHash("sha256").update(Buffer.concat([layer[i], layer[i + 1]])).digest());
    }
    layer = next;
  }
  return "0x" + layer[0].toString("hex");
}

export function inclusionProof(leavesHex, index) {
  const path = [];
  let idx = index;
  let layer = leavesHex.map((h) => Buffer.from(h.slice(2), "hex"));
  while (layer.length > 1) {
    if (layer.length % 2 === 1) layer.push(layer[layer.length - 1]);
    const sibling = idx % 2 === 0 ? layer[idx + 1] : layer[idx - 1];
    path.push({ hash: "0x" + sibling.toString("hex"), isRight: idx % 2 === 0 });
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(crypto.createHash("sha256").update(Buffer.concat([layer[i], layer[i + 1]])).digest());
    }
    layer = next;
    idx = Math.floor(idx / 2);
  }
  return path;
}

export function verifyProof(leafHex, proof, rootHex) {
  let acc = Buffer.from(leafHex.slice(2), "hex");
  for (const step of proof) {
    const sib = Buffer.from(step.hash.slice(2), "hex");
    const [l, r] = step.isRight ? [acc, sib] : [sib, acc];
    acc = crypto.createHash("sha256").update(Buffer.concat([l, r])).digest();
  }
  return "0x" + acc.toString("hex") === rootHex;
}

function connect() {
  const e = env();
  if (!existsSync(DEPLOY + "VerdictAnchor.json")) {
    console.error("No deploy/VerdictAnchor.json — run `node script/deploy-anchor.mjs` first.");
    process.exit(1);
  }
  const dep = load("VerdictAnchor.json");
  const provider = makeProvider(e.ROOTSTOCK_RPC);
  return { e, dep, provider };
}

async function cmdDemo() {
  const { dep, provider } = connect();
  const wallet = await makeSigner(env().PRIVATE_KEY, provider);
  const anchor = new Contract(dep.address, ANCHOR_ABI, wallet);

  // Seed four sample verdicts (in reality: pulled from ValidationResponse events)
  const sample = [
    { requestHash: keccak256(toUtf8Bytes("job-A-" + Date.now())), responseHash: keccak256(toUtf8Bytes("verdict-A")), score: 100, tag: "predge/commit-before-outcome" },
    { requestHash: keccak256(toUtf8Bytes("job-B-" + Date.now())), responseHash: keccak256(toUtf8Bytes("verdict-B")), score: 0,   tag: "predge/commit-before-outcome" },
    { requestHash: keccak256(toUtf8Bytes("job-C-" + Date.now())), responseHash: keccak256(toUtf8Bytes("verdict-C")), score: 100, tag: "predge/commit-before-outcome" },
    { requestHash: keccak256(toUtf8Bytes("job-D-" + Date.now())), responseHash: keccak256(toUtf8Bytes("verdict-D")), score: 100, tag: "predge/commit-before-outcome" },
  ];
  const leaves = sample.map(leafOf);
  const root = merkleRoot(leaves);
  console.log(`Predge daily verdict anchor · ${addressLink(dep.address)}\n`);
  console.log(`[1/3] built merkle root from ${leaves.length} verdicts`);
  leaves.forEach((l, i) => console.log(`      leaf[${i}] ${l}`));
  console.log(`      root      ${root}\n`);

  console.log(`[2/3] commit the root on Rootstock — chain timestamps it, forever`);
  const tx = await withRetry("commitRoot", () => anchor.commitRoot(root, leaves.length));
  const rc = await withRetry("wait", () => tx.wait());
  // find the emitted batchId
  const iface = new (await import("ethers")).Interface(ANCHOR_ABI);
  let batchId;
  for (const log of rc.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "RootCommitted") { batchId = parsed.args.batchId; break; }
    } catch {}
  }
  console.log(`      committed batchId ${batchId}  ${txLink(tx.hash)}\n`);

  console.log(`[3/3] anyone can now prove a specific verdict was in this batch — offline, sha256 only`);
  const idx = 1; // pick the "score 0" verdict
  const proof = inclusionProof(leaves, idx);
  const ok = verifyProof(leaves[idx], proof, root);
  console.log(`      leaf[${idx}] ${leaves[idx]}`);
  console.log(`      proof   ${proof.length} sibling(s):`, proof.map((p) => (p.isRight ? "R:" : "L:") + p.hash.slice(2, 10) + "…").join(" · "));
  console.log(`      verify  ${ok ? "OK ✓" : "FAILED"}   →   the same 32 bytes (${root.slice(2, 18)}…) will be posted to Bitcoin L1 as OP_RETURN`);

  console.log(`\nNext: post the root as OP_RETURN on Bitcoin (out of scope here), then call:`);
  console.log(`  node anchor.mjs record ${batchId} <btcTxid> <btcBlockHeight> <btcAnchoredAt>`);
  console.log(`\nOnce anchored, altering a Predge verdict requires rewriting a Bitcoin block —`);
  console.log(`i.e. Bitcoin PoW security. This is the "Bitcoin-final" story.\n${EXPLORER}/address/${dep.address}`);
}

async function cmdRecord() {
  const [_, __, batchId, btcTxid, btcBlockHeight, btcAnchoredAt] = process.argv;
  if (!btcTxid) { console.error("usage: node anchor.mjs record <batchId> <btcTxid 0x…> <btcBlockHeight> <btcAnchoredAt>"); process.exit(1); }
  const { dep, provider } = connect();
  const wallet = await makeSigner(env().PRIVATE_KEY, provider);
  const anchor = new Contract(dep.address, ANCHOR_ABI, wallet);
  const tx = await withRetry("recordBtcAnchor", () => anchor.recordBtcAnchor(batchId, btcTxid, btcBlockHeight, btcAnchoredAt));
  await withRetry("wait", () => tx.wait());
  console.log(`recorded BTC anchor for batchId ${batchId}: ${btcTxid} @ block ${btcBlockHeight}   ${txLink(tx.hash)}`);
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const [cmd] = process.argv.slice(2);
  if (cmd === "demo") await cmdDemo();
  else if (cmd === "record") await cmdRecord();
  else console.log(
    "Predge — daily verdict anchor to Bitcoin (via Rootstock)\n\n" +
    "  node anchor.mjs demo       build root, commit on RSK, print proof\n" +
    "  node anchor.mjs record <batchId> <btcTxid> <btcBlockHeight> <btcAnchoredAt>"
  );
}
