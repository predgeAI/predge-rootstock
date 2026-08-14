// Predge — payment on Lightning (L402), verdict on Bitcoin (Rootstock).
//
// The story: a client agent pays for an API call over the Lightning Network — either a native
// L402 macaroon-invoice endpoint, or an x402 endpoint reached via a bridge — while the
// dispute / verdict / slashable bond stays on Rootstock, where the bond is denominated in
// rBTC (BTC over the 2-way peg). Payment rail decoupled from the trust layer.
//
// Nobody else in the space tells this exact story. Lightning Labs' L402 is the incumbent for
// Bitcoin-native agent payment; Coinbase's x402 is the incumbent for USDC agent payment;
// `RDMoutlaw/pay402` is the incumbent adapter between them. Predge is not any of those — it's
// the neutral verdict layer they can all plug into: whatever paid, was the work delivered?
//
// This file is the bridge glue. Not a rewrite of pay402 (it's a mature SDK) — a THIN adapter
// that lets a Predge job be paid over L402 and settled by our Rootstock validator + bond.
//
// Flow:
//   1. Server prices a task in sats (L402) OR USDC (x402); Predge validator commits the
//      acceptance test on Rootstock (validationRequest) BEFORE the work exists.
//   2. Client uses pay402.fetch(url) — pay402 speaks whichever 402 dialect the server chose,
//      swaps rails if needed (Arkade→LN via Boltz, USDC→LN via LendaSat). Payment proof is
//      whatever the rail returns (macaroon token or x402 receipt).
//   3. Server delivers bytes. Predge validator runs the committed test → validationResponse
//      on Rootstock with the ed25519-signed verdict → the rBTC bond backs it.
//   4. Slash / reclaim / escrow all live on Rootstock, denominated in Bitcoin. Payment lived
//      wherever the rail put it — Lightning or Base.
//
// Design: we do NOT pin the payment rail in the Predge contract. The rail identifier and
// proof are recorded in the validationRequest URI / responseURI, so the same validator
// serves L402-paid, x402-paid, and future-rail-paid jobs symmetrically.
//
// Runtime: pay402 is optional at install time (peer dep) — this file lazy-imports it. If a
// consumer doesn't want Lightning at all, they just don't set LND_* / ARKADE_* / EVM_PRIVATE_KEY
// and pay402 becomes a no-op passthrough.

import crypto from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";

/** Optional lazy import — pay402 is a peer dep; if it's not installed, we return a stub client
 *  that says "not configured" instead of crashing. This lets the file be importable with zero
 *  extra dependencies, which matters for how npm resolves it inside a monorepo checkout. */
async function loadPay402() {
  try {
    return await import("pay402");
  } catch (e) {
    return null;
  }
}

/** Build the acceptance-test commitment for a job that will be PAID over any 402 rail. */
export function buildJobCommit({ jobId, task, priceSats, priceUsdc, expectedSha256, rail }) {
  const canonical = JSON.stringify({
    kind: "predge-job-precommit-v1",
    jobId,
    task,
    price: rail === "l402" ? { sats: priceSats } : { usdc: priceUsdc },
    rail,                                                  // "l402" | "x402" | "any"
    acceptance: { test: "sha256(deliverable) == expected", expected_sha256: expectedSha256 },
    committed_at: new Date().toISOString(),
  }, null, 0);
  return {
    canonical,
    requestHash: keccak256(toUtf8Bytes(canonical)), // → PredgeAgentValidator.validationRequest
  };
}

/** Client-side: pay for a Predge-gated URL via pay402 (any rail), then hand the raw bytes
 *  to the caller so they can locally compute sha256(deliverable) — which the on-chain
 *  validator will independently recompute against the committed expected_sha256. */
export async function payAndFetch(url, { pay402Config, maxAmount } = {}) {
  const p = await loadPay402();
  if (!p) return { ok: false, reason: "pay402 SDK not installed — `npm install pay402`" };

  // pay402 accepts wallet config via env vars (LND_HOST, EVM_PRIVATE_KEY, ARKADE_MNEMONIC) or
  // an explicit config object. We pass through and let pay402 pick the rail from the 402
  // challenge — that's the whole point of using it: the server chose the rail, not us.
  const client = new p.Client(pay402Config || {});
  const res = await client.fetch(url, { maxAmount });
  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = "0x" + crypto.createHash("sha256").update(buf).digest("hex");
  return {
    ok: true,
    bytes: buf,
    sha256,
    paymentProof: res.paymentProof,   // whatever pay402 returned (macaroon or receipt)
    rail: res.rail,                    // "l402" | "x402"
  };
}

