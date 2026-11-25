// Private case record: logic shared by the browser pages (app/*.html) and the API (app/api/case.js).
// No dependency of its own: the caller passes ethers v6 (window.ethers in the browser, the npm package in Node).
//
// What a case is: one agreed checklist (milestones -> work items, each with the evidence, viewpoint and timing
// agreed at signing) between one client and one contractor, with the Predge reviewer of the objection contract.
// Every change is a record signed by the wallet that made it (EIP-712 signature: no transaction, no gas).
// Records are kept off-chain in the private case record. Only hashes go on-chain:
//   specHash of milestone job k = evaluator.specHashFor(checklistHash, number of items in milestone k)
//   manifest submitted for job k = abi.encode(checklistHash, itemHashes)  (sha256 of it is the deliverable)
//   itemHash = keccak256(canonical({caseId, itemId, records: [hashes of the item's evidence and review records]}))
// Item approvals never move money; money moves per milestone job only (the unchanged contracts).

export const CASE_DOMAIN = { name: "Predge case record", version: "1", chainId: 31 };
export const SESSION_TYPES = {
  Session: [
    { name: "purpose", type: "string" },
    { name: "wallet", type: "address" },
    { name: "issuedAt", type: "uint64" },
  ],
};
export const RECORD_TYPES = {
  Record: [
    { name: "caseId", type: "string" },
    { name: "kind", type: "string" },
    { name: "summary", type: "string" },
    { name: "payloadHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
};
export const SESSION_PURPOSE = "Sign in to the Predge case record. Read access only: no transaction, no gas.";
export const SESSION_TTL_S = 24 * 3600;
export const MAX_FILE_BYTES = 4 * 1024 * 1024; // Vercel function request body limit is 4.5 MB
export const MAX_PAYLOAD_CHARS = 20000;

/** Who may sign which record kind. */
export const KIND_ROLES = {
  "case.create": ["client"],
  "checklist.sign": ["contractor"],
  "job.link": ["client"],
  evidence: ["contractor"],
  review: ["client"],
  package: ["contractor"],
  objection: ["client"],
  answer: ["contractor"],
  decision: ["reviewer"],
};

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const H32 = /^0x[0-9a-fA-F]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export class CaseError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, msg, status) => { throw new CaseError(code, msg, status); };

/** Deterministic JSON: object keys sorted, no whitespace. Arrays keep their order. */
export function canonical(v) {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) fail("bad_number", "non-finite number");
    if (typeof v === "bigint") return JSON.stringify(v.toString());
    return JSON.stringify(v ?? null);
  }
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

export const lc = (a) => String(a || "").toLowerCase();

