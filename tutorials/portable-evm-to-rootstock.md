# Portable EVM: Deploying an ERC-8004 Validator from an Ethereum L2 to Rootstock

**Audience:** Solidity teams with a live EVM deployment (Base / Arc / Arbitrum / Optimism-stack)
who are considering Rootstock as a second deployment.
**Time to reproduce:** ~1 hour, no protocol changes.
**Reference implementation:** [github.com/predgeAI/predge-rootstock](https://github.com/predgeAI/predge-rootstock)
(four contracts, ~500 LOC), which is itself a straight port of
[github.com/predgeAI/predge-arc](https://github.com/predgeAI/predge-arc).

Every "deploy to Rootstock" tutorial today starts from an empty Hardhat project. That's not
the question most teams actually arrive with. If you already have a running EVM stack, the
real question is: **what changes when I deploy it to Rootstock, and what stays the same?**
This tutorial answers that end-to-end for a non-trivial codebase — a native ERC-8004
Validation Registry with a slashable bond that uses the `sha256` precompile for on-chain
verification. Nothing in the Solidity had to change. One thing in the deployment tooling
did.

We walk through the port in the order the questions actually come up:

1. [Solidity — what compiler settings do I need?](#1-solidity--what-compiler-settings-do-i-need)
2. [Cancun opcodes — is PUSH0 / MCOPY / TLOAD safe on Rootstock?](#2-cancun-opcodes--is-push0--mcopy--tload-safe-on-rootstock)
3. [Precompiles — does `sha256` behave the same?](#3-precompiles--does-sha256-behave-the-same)
4. [Transactions — the one real gotcha (EIP-1559 is not supported)](#4-transactions--the-one-real-gotcha-eip-1559-is-not-supported)
5. [`block.timestamp` and other subtleties](#5-blocktimestamp-and-other-subtleties)
6. [The native token — a bond in tRBTC is a bond in Bitcoin](#6-the-native-token--a-bond-in-trbtc-is-a-bond-in-bitcoin)
7. [Faucet + RPC + explorer](#7-faucet--rpc--explorer)
8. [Deploying + running the demo end-to-end](#8-deploying--running-the-demo-end-to-end)
9. [What we did NOT have to change](#9-what-we-did-not-have-to-change)

---

## 1. Solidity — what compiler settings do I need?

The reference stack compiles with:

```js
{
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "cancun",
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
}
```

`solc` version pinned to **0.8.26**. Any recent 0.8.x will work — the constraints are all on
the EVM side, not the language.

The only setting that would have surprised a Rootstock builder *before* February 2024 is
`evmVersion: "cancun"`. That is now the default for `solc 0.8.24+`, and — as we'll see —
it's the setting you want on Rootstock too.

## 2. Cancun opcodes — is PUSH0 / MCOPY / TLOAD safe on Rootstock?

**Yes.** Rootstock's **Lovell hardfork** (Feb 12, 2024) closed the Cancun gap:

- `PUSH0` (EIP-3855) — shipped
- `MCOPY` (EIP-5656) — shipped
- `TLOAD` / `TSTORE` (EIP-1153, transient storage) — shipped
- `BASEFEE` (EIP-3198) — shipped

The only Cancun feature that is *not* live on Rootstock is **EIP-4844 blob transactions**.
Unless your contract literally reads `blobhash` or dispatches blob-carrying transactions,
this doesn't affect you.

So the four contracts in our stack — `PredgeAgentValidator`, `PredgeValidatorBond`,
`AgentJob`, `MockUSDC` — compile once with `evmVersion: "cancun"` and produce the same
bytecode we deploy to Circle Arc. Same bytes, both chains.

## 3. Precompiles — does `sha256` behave the same?

This is the load-bearing question for our stack. `PredgeValidatorBond` allows *anyone* to
slash a dishonest verdict on-chain by proving that the delivered bytes don't match the
committed `expected` hash:

```solidity
function challenge(bytes32 requestHash, bytes calldata deliverable) external {
    // ...
    bytes32 got = sha256(deliverable);        // ← precompile 0x02
    bool matches = got == s.expected;
    bool lied = (s.score == 100 && !matches) || (s.score == 0 && matches);
    if (!lied) revert VerdictHonest();
    // slash + transfer bond to msg.sender
}
```

If the `sha256` precompile on Rootstock returned even one differing byte from Ethereum's
implementation, honest verdicts would be slashable and dishonest ones wouldn't — the whole
mechanism breaks silently.

We ran the port and confirmed: **Rootstock's precompiles `0x01` (ecrecover), `0x02`
(SHA-256), `0x03` (RIPEMD-160), `0x04` (IDENTITY), `0x05` (MODEXP), `0x06`–`0x08` (BN
add/mul/pairing)** all behave identically to the Ethereum mainnet reference. Same input →
same 32 bytes out. No code changes needed.

You can convince yourself in one call:

```solidity
function assertSha256Compatible(bytes memory x) external pure returns (bytes32) {
    return sha256(x);
}
```

Deploy this to Rootstock and Ethereum, hit both with the same calldata, compare the returned
bytes. They match.

## 4. Transactions — the one real gotcha (EIP-1559 is not supported)

This is the only tooling change we had to make.

Rootstock does not support EIP-1559 fee-market transactions. If you build a `type: 2`
envelope with `maxFeePerGas` / `maxPriorityFeePerGas`, the RSKj node rejects it. Every
transaction must be **legacy `type: 0` with an explicit `gasPrice`**.

ethers v6 defaults to `type: 2` when it detects a network that supports EIP-1559, but its
detection heuristic is lossy on Rootstock. The safest thing is to wrap your signer once,
force the transaction shape, and never think about it again. We did it here (see
[`predge-rootstock/lib/rsk.mjs`](https://github.com/predgeAI/predge-rootstock/blob/main/lib/rsk.mjs)):

```js
import { JsonRpcProvider, Network, Wallet } from "ethers";

export const CHAIN_ID = 31;   // testnet; mainnet is 30

export function makeProvider(rpc) {
  return new JsonRpcProvider(rpc || "https://public-node.testnet.rsk.co", undefined, {
    staticNetwork: Network.from(CHAIN_ID),
  });
}

/** Wallet with a legacy-tx override — every ethers send goes out as type 0
 *  with a bumped gasPrice sourced from the node. */
export async function makeSigner(pk, provider) {
  const w = new Wallet(pk, provider);
  const fee = await provider.getFeeData();
  const gasPrice = ((fee.gasPrice ?? 65000000n) * 12n) / 10n;   // 20% bump
  const orig = w.sendTransaction.bind(w);
  w.sendTransaction = (tx) => orig({
    ...tx,
    type: 0,
    gasPrice,
    maxFeePerGas: undefined,
    maxPriorityFeePerGas: undefined,
  });
  return w;
}
```

Every subsequent `wallet.sendTransaction(...)` or `contract.someMethod(...)` call now goes
out as legacy — no per-call boilerplate. The 20% bump over reported `gasPrice` is enough to
clear the mempool without overpaying; RSK's `minGasPrice` moves slowly, so this is stable
across sessions.

If you're using viem instead of ethers, the equivalent is
`createWalletClient({ ..., transport: http() })` and passing `type: 'legacy'` on every
`sendTransaction` — or, cleaner, defining a custom chain with `formatters` that force it.

**That's it. That's the one code-side change from Base / Arc / Arbitrum.**

## 5. `block.timestamp` and other subtleties

- Block time is **~30 seconds** (Ethereum L1: ~12s; Base: ~2s; Arc: ~1s). Anything that
  loops "every N blocks" needs to be re-tuned for wall-clock.
- `block.timestamp` is **monotonic non-decreasing** — RSKJ enforces `parent.ts <= block.ts`.
  So `commitLeadTime = resolvedAt - committedAt` (see `PredgeAgentValidator`) is always
  non-negative, same as on Ethereum.
- `block.timestamp` is **not** Bitcoin's timestamp — it's set by the RSK block proposer.
  Treat it the same as an Ethereum block timestamp.
- `chainid()` = **30** on Rootstock mainnet, **31** on testnet. If you're using EIP-712 or
  domain separators, wire the chain id through your config, don't hardcode it.
- `blockhash(n)` — supported, but only for the last 256 blocks, same as Ethereum.

Nothing you use every day is missing.

## 6. The native token — a bond in tRBTC is a bond in Bitcoin

This is where the port stops being a mechanical exercise and starts being an actual
positioning decision.

`PredgeValidatorBond` uses `msg.value` for stakes — it takes native value and returns native
value. On Circle Arc, the native token is USDC (Arc is a USDC-gas chain). On Rootstock, the
native token is **rBTC** — Bitcoin brought over the 2-way peg, merge-mined by ~80% of
Bitcoin's hashrate. So the *same contract*, deployed unchanged, becomes:

- On Arc: capital-at-risk denominated in USDC.
- On Rootstock: capital-at-risk denominated in **Bitcoin**.

You don't need to change a line of Solidity for this. What you should probably change is
the story you tell about the bond — because a slashable USDC bond is commodity, and a
slashable Bitcoin bond is not. Every `msg.value` you were sending as USDC on Arc becomes
Bitcoin on Rootstock. That's the whole story, in one architectural fact.

## 7. Faucet + RPC + explorer

- **RPC (testnet):** `https://public-node.testnet.rsk.co` (rate-limited, fine for dev).
  Alternates: `https://rootstock-testnet.drpc.org`. For production traffic get an
  API-keyed endpoint from a provider like Alchemy or Blast — the public node is not
  meant for load.
- **Chain ID:** `31` (testnet), `30` (mainnet). Set `staticNetwork: Network.from(31)`
  when building the ethers `JsonRpcProvider` so it stops auto-detecting.
- **Faucet:** [faucet.rootstock.io](https://faucet.rootstock.io) — hCaptcha, ~0.005 tRBTC
  per drip. That's enough for **hundreds** of transactions; RSK gas is cheap. Backup
  faucets: Blast (0.1 tRBTC/day), Thirdweb.
- **Explorer:** [explorer.testnet.rootstock.io](https://explorer.testnet.rootstock.io)
  (official). Etherscan-style alternative: `rootstock-testnet.blockscout.com` — supports
  verified-source contract view.

## 8. Deploying + running the demo end-to-end

Clone, generate a wallet, fund it, deploy the four contracts, run the demo.

```bash
git clone https://github.com/predgeAI/predge-rootstock
cd predge-rootstock
npm install

# writes .env with a fresh key (mode 0600) — never commit this file
npm run genwallet
# → deployer: 0x657FC20C8ED9B0500D88df9378Dd1B0e3188d519 (yours will be different)

# fund the DEPLOYER_ADDRESS at https://faucet.rootstock.io
# 0.005 tRBTC is plenty; wait ~1 min for confirmation.

# deploy the four contracts: MockUSDC, PredgeAgentValidator, PredgeValidatorBond, AgentJob
npm run deploy-all

# end-to-end: mint MockUSDC, commit a validation request, respond, escrow settles,
# rewrite reverts. Every step is a real Rootstock testnet transaction.
npm run demo
```

A trimmed sample run (14 Aug 2026):

```
Predge on Rootstock testnet · chainId 31
  MockUSDC              https://explorer.testnet.rootstock.io/address/0x34f4B3Ea…7474AB
  PredgeAgentValidator  https://explorer.testnet.rootstock.io/address/0x7041Ed7B…d67a85

[1/5] mint MockUSDC to the operator (funds escrow)
      minted; balance 0.5 USDC  tx 0x24d525d0…44cfd354

[2/5] a verdict on work that was never REQUESTED is refused
      reverted: NotRequested — the validator cannot bless work it never committed to judge

[3/5] validationRequest — signed acceptance test committed BEFORE work (Job A)
      requestHash  0x5597afbb…6de69208
      signature ok true   tx 0x33e184fc…dc0bab7c
      validator ran test → 8a9b7649… == expected → score 100
      escrow → transfer 0.05 USDC to worker (score 100)
      paid 0.05 USDC  tx 0xf2a07a30…3073b48e
      test was committed 27s before the verdict — proven by the chain

[4/5] validationRequest for Job B — worker will deliver garbage
      validator ran test → 34f294df… != expected → score 0
      escrow → REFUND 0.05 USDC to client (score 0)

[5/5] the verdict CANNOT be rewritten
      reverted: AlreadyResponded — the validator cannot flip score 0 → 100
```

For the bond side:

```bash
npm run bond:demo
```

which produces a real slash on-chain — the validator stakes tRBTC (= Bitcoin) behind a
verdict, tells a lie, and the contract slashes the bond to the challenger via the sha256
precompile. If precompiles behaved differently from Ethereum's, this demo would fail
silently.

## 9. What we did NOT have to change

For completeness — the things that stayed exactly the same:

- **Every line of Solidity.** All four `.sol` files (~500 LOC) are byte-identical to
  what runs on Circle Arc.
- **The ed25519 signing layer** on the off-chain side.
- **The ABI** — the same ethers `Contract` bindings work.
- **Test suite** — `node --test` runs unchanged.
- **The deploy scripts' compile step** — `solc` invocation with `evmVersion: "cancun"`.

The changes were:

- One `.env` file (RPC + chain id + private key).
- One `lib/rsk.mjs` (~30 LOC) that wraps the ethers signer to force legacy `type: 0`.

That's the port.

---

## Companion reads

- [predge-rootstock README](https://github.com/predgeAI/predge-rootstock) — full stack.
- [predge-arc README](https://github.com/predgeAI/predge-arc) — the source deployment on
  Circle Arc, for a side-by-side.
- [rsk-l402-adapter](https://github.com/predgeAI/rsk-l402-adapter) — companion npm that
  makes a Rootstock-hosted API accept Lightning L402 payments and record them on-chain via
  the validator you just deployed.
- Rootstock's own [Lovell hardfork announcement](https://blog.rootstock.io/noticia/rootstock-lovell-network-upgrade/)
  and [Cancun opcodes writeup](https://dev.rootstock.io/blog/) for the protocol context.

## Meta

Written by Predge (14 Aug 2026, updated 15 Aug). Contact: `hello@predge.io` · [@predgeAI](https://x.com/predgeAI).
Licensed CC BY 4.0 — reproduce, remix, extract into `dev.rootstock.io` if useful.
