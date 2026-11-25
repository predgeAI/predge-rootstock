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

A client who does not use the CLI can do the client steps (approve + createJob, object, withdraw) from one page
in MetaMask: [`app/job2.html`](../app/job2.html), hosted at https://predge-rsk-job.vercel.app/job2.html. It makes the
same calls as the CLI (the objection hash is `keccak256` of the UTF-8 text, as with `object --text`), shows the job
state and the objection deadline in UTC and local time, and takes `provider`, `amount`, `evaluator`, `spec` and
`expiryDays` from the URL so a ready link can be sent to the client.

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

## Contractor pilot: checklist, item evidence, three milestones (pages)

Three pages share one private case record (`app/api/case.js`, a Vercel Function with a private Vercel Blob store):

| Page | Who | What |
|---|---|---|
| `app/job2.html` | client | agree the checklist (items, evidence, viewpoint, timing), fund one job per milestone (approve, then create), approve each item or ask for more evidence, object (the text goes to the case record, its keccak256 on-chain), withdraw a refund |
| `app/contractor.html` | contractor | sign the checklist, upload evidence per item, submit each milestone, answer an objection, release after a silent objection period, withdraw |
| `app/review.html` | reviewer | checklist + evidence per item + approval history + objection + answer in one place, on-chain checks, decide (pay / refund) |

All three have an EN / 日本語 switch; the terms are in `docs/glossary-ja.md` (generated from `app/glossary.js`).

How it maps to the unchanged contracts (no Solidity change):

- the agreed checklist is canonical JSON; `checklistHash = keccak256(canonical JSON)`;
- milestone job k is created with `specHash = evaluator.specHashFor(checklistHash, number of items of milestone k)`;
- every evidence upload and every item review is a record signed with EIP-712 (no gas) and stored off-chain;
  `itemHash = keccak256(canonical({caseId, itemId, records: [hashes of that item's evidence and review records]}))`;
- the contractor submits `manifest = abi.encode(checklistHash, itemHashes)` with `deliverable = sha256(manifest)`,
  so `releaseOnSilence(jobId, checklistHash, itemHashes)` works as before;
- item approvals move no money; money moves per milestone job only (B2C 30 / 20 / 50 = three jobs).

Access: every read needs a session signed by the wallet (EIP-712, no gas). Only the client, the contractor and the
reviewer of the case's objection contract can read the case and its files; the server checks parties and roles
on every write and checks job links against the chain (`client`, `provider`, `evaluator`, `specHash`, amount).

### Local end-to-end run (fork, no testnet writes)

```bash
forge build
anvil --fork-url https://public-node.testnet.rsk.co --chain-id 31 --base-fee 0 &
node script/pilot-fork.mjs setup        # fresh escrow + evaluator on the fork, reviewer = anvil #3, 200 USDRIF to anvil #1
node script/pilot-dev-server.mjs --fork deploy/pilot.local.json --store /tmp/cases   # http://localhost:8787
# open the printed URL; &devwallet=1 client, =2 contractor, =3 reviewer (anvil dev accounts, localhost only)
node script/pilot-fork.mjs warp --days 11   # pass the objection period
```

`?rpc=`, `?escrow=`, `?evaluator=` and `?devwallet=` are honoured only on localhost.

### Deploy (preview)

The Vercel project root is `app/` (`cd app && vercel deploy`). The function needs `BLOB_READ_WRITE_TOKEN` from a
private Blob store connected to the project (`vercel blob create-store <name> --access private`).
Optional env: `RSK_RPC`, `PILOT_ESCROW`, `PILOT_EVALUATOR`.