/** The B2C demolition checklist from the pilot plan (30 / 20 / 50). Strings only; both parties may edit before signing. */
export const TEMPLATES = {
  en: {
    title: "Demolition, B2C, 30 / 20 / 50",
    rule: "If the client makes no specific written objection within the objection period after the milestone package is submitted, the milestone is deemed accepted. An objection should name the item(s) concerned.",
    milestones: [
      { key: "M1", label: "Signing (30%)", percent: 30, items: [
        { id: "m1-contract", title: "Signed contract (anonymised)", evidence: "Contract PDF signed by both parties", viewpoint: "-", timing: "At signing" },
        { id: "m1-scope", title: "Scope and exclusions", evidence: "Scope sheet listing included and excluded work", viewpoint: "-", timing: "At signing" },
      ] },
      { key: "M2", label: "Main building demolished (20%)", percent: 20, items: [
        { id: "m2-scaffold", title: "Scaffolding and protection", evidence: "Installation photos (sheets, curing, fences)", viewpoint: "Each side of the building, from the road", timing: "After installation, before demolition" },
        { id: "m2-main", title: "Main building demolition", evidence: "Before and after photos", viewpoint: "Same viewpoints before and after", timing: "Before start and after the main building is down" },
      ] },
      { key: "M3", label: "Full completion (50%)", percent: 50, items: [
        { id: "m3-wood", title: "Wood waste hauled", evidence: "Hauling photos + manifest copies", viewpoint: "Truck loading, plate visible", timing: "Each haul" },
        { id: "m3-rubble", title: "Rubble and concrete debris hauled", evidence: "Hauling photos + manifest copies", viewpoint: "Truck loading, plate visible", timing: "Each haul" },
        { id: "m3-foundation", title: "Foundation removal", evidence: "Photos of the excavated area", viewpoint: "Whole pit and close-ups", timing: "Before backfilling" },
        { id: "m3-grading", title: "Site grading", evidence: "Photos of the graded site", viewpoint: "Agreed viewpoints (same as before-work photos)", timing: "After grading" },
        { id: "m3-report", title: "Completion report", evidence: "Completion report PDF", viewpoint: "-", timing: "At completion" },
      ] },
    ],
  },
  ja: {
    title: "解体工事（個人のお客様）30 / 20 / 50",
    rule: "マイルストーンの提出資料一式の提出後、異議申立期間内に発注者から具体的な書面による異議がない場合、そのマイルストーンは検収されたものとみなします。異議には対象の項目を明記してください。",
    milestones: [
      { key: "M1", label: "契約時（30%）", percent: 30, items: [
        { id: "m1-contract", title: "署名済み契約書（匿名化）", evidence: "双方が署名した契約書のPDF", viewpoint: "-", timing: "契約時" },
        { id: "m1-scope", title: "工事範囲と対象外工事", evidence: "含まれる工事と対象外工事の一覧", viewpoint: "-", timing: "契約時" },
      ] },
      { key: "M2", label: "主要建物の解体完了時（20%）", percent: 20, items: [
        { id: "m2-scaffold", title: "足場・養生", evidence: "設置状況の写真（養生シート、防護、仮囲い）", viewpoint: "道路側から建物の各面", timing: "設置後、解体開始前" },
        { id: "m2-main", title: "主要建物の解体", evidence: "解体前・解体後の写真", viewpoint: "解体前と同じ撮影位置", timing: "着工前と主要建物の解体後" },
      ] },
      { key: "M3", label: "全工事完了時（50%）", percent: 50, items: [
        { id: "m3-wood", title: "木くずの搬出", evidence: "搬出写真＋マニフェスト（産業廃棄物管理票）の写し", viewpoint: "積込み状況、ナンバープレートが見えること", timing: "搬出ごと" },
        { id: "m3-rubble", title: "がれき類・コンクリートがらの搬出", evidence: "搬出写真＋マニフェストの写し", viewpoint: "積込み状況、ナンバープレートが見えること", timing: "搬出ごと" },
        { id: "m3-foundation", title: "基礎の撤去", evidence: "掘削部分の写真", viewpoint: "全景と近景", timing: "埋戻し前" },
        { id: "m3-grading", title: "整地", evidence: "整地後の写真", viewpoint: "合意した撮影位置（着工前写真と同じ）", timing: "整地後" },
        { id: "m3-report", title: "完了報告書", evidence: "完了報告書のPDF", viewpoint: "-", timing: "完了時" },
      ] },
    ],
  },
};