/** Server-side: after Predge's validator has posted validationResponse on Rootstock, this
 *  helper builds the human/machine-readable evidence-pack URI that goes into responseURI. */
export function buildEvidence({ deliveredSha256, expectedSha256, requestHash, responseHash, verdict, paymentProof, rail }) {
  const passed = deliveredSha256 === expectedSha256;
  return JSON.stringify({
    kind: "predge-verdict-evidence-v1",
    requestHash,
    responseHash,
    verdict,                        // "delivered" | "failed"
    score: passed ? 100 : 0,
    payment: { rail, proof: paymentProof },
    check: {
      algo: "sha256(deliverable) == expected",
      expected_sha256: expectedSha256,
      delivered_sha256: deliveredSha256,
    },
    settled_on: "rootstock",         // where the verdict + bond live
    anchored_to: "bitcoin-via-op-return",  // where the batch merkle root ultimately anchors
    resolved_at: new Date().toISOString(),
  }, null, 0);
}

// Demo (informational): show the shape without actually calling pay402 or Rootstock — this
// file is glue, and the end-to-end run through demo.mjs already covers the on-chain side.
async function cmdDemo() {
  console.log("Predge L402↔x402 bridge — payment on Lightning, verdict on Bitcoin (Rootstock)\n");
  console.log("This file is glue. It doesn't run its own end-to-end because the on-chain half");
  console.log("is already covered by demo.mjs / bond.mjs / anchor.mjs. What it demonstrates:\n");

  const commit = buildJobCommit({
    jobId: "job-lightning-1",
    task: "extract-large-trades",
    priceSats: 500,
    rail: "l402",
    expectedSha256: "0xdeadbeefcafebabe" + "00".repeat(24),
  });
  console.log("1) Server commits the acceptance test on Rootstock BEFORE any work:");
  console.log("   canonical bytes:", commit.canonical);
  console.log("   requestHash    :", commit.requestHash);
  console.log("   → validator.validationRequest(evaluator, agentId, evidenceURI, requestHash)\n");

  const p = await loadPay402();
  console.log("2) Client pays over Lightning (via pay402):");
  if (p) {
    console.log("   pay402 SDK detected · version", p.VERSION || "unknown");
    console.log("   const { bytes, sha256, paymentProof, rail } = await payAndFetch(url, { maxAmount: '500 sats' });");
  } else {
    console.log("   pay402 not installed — this is a peer dep; add it if the Lightning rail is needed");
    console.log("   npm install pay402");
    console.log("   Design intent: pay402 client speaks whichever 402 dialect the server chose.");
  }

  console.log("\n3) Server runs the committed test → posts verdict on Rootstock:");
  const evidence = buildEvidence({
    deliveredSha256: "0xdeadbeefcafebabe" + "00".repeat(24),
    expectedSha256:  "0xdeadbeefcafebabe" + "00".repeat(24),
    requestHash: commit.requestHash,
    responseHash: keccak256(toUtf8Bytes("verdict-bytes")),
    verdict: "delivered",
    paymentProof: "L402:macaroon-token-…", rail: "l402",
  });
  console.log("   evidence:", evidence);
  console.log("   → validator.validationResponse(requestHash, 100, evidence, responseHash, tag)");
  console.log("   → bond in rBTC backs this. slash if lying. reclaim after dispute window.\n");

  console.log("Result: payment rail was Lightning. verdict + bond + slashing live on Rootstock,");
  console.log("Bitcoin-denominated. That's the story nobody else in the space tells.");
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const [cmd] = process.argv.slice(2);
  if (cmd === "demo") await cmdDemo();
  else console.log("Predge L402↔x402 bridge · payment on Lightning, verdict on Bitcoin\n\n  node l402-bridge.mjs demo");
}
