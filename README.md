# predge-rootstock — a Bitcoin-final verdict layer for agent settlement

The neutral verdict layer for AI-agent transactions on a Bitcoin sidechain — Bitcoin-collateralized,
trustlessly slashable, and committed on-chain *before* the outcome is knowable.

**We don't compete with x402 or L402 payments — we sit on top.** Whoever pays (Coinbase's x402 facilitator
on Base, `RDMoutlaw/pay402` for L402↔x402, [Lightning Labs L402](https://lightning.engineering/posts/2026-03-11-L402-for-agents/), `aibtcdev` on Stacks), still needs an
independent answer to *"did the paid-for work actually get delivered?"*. On Bitcoin sidechains today that
answer is either trust-me-bro (ERC-8183: *"the client is also the evaluator"*), a single-keeper signature
(`pactnetwork/x402-recourse-stacks`), or nothing. **Predge is a slashable ERC-8004 evaluator with a
sha256-verifiable acceptance test — on Rootstock, where the bond is denominated in Bitcoin.**

## The point in one paragraph

Rootstock's native token — **rBTC** — is Bitcoin brought over the 2-way peg, secured by ~80% of Bitcoin
hashrate via merge-mining. When a Predge validator stakes `msg.value` behind a verdict on Rootstock, the
capital at risk is literally Bitcoin. If the validator lies, anyone submits the actually-delivered bytes,
the contract recomputes `sha256` on-chain (precompile `0x02`, bit-identical to Ethereum), and the Bitcoin
bond transfers to the challenger. No arbiter, no DAO vote, no keeper signature. The only pre-committed
material is the acceptance test — hashed and chain-timestamped *before* the work exists, so a verdict
provably cannot be reverse-engineered from the result.

Nobody else in the x402 / ERC-8004 / agent-settlement space ships that combination on a Bitcoin sidechain.
(There are ~5 x402 payment-layer repos on Rootstock and ~30+ on Stacks; there's `pactnetwork/x402-recourse-stacks`
with a keeper-signed refund; there's `pbtc21/stx402-agents` with an ERC-8004-inspired registry. None combine
ERC-8004 identity + ERC-8183 evaluator + trustless slashable bond + commit-before-outcome + Bitcoin-final
settlement in one stack.)

## The three primitives (portable Ethereum semantics, Bitcoin-denominated)

- **`PredgeAgentValidator`** — a native ERC-8004 Validation Registry (`validationRequest` /
  `validationResponse` / `getValidationStatus` / `getSummary` — canonical signatures) with the guarantee
  the standard leaves open: the response reverts unless the request was recorded first, and is written
  exactly once. Any ERC-8004 consumer settles against it with no adapter.
- **`PredgeValidatorBond`** — the validator stakes native rBTC (= Bitcoin) behind every verdict; anyone
  can slash a dishonest verdict on-chain via the sha256 precompile against the deterministic acceptance
  test. Honest verdicts are unslashable. Validator reclaims after a dispute window.
- **`AgentJob`** — a minimal ERC-8183 job (`createJob` / `submit` / `complete` / `reject`, evaluator-gated
  signatures preserved) where the *client* names Predge as the independent evaluator, escrows rBTC, and
  the evaluator settles on the committed test — closing the "client is also the evaluator" hole.

Plus a `MockUSDC` stablecoin **only** for the x402 payment-layer demo (Rootstock has no canonical USDC,
and the bond/escrow layer uses native rBTC — the paid-token layer is separate on purpose). On mainnet,
`MockUSDC` becomes DoC / USDRIF / rUSDT with a single address swap.

## Live on Rootstock testnet (chainId 31)

| Contract | Address |
|---|---|
| PredgeAgentValidator | [`0x7041Ed7B6D33F6A8D2605b120194645765d67a85`](https://explorer.testnet.rootstock.io/address/0x7041Ed7B6D33F6A8D2605b120194645765d67a85) |
| PredgeValidatorBond  | [`0xC2c4F125371c319D5bF5Ee49fEC5b4cB6787F5D2`](https://explorer.testnet.rootstock.io/address/0xC2c4F125371c319D5bF5Ee49fEC5b4cB6787F5D2) |
| AgentJob             | [`0x2Bf0EaAc5FA4EaF36AA3a55883F6ba642385690E`](https://explorer.testnet.rootstock.io/address/0x2Bf0EaAc5FA4EaF36AA3a55883F6ba642385690E) |
| MockUSDC (demo)      | [`0x34f4B3Eac9c24448e2BB7623016CDA85487474AB`](https://explorer.testnet.rootstock.io/address/0x34f4B3Eac9c24448e2BB7623016CDA85487474AB) |
| AgentJobERC20 (USDRIF escrow) | [`0x15C790fb445dc8Ed00aca65e424e26CDeB1999A0`](https://rootstock-testnet.blockscout.com/address/0x15C790fb445dc8Ed00aca65e424e26CDeB1999A0) |
| PredgeNoObjectionEvaluator (for the USDRIF escrow) | [`0xca4E20f5903f795374B96331011Aaa24C45f6316`](https://rootstock-testnet.blockscout.com/address/0xca4E20f5903f795374B96331011Aaa24C45f6316) |

## USDRIF escrow (ERC-20 path)

`AgentJob` above escrows native rBTC only (`msg.value`), and stays as deployed. `contracts/v2/AgentJobERC20.sol`
is a separate contract with the same lifecycle, evaluator surface and `getJob` layout as the native `AgentJobV2`
used for IBUKI job #1, but the escrow is one ERC-20 fixed at deploy time: testnet USDRIF
(`0x8dbF326E12a9fF37ED6ddf75adA548c2640a6482`, 18 decimals). The client `approve`s, then `createJob(..., amount)`
pulls exactly `amount` with `transferFrom`. Every payout is a pull credit withdrawn in USDRIF.

- Same objection logic: `PredgeNoObjectionEvaluator` is the unchanged source of the job #1 evaluator
  (objection period, `releaseOnSilence`, reviewer `resolve`, refund after the window), deployed against the
  ERC-20 escrow. Both contracts are verified on Blockscout. Windows: objection 10 days, evaluation 24 days.
- Token safety: accepts tokens that return `true` or nothing, reverts on `false`; checks the balance delta so a
  fee-on-transfer token cannot under-fund a job; one reentrancy lock over every entry point; no payable
  function, so native value is rejected. No owner, no admin, no upgrade.
- Tests: `forge test` (unit tests with standard, false-returning, no-return, fee-on-transfer, lying and
  reentrant tokens) and `npm run test:fork` (job-2 objection branch against the real testnet USDRIF on a fork).
- One CLI for a job: `node script/usdrif-job.mjs <deploy|evidence|create|submit|object|resolve|release|refund|withdraw|status|e2e>`.
  Steps that another party must sign (IBUKI's approve, createJob, object, withdraw) are printed as unsigned
  transactions for their own wallet. Walkthrough: [tutorials/usdrif-job-escrow.md](./tutorials/usdrif-job-escrow.md).

## Reproduce it

```bash
npm install
npm run genwallet                 # writes .env with a fresh key (mode 0600)
# fund DEPLOYER_ADDRESS at https://faucet.rootstock.io (~0.005 tRBTC is enough)

# Deploy your own instance (contracts are non-upgradeable; ours above are one deployment):
npm run deploy-all

# End-to-end demo: agent pays MockUSDC per call, validator scores, escrow settles.
npm run demo

# The killer demo: honest verdict is unslashable; a lie loses its BITCOIN bond on-chain.
npm run bond:demo
```

## Positioning — what this is and isn't

- ✅ Complementary to Lightning Labs' L402 (payment on Lightning, verdict on Bitcoin sidechain).
- ✅ Complementary to Coinbase's x402 facilitator (payment on Base, verdict on Rootstock/Arc).
- ✅ Complementary to `aibtcdev` on Stacks (their marketplace pays for AI inference; our layer answers
  *"was the answer honest?"*).
- ❌ NOT another x402 payment starter kit — `siddhant-k08/x402-rsk`, `sainath5001/x402-rootstock-pay-per-api`,
  `Augit1/USDRIF-x402-SDK` and others already ship that.
- ❌ NOT another agent-registry — `pbtc21/stx402-agents` and ERC-8004 references cover that.
- ❌ NOT another refund contract — `pactnetwork/x402-recourse-stacks` covers that with a keeper.

**We are the missing verdict-and-slashing layer, Bitcoin-collateralized, that all the above can compose with.**

## Rootstock-specific engineering notes

- **EIP-1559 not supported** — every tx sent as legacy `type: 0` with an explicit `gasPrice`. Handled once
  in `lib/rsk.mjs`; contracts are unchanged from the Arc deployment.
- **Cancun EVM shipped in Rootstock's Lovell hardfork (Feb 2024)** — PUSH0, MCOPY, TLOAD/TSTORE, BASEFEE
  all available; `solc ^0.8.24` with `evmVersion: "cancun"` compiles and deploys clean.
- **Precompile `0x02` SHA-256 is bit-identical** to Ethereum — the trustless slash mechanism works as-is.
- **`block.timestamp`** — ~30s block time, monotonic-nondecreasing (RSKJ enforces `parent.ts <= block.ts`).
  Not Bitcoin's timestamp; treat as Ethereum-equivalent.

## Anchor a batch to Bitcoin L1 (real OP_RETURN)

The anchor cycle is one command per day:

```bash
# 1) One-time: generate a Bitcoin testnet key + address (writes .env.btc, 0600)
npm run btc:genwallet
# 2) Fund the printed tb1… address at https://bitcoinfaucet.uo1.net/  (2000+ sats is enough)
# 3) Build + broadcast the OP_RETURN, then record the Bitcoin txid on Rootstock:
npm run btc:anchor
# (or preview without sending: npm run btc:anchor:dry)
```

The script (a) picks the most recent un-anchored `VerdictAnchor` batch, (b) builds a P2WPKH
transaction whose second output is `OP_RETURN <merkle_root>`, (c) signs locally with pure-JS
`@noble/secp256k1` (no native compile), (d) broadcasts via `mempool.space/testnet`, (e) waits
for confirmation, (f) calls `VerdictAnchor.recordBtcAnchor(batchId, txid, blockHeight, time)`
on Rootstock. After this runs, altering any verdict in the batch requires rewriting a
Bitcoin block.

## Companion tutorial

If you're a team already deployed on Base / Arc / Arbitrum / an OP-stack and considering
Rootstock as a second target, read: [**Portable EVM: Deploying an ERC-8004 Validator from
an Ethereum L2 to Rootstock**](./tutorials/portable-evm-to-rootstock.md) — everything that
changes and (mostly) doesn't when you move the same Solidity across.

## Roadmap

- **L402-payment adapter** — see the companion repo
  [`predgeAI/rsk-l402-adapter`](https://github.com/predgeAI/rsk-l402-adapter) (already live)
  so the payment leg can run over Lightning while the bond + verdict stay on Rootstock —
  "payment on Lightning, dispute on Bitcoin", a story nobody else tells end-to-end.
- **rBTC-collateralized reference integration** with one existing RootstockCollective Rewards
  recipient (Sovryn escrow, LayerBank market, Money On Chain vault, or Tropykus lending) —
  turn Predge's ecosystem from "hosted on Rootstock" into "connected to Rootstock DeFi".
- **Clarity port** for the Stacks Endowment autumn window (sBTC-denominated bond).

## Contact

hello@predge.io · [@predgeAI](https://x.com/predgeAI) · build-in-public.
Repo: <https://github.com/predgeAI/predge-rootstock>. Companion: <https://github.com/predgeAI/predge-arc>.