/** Validates the checklist shape. Returns the list of items with their milestone key. */
export function checklistItems(cl) {
  if (!cl || typeof cl !== "object") fail("bad_checklist", "checklist missing");
  const str = (s, max, what) => { if (typeof s !== "string" || !s.trim() || s.length > max) fail("bad_checklist", `${what}: 1..${max} characters`); };
  str(cl.title, 200, "title");
  str(cl.rule, 2000, "rule");
  if (!/^\d+(\.\d{1,6})?$/.test(String(cl.total || ""))) fail("bad_checklist", "total: a USDRIF amount");
  if (!Number.isInteger(cl.objectionDays) || cl.objectionDays < 1 || cl.objectionDays > 30) fail("bad_checklist", "objectionDays: 1..30");
  if (!Array.isArray(cl.milestones) || cl.milestones.length < 1 || cl.milestones.length > 5) fail("bad_checklist", "1 to 5 milestones");
  const ids = new Set(), keys = new Set(), out = [];
  for (const m of cl.milestones) {
    if (!/^M[1-9]$/.test(m?.key || "") || keys.has(m.key)) fail("bad_checklist", "milestone keys M1..M9, unique");
    keys.add(m.key);
    str(m.label, 200, "milestone label");
    if (!/^\d+(\.\d{1,6})?$/.test(String(m.amount || "")) || Number(m.amount) <= 0) fail("bad_checklist", `${m.key}: amount`);
    if (!Array.isArray(m.items) || m.items.length < 1 || m.items.length > 30) fail("bad_checklist", `${m.key}: 1 to 30 items`);
    for (const it of m.items) {
      if (!ID.test(it?.id || "") || ids.has(it.id)) fail("bad_checklist", `item id "${it?.id}": lower-case letters, digits, dashes; unique`);
      ids.add(it.id);
      str(it.title, 300, "item title");
      for (const f of ["evidence", "viewpoint", "timing"]) str(it[f], 500, `item ${f}`);
      out.push({ ...it, milestone: m.key });
    }
  }
  return out;
}

/** Record order: the server's arrival time (ms, strictly increasing per case), then the signer's time. */
export const byArrival = (a, b) => (a.receivedAt ?? a.issuedAt * 1000) - (b.receivedAt ?? b.issuedAt * 1000) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

