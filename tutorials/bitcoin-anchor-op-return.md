# Bitcoin-final settlement for Rootstock events: OP_RETURN-anchoring a daily merkle root

**Audience:** Rootstock builders who want their contract events to inherit Bitcoin's
security floor, not just the sidechain's.
**Time to reproduce:** ~1 hour end-to-end. ~2000 satoshis of tBTC required.
**Reference implementation:**
[github.com/predgeAI/predge-rootstock](https://github.com/predgeAI/predge-rootstock)
(`contracts/VerdictAnchor.sol`, `anchor.mjs`, `btc-anchor.mjs`).

## The gap this closes

Rootstock is merge-mined by ~80% of Bitcoin's hashrate. That's usually the sentence you
hear, and then… nothing. Nothing in typical dev docs shows you how to *use* that security
from an application. Your contract emits events on Rootstock; those events live in the RSK
block header, not in Bitcoin. If someone convinces enough Rootstock miners to reorg an old
block, your event is gone, and Bitcoin's PoW never had a chance to notice.

Bitcoin-anchoring — posting a hash of your data as `OP_RETURN` on the Bitcoin base layer —
is the answer, and it's decades old at this point. It's just never been packaged as a
tutorial that fits a Rootstock developer's workflow. This one does.

The result: after you run the anchor cycle, altering one of your app's on-chain events
requires rewriting a **Bitcoin** block. Not "convincing the RSK federation." A Bitcoin
block. Different security regime.

Contents:

1. [What Bitcoin-anchoring is (and isn't)](#1-what-bitcoin-anchoring-is-and-isnt)
2. [The three-piece architecture we're building](#2-the-three-piece-architecture-were-building)
3. [The on-chain anchor contract (~80 lines of Solidity)](#3-the-on-chain-anchor-contract-80-lines-of-solidity)
4. [The daily batcher: from events to a merkle root](#4-the-daily-batcher-from-events-to-a-merkle-root)
5. [Building and broadcasting the OP_RETURN — pure-JS, no Bitcoin Core](#5-building-and-broadcasting-the-op_return--pure-js-no-bitcoin-core)
6. [Recording the Bitcoin txid back on Rootstock](#6-recording-the-bitcoin-txid-back-on-rootstock)
7. [Verifying an anchored event, end-to-end](#7-verifying-an-anchored-event-end-to-end)
8. [Cost, cadence, and what NOT to anchor](#8-cost-cadence-and-what-not-to-anchor)

---

## 1. What Bitcoin-anchoring is (and isn't)

**Is:** committing 32 bytes of your data on Bitcoin's base layer via `OP_RETURN`. Anyone
can later prove that data existed no later than block height N, because it's inside a
Bitcoin block, whose header is chained by proof-of-work all the way to genesis.

**Is not:** running your logic on Bitcoin (Bitcoin is not Turing-complete), *proving*
your data on-chain on Rootstock (that requires SPV / a Bitcoin light client, out of scope
here), or replacing Rootstock's own security model. Anchoring is a *complement* — the
Rootstock event stays where it is; the anchor makes tampering with it after the fact
require also tampering with Bitcoin.

**How much data:** the standard `OP_RETURN` output on Bitcoin mainnet accepts up to 80
bytes as a policy limit. We only need 32 (a merkle root or a single sha256), so this fits
comfortably.

**Batching:** you don't post one Bitcoin transaction per event. You batch a day's events
into a merkle tree, post the *root* (32 bytes) once, and issue merkle-inclusion proofs
per event. One Bitcoin tx per day is enough to Bitcoin-secure thousands of events. Cost
scales O(1) with your event count.

## 2. The three-piece architecture we're building

```
┌────────────────────────────┐     ┌───────────────────────────┐
│  Your Rootstock contracts  │     │  Off-chain batcher (Node) │
│  ─ emit events all day     │────▶│  ─ scans events           │
│  (validator, vault, DEX,   │     │  ─ builds merkle root     │
│   whatever you have)       │     │  ─ commits root on RSK    │
└────────────────────────────┘     │  ─ posts root as          │
                                   │    OP_RETURN on BTC       │
                                   │  ─ records txid on RSK    │
                                   └───────────────────────────┘
                                              │       │
                     ┌────────────────────────┘       └─────────────────────────┐
                     ▼                                                          ▼
┌─────────────────────────────────┐                    ┌───────────────────────────────────────┐
│  VerdictAnchor.sol on Rootstock │                    │  Bitcoin L1 (mainnet or testnet3)     │
│  ─ batchOf(id) → {root, count,  │                    │  ─ your OP_RETURN carrying the same   │
│      rskCommittedAt, btcTxid,   │                    │    32 bytes, in a real Bitcoin block  │
│      btcBlockHeight}            │                    │  ─ altering it requires rewriting     │
│  ─ recordBtcAnchor(id, txid)    │                    │    that Bitcoin block                 │
└─────────────────────────────────┘                    └───────────────────────────────────────┘
```

Three pieces, three files in the reference repo, each does one thing.

## 3. The on-chain anchor contract (~80 lines of Solidity)

`contracts/VerdictAnchor.sol` on Rootstock keeps a tiny record per daily batch:
{merkleRoot, count, rskCommittedAt, btcTxid, btcBlockHeight}. Two write paths, both
gated to a single anchorer address:

```solidity
function commitRoot(bytes32 merkleRoot, uint32 count) external onlyAnchorer
    returns (uint64 batchId)
{
    if (merkleRoot == bytes32(0)) revert ZeroRoot();
    if (batchIdOfRoot[merkleRoot] != 0) revert DuplicateRoot();
    batchId = ++totalBatches;
    batchOf[batchId] = Anchor({
        merkleRoot: merkleRoot,
        count: count,
        rskCommittedAt: uint64(block.timestamp),
        btcAnchoredAt: 0,
        btcTxid: bytes32(0),
        btcBlockHeight: 0
    });
    batchIdOfRoot[merkleRoot] = batchId;
    emit RootCommitted(batchId, merkleRoot, count, uint64(block.timestamp));
}

function recordBtcAnchor(uint64 batchId, bytes32 btcTxid, uint32 btcBlockHeight,
                        uint64 btcAnchoredAt) external onlyAnchorer
{
    Anchor storage a = batchOf[batchId];
    if (a.rskCommittedAt == 0) revert UnknownBatch();
    if (a.btcTxid != bytes32(0)) revert AlreadyAnchored();
    a.btcTxid = btcTxid;
    a.btcBlockHeight = btcBlockHeight;
    a.btcAnchoredAt = btcAnchoredAt;
    emit BtcAnchored(batchId, btcTxid, btcBlockHeight, btcAnchoredAt);
}
```

Why split `commitRoot` and `recordBtcAnchor`? Because the RSK commitment happens
*immediately* at end-of-day, but the Bitcoin transaction takes ~10 minutes to confirm.
Splitting means the Rootstock chain timestamps the root **before** Bitcoin has said
anything — so no matter when the Bitcoin anchor lands, you always have "committed here
first" as a provable property. Both events (`RootCommitted`, `BtcAnchored`) are indexed
so a subgraph can join them by `batchId`.

Deployed reference on Rootstock testnet:
[`0xDCf119ACd13d89F2926fF792070c6dA4d4134356`](https://explorer.testnet.rootstock.io/address/0xDCf119ACd13d89F2926fF792070c6dA4d4134356).

## 4. The daily batcher: from events to a merkle root

`anchor.mjs` reads every event you want anchored, canonicalises each into 32 bytes,
builds a pair-hash sha256 merkle tree, and calls `commitRoot`.

The **leaf hash** should uniquely identify the event's content. For the reference stack
(a Predge `PredgeAgentValidator`), a leaf is:

```js
export function leafOf({ requestHash, responseHash, score, tag }) {
  const buf = Buffer.concat([
    Buffer.from(requestHash.slice(2), "hex"),
    Buffer.from(responseHash.slice(2), "hex"),
    Buffer.from([score & 0xff]),
    Buffer.from(tag || "", "utf8"),
  ]);
  return "0x" + crypto.createHash("sha256").update(buf).digest("hex");
}
```

Adapt the fields to whatever your event carries. What matters: the leaf must be
**reproducible from the on-chain event alone**, so a third-party auditor can rebuild
the tree and check inclusion without asking you.

The merkle tree itself is the least surprising sha256 pair-hash — duplicate the last
leaf on odd counts, iterate until one root remains:

```js
export function merkleRoot(leavesHex) {
  if (leavesHex.length === 0) throw new Error("empty batch");
  let layer = leavesHex.map((h) => Buffer.from(h.slice(2), "hex"));
  while (layer.length > 1) {
    if (layer.length % 2 === 1) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(crypto.createHash("sha256")
        .update(Buffer.concat([layer[i], layer[i + 1]])).digest());
    }
    layer = next;
  }
  return "0x" + layer[0].toString("hex");
}
```

Test it end-to-end against the deployed contract:

```
node anchor.mjs demo
```

Trimmed output from a real run (14 Aug 2026):

```
[1/3] built merkle root from 4 verdicts
      leaf[0] 0xdc3c68f07009209c3fc137ec65cc6a311f175d2b9ed642e1e2bc21cd95d92039
      leaf[1] 0x653d4269120a339079a1ce3b9eadd9446a23b1c6c47a944d3df19b37a434ba51
      leaf[2] 0xb4877f5021a460bec11bfe660e902154e7b01fa4a27f73e4235dfdb2d0826e49
      leaf[3] 0xa108c6439fc2134de3f55fb09328d75a3171b1b87a5d0f94a474dbdf0d5ca9bc
      root      0xe428b5815e2017286d9fae1c6fe849c2e22d4ed3f1ed6e2d1a00b4fb63cec2b7

[2/3] commit the root on Rootstock — chain timestamps it, forever
      committed batchId 1  https://explorer.testnet.rootstock.io/tx/0xc317c7a5501990fccb3eea1916d8610fe879aa6b557521fe21c6d39a9d1178f9

[3/3] anyone can now prove a specific verdict was in this batch — offline, sha256 only
      leaf[1] 0x653d4269120a339079a1ce3b9eadd9446a23b1c6c47a944d3df19b37a434ba51
      proof   2 sibling(s): L:dc3c68f0… · R:0828d6d6…
      verify  OK ✓   →   the same 32 bytes (e428b5815e201728…) will be posted to Bitcoin L1
```

Everything in `anchor.mjs` is `crypto` from `node:` plus `ethers` — no external
dependencies for the merkle side.

## 5. Building and broadcasting the OP_RETURN — pure-JS, no Bitcoin Core

This is the piece most tutorials skip because they assume you have `bitcoind` running.
You don't need it. Two npm packages get you there without native compilation:

```bash
npm install bitcoinjs-lib @noble/secp256k1
```

Wire `@noble/secp256k1` into `bitcoinjs-lib` (v6 wants an ECC provider):

```js
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@noble/secp256k1";

const eccAdapter = {
  isPoint: (p) => { try { ecc.Point.fromHex(p); return true; } catch { return false; } },
  isPrivate: (d) => ecc.utils.isValidPrivateKey(d),
  pointFromScalar: (d, compressed = true) => Buffer.from(ecc.getPublicKey(d, compressed)),
  sign: (hash, priv) => Buffer.from(ecc.signSync(hash, priv)),
  verify: (hash, pub, sig) => ecc.verify(sig, hash, pub),
};
bitcoin.initEccLib(eccAdapter);
```

Generate a testnet3 address once, save the private key to `.env` (mode `0600`), and
prompt to fund it via `bitcoinfaucet.uo1.net` or `kuttler.eu/en/bitcoin/btc/faucet/` (any
amount ≥ ~2000 sats — one anchor uses ~500 sats, so a single 100k-sat drip covers 200+
anchors).

The transaction itself is P2WPKH (segwit v0 — lowest fees, faucets prefer it) with two
outputs: `OP_RETURN <32-byte root>` and a change output back to yourself.

```js
const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });

psbt.addInput({
  hash: utxo.txid,
  index: utxo.vout,
  witnessUtxo: {
    script: bitcoin.address.toOutputScript(address, bitcoin.networks.testnet),
    value: utxo.value,
  },
  nonWitnessUtxo: rawInputTx,
});

// The OP_RETURN carrying our 32-byte merkle root
const opReturnScript = bitcoin.script.compile([
  bitcoin.opcodes.OP_RETURN,
  Buffer.from(merkleRoot.slice(2), "hex"),
]);
psbt.addOutput({ script: opReturnScript, value: 0 });

// Change back to ourselves (dust threshold is 546 sats)
psbt.addOutput({ address, value: change });

psbt.signInput(0, { publicKey: pub, sign: (hash) => Buffer.from(ecc.signSync(hash, priv)) });
psbt.finalizeAllInputs();
const rawTxHex = psbt.extractTransaction().toHex();
```

Broadcast via **mempool.space** — free, no key, no node needed:

```js
const res = await fetch("https://mempool.space/testnet/api/tx", {
  method: "POST",
  body: rawTxHex,
});
const btcTxid = (await res.text()).trim();
```

Then poll `/tx/${btcTxid}/status` every minute until `confirmed: true` (typically one
block, ~10 min on testnet3, though sometimes longer during network lulls).

Full working file: `btc-anchor.mjs` in the reference repo. One command:

```bash
npm run btc:anchor            # picks the latest un-anchored batch, does the whole flow
npm run btc:anchor:dry        # build the tx and print it, don't broadcast (safe rehearsal)
```

## 6. Recording the Bitcoin txid back on Rootstock

Once `confirmed: true` returns block height and timestamp, call `recordBtcAnchor` on
Rootstock. This is a normal RSK write — legacy `type: 0` transaction with an explicit
`gasPrice` (RSK doesn't support EIP-1559):

```js
const anchor = new Contract(deployAddress, ANCHOR_ABI, rskWallet);
const tx = await anchor.recordBtcAnchor(
  batchId,
  "0x" + btcTxid,       // 32 bytes as bytes32
  blockHeight,          // uint32
  blockTime,            // uint64
);
await tx.wait();
```

Both events (`RootCommitted` and `BtcAnchored`) now live on Rootstock, joinable by
`batchId`. Anyone auditing the anchor cycle reads both and verifies:

- The root was committed at `rskCommittedAt` **before** the Bitcoin transaction confirmed.
- The Bitcoin txid points to an `OP_RETURN` carrying exactly that 32-byte root.
- Both the committed root and the Bitcoin txid are `write-once` on Rootstock — the
  contract has no function to rewrite either.

## 7. Verifying an anchored event, end-to-end

To prove a specific event `E` is Bitcoin-secured, an auditor needs three artifacts,
none of which have to come from you:

1. **The Bitcoin transaction** — fetch it by txid from any Bitcoin node or explorer,
   confirm its `OP_RETURN` output carries exactly `merkleRoot`, and confirm it's
   included in Bitcoin block `H` at timestamp `T`.
2. **The Rootstock anchor entry** — read `VerdictAnchor.batchOf(batchId)`, confirm the
   `merkleRoot` matches, that `btcTxid == this txid`, that `rskCommittedAt` predates `T`.
3. **A merkle inclusion proof for `E`** — computed with the same pair-hash sha256 walk
   from event to root. This is public JSON, the size is O(log N) per event.

Any of those three failing tells the auditor exactly which layer lied. The full walk
lives in `anchor.mjs`'s `inclusionProof` + `verifyProof` and is under 40 lines.

## 8. Cost, cadence, and what NOT to anchor

**Cost per anchor.** On Bitcoin mainnet, ~200 vB × current fee rate. At 1 sat/vB
(testnet3 minimum, also common on mainnet) that's 200 sats. At 20 sat/vB (typical
mainnet fee) it's 4000 sats — around $2 at today's BTC price. Rootstock write is a
few thousand gas, cents worth of rBTC.

**Cadence.** One anchor per day is enough for almost everyone. It bounds tampering
resistance to "you'd have to reorg the Bitcoin block that day". If you truly need
tighter (e.g. high-value settlement), one per hour is 24× the cost — still fine.
Never anchor per-event unless each event is worth a few dollars on its own.

**What NOT to anchor:**
- Anything you don't want *forever public*. `OP_RETURN` is permanent, and full-node
  operators keep it.
- Data that can be reconstructed cheaper elsewhere. If your event is already an
  ERC-20 `Transfer`, its provenance is already in Rootstock's chain history — you
  don't gain much from anchoring individual transfers, only from anchoring **your
  contract's summary state** at end-of-day.
- Anything that identifies a user beyond what your on-chain data already reveals.
  Anchor hashes, not preimages.

**What TO anchor:**
- End-of-day settlement summaries (Predge's verdicts are the canonical example).
- Governance decisions and treasury movements.
- Oracle-published outcomes that other contracts settle against.
- Any state your users would want to prove *later, without you*.

---

## Reproduce it against the reference deployment

```bash
git clone https://github.com/predgeAI/predge-rootstock
cd predge-rootstock && npm install

# fund the deployer for RSK writes (0.005 tRBTC is plenty)
npm run genwallet
# → prints the address; fund at faucet.rootstock.io

# generate a Bitcoin testnet key + address for the OP_RETURN posts
npm run btc:genwallet
# → prints the tb1… address; fund at bitcoinfaucet.uo1.net (2000 sats is plenty)

# deploy your own VerdictAnchor (contracts are non-upgradeable)
npm run deploy-anchor

# build + commit a demo batch on Rootstock
npm run anchor:demo

# broadcast the OP_RETURN to Bitcoin testnet + record the txid on Rootstock
npm run btc:anchor
```

Every step is a real transaction, on two chains.

## Meta

Written by Predge (15 Aug 2026). Contact: `hello@predge.io` · [@predgeAI](https://x.com/predgeAI).
Licensed CC BY 4.0 — reproduce, remix, extract into `dev.rootstock.io` if useful.

Companion reads:
- [Portable EVM: Deploying an ERC-8004 Validator from an Ethereum L2 to Rootstock](./portable-evm-to-rootstock.md)
- [predgeAI/rsk-l402-adapter](https://github.com/predgeAI/rsk-l402-adapter) —
  payment on Lightning, dispute on Bitcoin (via Rootstock).
