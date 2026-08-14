# predge-rootstock — the first x402-shaped agent settlement on Rootstock

The commit-before-outcome agent-settlement stack we ship on Circle Arc, ported **AS-IS** to
Rootstock testnet — a Bitcoin sidechain. Same three contracts, same guarantee:

- **`PredgeAgentValidator`** — a native ERC-8004 Validation Registry with commit-before-outcome
  (the response reverts unless the request came first; write-once, un-rewritable).
- **`PredgeValidatorBond`** — capital behind every verdict, trustlessly slashable on-chain via
  the sha256 precompile against a deterministic acceptance test (honest verdicts unslashable).
- **`AgentJob`** — a minimal ERC-8183 job that names Predge as its independent evaluator and
  settles a paid token (here `MockUSDC`) on `complete()` / `reject()`.
- **`MockUSDC`** — a 6-decimal ERC-20 stub used as the paid asset because Rootstock has no
  canonical USDC yet. Points at DoC/USDRIF/rUSDT on mainnet by swapping the address.

## Why Rootstock

Rootstock brings the Bitcoin community exactly what the agent economy needs but Bitcoin
proper lacks: an EVM + deterministic finality anchored to BTC. Until now, no x402-shaped
agent-payment or agent-settlement infrastructure had shipped there. This is that.

The stack is unchanged from Arc — Solidity `^0.8.24` on the Cancun EVM (Rootstock's Lovell
hardfork, Feb 2024, closed the Cancun gap: PUSH0, MCOPY, TLOAD/TSTORE, BASEFEE, precompile
0x02 SHA-256). Only client-side difference: RSK doesn't support EIP-1559, so every tx is
sent as legacy `type: 0` with an explicit `gasPrice`. That's handled once, in `lib/rsk.mjs`.

## Quick start

```bash
npm install
npm run genwallet                 # writes .env with a fresh key + address (mode 0600)
# fund the DEPLOYER_ADDRESS at https://faucet.rootstock.io
npm run deploy-all                # MockUSDC → Validator → Bond → AgentJob
npm run demo                      # end-to-end on-chain flow
```

Network:
- RPC `https://public-node.testnet.rsk.co` · chainId **31** · native **tRBTC**
- Explorer https://explorer.testnet.rootstock.io
- Faucet https://faucet.rootstock.io  (~0.005 tRBTC / drip, hCaptcha)

## What the demo shows

1. **Mint MockUSDC** so escrow has something to pay with.
2. **Refusal #1** — a `validationResponse` on a request that was never made reverts `NotRequested`
   (no hindsight validation).
3. **Job A — honest delivery** → validator scores 100 → escrow releases USDC to the worker.
4. **Job B — worker delivers garbage** → validator scores 0 → escrow refunds the client.
5. **Refusal #2** — rewriting the verdict reverts `AlreadyResponded`.

Every step is a real Rootstock-testnet transaction with an explorer link.

## Positioning

Companion to `predge-arc` (same primitive on Circle Arc). On Rootstock this is:
- A **Hacktivator 3.0** contribution ("first x402 facilitator + demo dApp on Rootstock", up to $1k).
- The technical foundation for a future **RootstockCollective DAO grant** proposal.
- The Bitcoin-side half of a future **x402 ↔ L402 / sBTC bridge** — the wedge for a Stacks Endowment
  application in the autumn window.

Nothing is claimed on Rootstock mainnet — this is testnet only until the bridge and DAO story are ready.