export function makeCore(ethers) {
  const hashJson = (v) => ethers.keccak256(ethers.toUtf8Bytes(canonical(v)));
  /** Same as the client page's on-chain objection hash: keccak256 of the trimmed UTF-8 text. */
  const textHash = (t) => ethers.keccak256(ethers.toUtf8Bytes(String(t).trim()));
  const typedRecord = (r) => ({ caseId: r.caseId, kind: r.kind, summary: r.summary, payloadHash: hashJson(r.payload), issuedAt: r.issuedAt });
  const recordHash = (r) => hashJson({ caseId: r.caseId, kind: r.kind, summary: r.summary, payload: r.payload, issuedAt: r.issuedAt, signer: lc(r.signer) });

  function verifyRecord(r) {
    if (!r || typeof r !== "object") fail("bad_record", "record missing");
    if (typeof r.caseId !== "string" || !/^[0-9a-f]{32}$/.test(r.caseId)) fail("bad_record", "caseId: 32 hex characters");
    if (!KIND_ROLES[r.kind]) fail("bad_record", `unknown kind ${r.kind}`);
    if (typeof r.summary !== "string" || r.summary.length > 300) fail("bad_record", "summary: up to 300 characters");
    if (!Number.isInteger(r.issuedAt) || r.issuedAt <= 0) fail("bad_record", "issuedAt");
    if (!ADDR.test(r.signer || "")) fail("bad_record", "signer");
    if (canonical(r.payload ?? null).length > MAX_PAYLOAD_CHARS) fail("too_large", "payload too large");
    let who;
    try { who = ethers.verifyTypedData(CASE_DOMAIN, RECORD_TYPES, typedRecord(r), r.sig); } catch { fail("bad_signature", "signature does not verify"); }
    if (lc(who) !== lc(r.signer)) fail("bad_signature", "signature is not from the signer");
    return recordHash(r);
  }

  function verifySession(token, nowS) {
    let s;
    try { s = typeof token === "string" ? JSON.parse(atobUtf8(token)) : token; } catch { fail("bad_session", "unreadable session", 401); }
    if (!s || !ADDR.test(s.wallet || "") || !Number.isInteger(s.issuedAt)) fail("bad_session", "bad session", 401);
    if (s.issuedAt > nowS + 300 || nowS - s.issuedAt > SESSION_TTL_S) fail("session_expired", "sign in again", 401);
    let who;
    try { who = ethers.verifyTypedData(CASE_DOMAIN, SESSION_TYPES, { purpose: SESSION_PURPOSE, wallet: s.wallet, issuedAt: s.issuedAt }, s.sig); } catch { fail("bad_session", "session signature does not verify", 401); }
    if (lc(who) !== lc(s.wallet)) fail("bad_session", "session not signed by the wallet", 401);
    return lc(s.wallet);
  }

  const itemHash = (caseId, itemId, recordHashes) => hashJson({ caseId, itemId, records: recordHashes });
  const manifestOf = (checklistHash, itemHashes) => ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32[]"], [checklistHash, itemHashes]);
  const manifestSha256 = (checklistHash, itemHashes) => ethers.sha256(manifestOf(checklistHash, itemHashes));

  /** Folds the ordered records of a case into the current state shown by the pages. */
  function deriveCase(records) {
    const recs = [...records].sort(byArrival);
    const create = recs.find((r) => r.kind === "case.create");
    if (!create) fail("no_case", "case not found", 404);
    const p = create.payload;
    const items = checklistItems(p.checklist);
    const st = {
      caseId: create.caseId, createdAt: create.issuedAt,
      client: lc(p.client), contractor: lc(p.contractor), reviewer: lc(p.reviewer),
      escrow: lc(p.escrow), evaluator: lc(p.evaluator), chainId: p.chainId,
      checklist: p.checklist, checklistHash: p.checklistHash,
      signedBy: { client: { hash: create.hash, at: create.issuedAt }, contractor: null },
      milestones: p.checklist.milestones.map((m) => ({ key: m.key, label: m.label, amount: m.amount, itemIds: m.items.map((i) => i.id), job: null, packages: [] })),
      items: Object.fromEntries(items.map((it) => [it.id, { ...it, uploads: [], reviews: [], status: "missing" }])),
      objections: [], answers: [], decisions: [], records: recs,
    };
    const ms = (key) => st.milestones.find((m) => m.key === key);
    for (const r of recs) {
      const q = r.payload;
      if (r.kind === "checklist.sign" && !st.signedBy.contractor && q.checklistHash === st.checklistHash) st.signedBy.contractor = { hash: r.hash, at: r.issuedAt };
      else if (r.kind === "job.link") { const m = ms(q.milestone); if (m && !m.job) m.job = { jobId: String(q.jobId), hash: r.hash, at: r.issuedAt }; }
      else if (r.kind === "evidence") st.items[q.itemId]?.uploads.push(r);
      else if (r.kind === "review") st.items[q.itemId]?.reviews.push(r);
      else if (r.kind === "package") ms(q.milestone)?.packages.push(r);
      else if (r.kind === "objection") st.objections.push(r);
      else if (r.kind === "answer") st.answers.push(r);
      else if (r.kind === "decision") st.decisions.push(r);
    }
    for (const it of Object.values(st.items)) {
      const last = it.uploads.at(-1);
      if (!last) { it.status = "missing"; continue; }
      const rv = [...it.reviews].reverse().find((x) => x.payload.evidenceRecord === last.hash);
      it.status = rv ? rv.payload.decision : it.reviews.length ? "updated" : "submitted";
      it.lastReview = it.reviews.at(-1) || null;
    }
    return st;
  }

  /** Item hashes for a milestone package, from the records present now (evidence + reviews, in order). */
  function packageFor(st, key) {
    const m = st.milestones.find((x) => x.key === key);
    if (!m) fail("bad_milestone", `unknown milestone ${key}`);
    const items = m.itemIds.map((id) => {
      const it = st.items[id];
      return { itemId: id, records: [...it.uploads, ...it.reviews].sort(byArrival).map((r) => r.hash) };
    });
    const itemHashes = items.map((x) => itemHash(st.caseId, x.itemId, x.records));
    return { milestone: key, items, itemHashes, manifestSha256: manifestSha256(st.checklistHash, itemHashes) };
  }

  /**
   * Server-side checks of a new record against the case state. `chain` gives read access to the escrow:
   *   chain.getJob(escrow, id) -> {client, provider, evaluator, escrow, state, specHash}
   *   chain.specHashFor(evaluator, checklistHash, n) -> bytes32
   * Throws CaseError; returns the signer's role.
   */
  async function checkRecord(st, r, chain, opts = {}) {
    const role = lc(r.signer) === st.client ? "client" : lc(r.signer) === st.contractor ? "contractor" : lc(r.signer) === st.reviewer ? "reviewer" : null;
    if (!role) fail("not_party", "the signer is not a party of this case", 403);
    if (!KIND_ROLES[r.kind].includes(role)) fail("wrong_role", `${r.kind} must be signed by the ${KIND_ROLES[r.kind].join(" or ")}`, 403);
    const q = r.payload || {};
    const note = (s, max = 2000) => s === undefined || s === "" || (typeof s === "string" && s.length <= max) || fail("bad_payload", `note: up to ${max} characters`);
    const itemIdsOk = (ids) => { if (ids === undefined) return; if (!Array.isArray(ids) || ids.some((i) => !st.items[i])) fail("bad_payload", "itemIds must name checklist items"); };
    const linkedJob = (jobId) => { const m = st.milestones.find((x) => x.job && x.job.jobId === String(jobId)); if (!m) fail("not_linked", `job ${jobId} is not a milestone of this case`); return m; };
    switch (r.kind) {
      case "case.create": fail("exists", "case already exists", 409);
      case "checklist.sign":
        if (q.checklistHash !== st.checklistHash) fail("bad_payload", "checklistHash differs from the case checklist");
        if (st.signedBy.contractor) fail("exists", "already signed", 409);
        break;
      case "job.link": {
        const m = st.milestones.find((x) => x.key === q.milestone);
        if (!m) fail("bad_payload", "unknown milestone");
        if (!st.signedBy.contractor) fail("not_signed", "the contractor has not signed the checklist yet");
        if (m.job) fail("exists", `${m.key} already has job ${m.job.jobId}`, 409);
        if (!/^\d{1,9}$/.test(String(q.jobId))) fail("bad_payload", "jobId");
        if (st.milestones.some((x) => x.job && x.job.jobId === String(q.jobId))) fail("exists", "job already linked", 409);
        const j = await chain.getJob(st.escrow, q.jobId);
        if (lc(j.client) !== st.client || lc(j.provider) !== st.contractor || lc(j.evaluator) !== st.evaluator) fail("chain_mismatch", "the on-chain job has other parties or another evaluator");
        const spec = await chain.specHashFor(st.evaluator, st.checklistHash, m.itemIds.length);
        if (lc(j.specHash) !== lc(spec)) fail("chain_mismatch", "the on-chain job does not commit to this checklist");
        if (Number(j.state) === 1 && opts.parseAmount && j.escrow !== opts.parseAmount(m.amount)) fail("chain_mismatch", "the escrowed amount differs from the milestone amount");
        break;
      }
      case "evidence": {
        const it = st.items[q.itemId];
        if (!it || it.milestone !== q.milestone) fail("bad_payload", "unknown item");
        if (!Array.isArray(q.files) || q.files.length < 1 || q.files.length > 20) fail("bad_payload", "1 to 20 files");
        for (const f of q.files) {
          if (!H32.test(f?.sha256 || "") || typeof f.name !== "string" || f.name.length > 200 || !Number.isInteger(f.size)) fail("bad_payload", "file entry");
          if (opts.fileExists && !(await opts.fileExists(f.sha256))) fail("missing_file", `file ${f.name} was not uploaded`);
        }
        note(q.note);
        break;
      }
      case "review": {
        const it = st.items[q.itemId];
        if (!it) fail("bad_payload", "unknown item");
        if (!it.uploads.some((e) => e.hash === q.evidenceRecord)) fail("bad_payload", "evidenceRecord is not evidence of this item");
        if (!["approved", "need_more"].includes(q.decision)) fail("bad_payload", "decision: approved | need_more");
        if (q.decision === "need_more" && !String(q.note || "").trim()) fail("bad_payload", "say what is missing");
        note(q.note);
        break;
      }
      case "package": {
        const m = st.milestones.find((x) => x.key === q.milestone);
        if (!m?.job || m.job.jobId !== String(q.jobId)) fail("bad_payload", "milestone job not linked");
        for (const id of m.itemIds) if (!st.items[id].uploads.length) fail("incomplete", `item ${id} has no evidence`);
        const expect = packageFor(st, m.key);
        if (canonical(expect.itemHashes) !== canonical(q.itemHashes) || canonical(expect.items) !== canonical(q.items) || expect.manifestSha256 !== q.manifestSha256) fail("bad_payload", "package hashes do not match the case record");
        break;
      }
      case "objection":
        linkedJob(q.jobId);
        if (typeof q.text !== "string" || !q.text.trim() || q.text.length > 5000) fail("bad_payload", "text: 1..5000 characters");
        if (q.textHash !== textHash(q.text)) fail("bad_payload", "textHash is not keccak256 of the text");
        itemIdsOk(q.itemIds);
        break;
      case "answer":
        linkedJob(q.jobId);
        if (typeof q.text !== "string" || !q.text.trim() || q.text.length > 5000) fail("bad_payload", "text: 1..5000 characters");
        itemIdsOk(q.itemIds);
        break;
      case "decision":
        linkedJob(q.jobId);
        if (typeof q.payProvider !== "boolean") fail("bad_payload", "payProvider");
        if (typeof q.text !== "string" || !q.text.trim() || q.text.length > 5000) fail("bad_payload", "text: 1..5000 characters");
        if (q.decisionHash !== textHash(q.text)) fail("bad_payload", "decisionHash is not keccak256 of the text");
        itemIdsOk(q.itemIds);
        break;
    }
    return role;
  }

  /** Checks of the first record. `chain.evaluatorInfo(evaluator)` -> {job, reviewer}. */
  async function checkCreate(r, chain, cfg) {
    if (r.kind !== "case.create") fail("bad_record", "first record must be case.create");
    const p = r.payload || {};
    if (p.caseId !== r.caseId) fail("bad_payload", "caseId");
    for (const k of ["client", "contractor", "escrow", "evaluator", "reviewer"]) if (!ADDR.test(p[k] || "")) fail("bad_payload", `${k}: address`);
    if (lc(p.client) !== lc(r.signer)) fail("wrong_role", "the client creates the case", 403);
    if (lc(p.client) === lc(p.contractor)) fail("bad_payload", "client and contractor must differ");
    if (p.chainId !== CASE_DOMAIN.chainId) fail("bad_payload", "chainId");
    if (lc(p.escrow) !== lc(cfg.escrow) || lc(p.evaluator) !== lc(cfg.evaluator)) fail("bad_payload", "escrow/evaluator are not the pilot contracts");
    const items = checklistItems(p.checklist);
    if (p.checklistHash !== hashJson(p.checklist)) fail("bad_payload", "checklistHash");
    const info = await chain.evaluatorInfo(p.evaluator);
    if (lc(info.job) !== lc(p.escrow)) fail("chain_mismatch", "the evaluator is not wired to the escrow");
    if (lc(info.reviewer) !== lc(p.reviewer)) fail("chain_mismatch", "reviewer differs from the evaluator's reviewer");
    if ([lc(p.client), lc(p.contractor)].includes(lc(info.reviewer))) fail("bad_payload", "the reviewer cannot be a party");
    return items;
  }

  return { canonical, hashJson, textHash, typedRecord, recordHash, verifyRecord, verifySession, itemHash, manifestOf, manifestSha256, deriveCase, packageFor, checkRecord, checkCreate, checklistItems };
}

function atobUtf8(b64) {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
export function btoaUtf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}
