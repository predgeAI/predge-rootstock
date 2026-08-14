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

## Roadmap

- **Bitcoin-anchor for verdicts** — hash `(requestHash, verdict, responseHash, evaluator_sig)` and anchor
  daily via Stacks micro-block or OP_RETURN on Bitcoin L1. Every verdict finalizes to Bitcoin.
- **L402-payment adapter** — thin bridge over [`RDMoutlaw/pay402`](https://github.com/RDMoutlaw/pay402) so
  the payment leg can run over Lightning while the bond + verdict stay on Rootstock. "Payment on Lightning,
  dispute on Bitcoin" — a story nobody else tells.
- **rBTC-collateralized reference integration** with one existing RootstockCollective Rewards recipient
  (Sovryn escrow, LayerBank market, Money On Chain vault, or Tropykus lending) — turn Predge's ecosystem
  from "hosted on Rootstock" into "connected to Rootstock DeFi".
- **Bitcoin-anchor Clarity port** for the Stacks Endowment autumn window (sBTC-denominated bond).

## Contact

hello@predge.io · [@predgeAI](https://x.com/predgeAI) · build-in-public.
Repo: <https://github.com/predgeAI/predge-rootstock>. Companion: <https://github.com/predgeAI/predge-arc>.
