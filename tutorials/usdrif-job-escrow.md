# A job escrowed in USDRIF, with an objection window

IBUKI job #1 runs on the native escrow (`AgentJobV2`, tRBTC). This walkthrough runs the same job flow in
testnet USDRIF on `AgentJobERC20` with the same `PredgeNoObjectionEvaluator`: funding, objection, verdict
and payout, all in USDRIF. Everything here is Rootstock **testnet** (chainId 31).

| | Address |
|---|---|
| USDRIF (RIF US Dollar, 18 decimals) | `0x8dbF326E12a9fF37ED6ddf75adA548c2640a6482` |
| AgentJobERC20 | `0x15C790fb445dc8Ed00aca65e424e26CDeB1999A0` |
| PredgeNoObjectionEvaluator | `0xca4E20f5903f795374B96331011Aaa24C45f6316` |
| Reviewer (Predge test wallet) | `0x2a0cd8CF5d9370E9F994D9202d711502686fF6A9` |

The USDRIF address above is written with Rootstock's EIP-1191 checksum. In ethers or Solidity, use the
lower-case form or the EIP-55 form `0x8dbf326e12a9fF37ED6DDF75adA548C2640A6482`.

## Roles

- **Client**: pays, and is the only one who can object. In job 2 this is the tester (IBUKI).
- **Provider**: does the work and submits the evidence package (only hashes go on-chain).
- **Reviewer**: decides only jobs with an objection. Cannot touch a job without one.
- **Anyone**: can release a job after a silent objection period, or trigger the refund after the window.

## Steps

```bash
npm install && forge build
# 0. hash the evidence locally (one entry per checklist item; "a+b" = several files for one item)
node script/usdrif-job.mjs evidence --checklist fixtures/rerise-b2b-checklist.v1.json \
  --files before.jpg,during1.jpg+during2.jpg,after.jpg,report.pdf,manifests.pdf,inspection.pdf --out ev.json

# 1. funding (client): approve + createJob. Prints two unsigned txs if the client is not a key we hold.
node script/usdrif-job.mjs create --client <CLIENT> --provider <PROVIDER> --amount 10 --evidence ev.json --expiry-days 7

# 2. submission (provider)
CONFIRM_TESTNET=rootstock-testnet node script/usdrif-job.mjs submit --job <ID> --evidence ev.json

# 3. objection (client, within 10 days of the submission). Only the hash of the text goes on-chain.
node script/usdrif-job.mjs object --job <ID> --file objection.pdf

# 4. verdict (reviewer): refund the client, or pay the provider
CONFIRM_TESTNET=rootstock-testnet node script/usdrif-job.mjs resolve --job <ID> --refund --file decision.pdf

# 5. payout: the credited party withdraws USDRIF
node script/usdrif-job.mjs withdraw --address <CLIENT>

# any time: state and deadlines in UTC and local time
node script/usdrif-job.mjs status --job <ID> --tz Asia/Tokyo
```

Without an objection, anyone runs `release --job <ID> --evidence ev.json` after the 10 days and the provider is
credited. If nobody decides within 24 days of the submission, `refund --job <ID>` credits the client.

Dry run of the whole objection branch on a local fork, with the real USDRIF contract:

```bash
anvil --fork-url https://public-node.testnet.rsk.co --chain-id 31 --base-fee 0 &
node script/usdrif-job.mjs e2e --rpc http://127.0.0.1:8545
```

## Getting testnet USDRIF and tRBTC

- tRBTC for gas: https://faucet.rootstock.io
- tRIF: https://faucet.rifos.org
- USDRIF is minted against RIF collateral by the RIF on Chain protocol (Money on Chain's RoC contracts). Their
  developer docs show the mint call (`mintStableTokenVendors`, after approving RIF), but we have not confirmed
  the current testnet app URL or testnet contract addresses, so check the RIF on Chain docs before relying on
  a specific route.
