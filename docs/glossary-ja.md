# Glossary EN / JA (draft for IBUKI's review)

Terms used on the client page (`app/job2.html`), the contractor page (`app/contractor.html`) and the reviewer
screen (`app/review.html`). Generated from `app/glossary.js` by `node script/glossary-md.mjs`; edit the JS list,
not this file. Hosted as `glossary.html` next to the pages.

Please mark any term that is not natural in Japanese demolition work. 解体工事の現場で不自然な用語があればご指摘ください。

| English | 日本語 | Note |
|---|---|---|
| client | 発注者 | The party who pays (B2C: the homeowner, 施主). Used for the payer role everywhere. |
| contractor | 受注者 | The party who does the work and is paid (the demolition company). Contract term: provider. |
| reviewer | 審査人 | Decides only when there is an objection. In the pilot: a Predge test wallet. Alternatives: 判定者, 第三者審査人. |
| checklist (agreed evidence checklist) | チェックリスト（合意した証跡チェックリスト） | Agreed at signing: items, evidence, viewpoint, timing. |
| work item | 作業項目 | One line of the checklist (e.g. scaffolding and protection). |
| evidence | 証跡 | Photos and documents per item. Alternatives: エビデンス, 工事写真・書類. Please tell us which is natural for your clients. |
| viewpoint (photo position) | 撮影位置 | Where the photo is taken from. Alternative: 撮影箇所. |
| timing | 時期 | When the evidence is taken (before backfilling, each haul, …). Alternative: 撮影時期. |
| milestone | マイルストーン | One payment stage (30 / 20 / 50). Alternative: 支払区分, 出来高の区切り. |
| milestone package | マイルストーンの提出資料一式 | What the contractor submits for one milestone; its hash goes on-chain. |
| completion | 完了（工事完了） | Full completion of the work. 竣工 is used for building construction; 完了 seemed more natural for demolition. |
| completion report | 完了報告書 | Alternative: 工事完了報告書. |
| acceptance | 検収 | Client's acceptance of the work. |
| deemed acceptance (silence = acceptance) | みなし検収（異議がなければ検収とみなす） | The contract rule: no objection within the period means accepted. |
| objection | 異議（異議の申立て） | Client's written objection inside the objection period. |
| objection period | 異議申立期間 | 10 days after submission in the current deployment (pilot proposal: 3 days). |
| approve (an item) | 承認（項目の承認） | Client marks an item as OK. Moves no money. |
| need more evidence | 追加の証跡が必要 | Client asks the contractor for more evidence on one item. |
| approve (token permission, MetaMask) | 使用許可（トークンの使用許可） | Deliberately a different word from item approval (承認), because IBUKI's point 1 was that the token approval looked like job creation. |
| escrow | エスクロー（預託） | Money held by the contract until acceptance or a decision. |
| fund (a milestone) | 代金を預ける | Client moves the milestone amount into escrow. |
| release payment | 支払いを確定 | After the objection period without objection; anyone may trigger it. |
| refund | 返金 |  |
| withdraw | 引き出し（引き出す） | Moves the credited amount from the contract to the wallet. A separate step. |
| waiting to withdraw | 引き出し待ち | Credited by the contract, not yet in the wallet. |
| manifest (industrial waste) | マニフェスト（産業廃棄物管理票） | Copies are evidence for hauling items. |
| wood waste | 木くず |  |
| rubble, concrete debris | がれき類、コンクリートがら |  |
| scaffolding and protection | 足場・養生 |  |
| foundation removal | 基礎の撤去 |  |
| backfilling | 埋戻し |  |
| site grading | 整地 |  |
| hash (fingerprint) | ハッシュ値（改ざん検知用の指紋） | Shows a file or text was not changed. Does not prove a photo is true. |
| private case record | 非公開の案件記録 | Off-chain storage readable only by client, contractor and reviewer. |
| signature (no gas) | 署名（ガス代なし） | MetaMask signature request; not a transaction. |
| transaction | 取引（トランザクション） | A MetaMask confirmation that costs gas. |
| gas | ガス代 | Paid in tRBTC on Rootstock testnet. |
| case | 案件 | One checklist between one client and one contractor, with its milestone jobs. |
