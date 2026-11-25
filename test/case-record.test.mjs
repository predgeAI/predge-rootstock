// Private case record: signatures, roles, item hashes, milestone package, storage and access control.
// Runs the real API handler against a temp directory store and a mock chain (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { makeCore, CASE_DOMAIN, RECORD_TYPES, SESSION_TYPES, SESSION_PURPOSE, TEMPLATES, canonical, btoaUtf8 } from "../app/case-core.js";
import { createHandler } from "../app/api/_lib/handler.mjs";
import { fsStore } from "../app/api/_lib/store.mjs";

const core = makeCore(ethers);
const client = ethers.Wallet.createRandom(), contractor = ethers.Wallet.createRandom(), reviewer = ethers.Wallet.createRandom(), stranger = ethers.Wallet.createRandom();
const ESCROW = "0x15C790fb445dc8Ed00aca65e424e26CDeB1999A0", EVALUATOR = "0xca4E20f5903f795374B96331011Aaa24C45f6316";
const now = () => Math.floor(Date.now() / 1000);

// mock chain: jobs the test "creates"
const jobs = new Map();
const chain = {
  async evaluatorInfo() { return { job: ESCROW, reviewer: reviewer.address }; },
  async specHashFor(_ev, h, n) { return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [h, n])); },
  async getJob(_e, id) { const j = jobs.get(String(id)); if (!j) throw new Error("no job"); return j; },
};
const store = fsStore(mkdtempSync(join(tmpdir(), "case-test-")));
const handle = createHandler({ store, chain, config: { escrow: ESCROW, evaluator: EVALUATOR } });

async function sign(w, caseId, kind, payload, summary = kind) {
  const r = { caseId, kind, summary, payload, issuedAt: now(), signer: w.address.toLowerCase() };
  r.sig = await w.signTypedData(CASE_DOMAIN, RECORD_TYPES, core.typedRecord(r));
  return r;
}
async function sessionOf(w) {
  const s = { wallet: w.address, issuedAt: now() };
  s.sig = await w.signTypedData(CASE_DOMAIN, SESSION_TYPES, { purpose: SESSION_PURPOSE, ...s });
  return btoaUtf8(JSON.stringify(s));
}
const call = async (method, q, { body, w, ctype } = {}) => {
  const headers = {};
  if (w) headers["x-case-session"] = await sessionOf(w);
  if (ctype) headers["content-type"] = ctype;
  const res = await handle(new Request(`http://x/api/case?${new URLSearchParams(q)}`, { method, headers, body: body && !(body instanceof Uint8Array) ? JSON.stringify(body) : body }));
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, body: ct.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer()), headers: res.headers };
};

const caseId = ethers.hexlify(ethers.randomBytes(16)).slice(2);
const checklist = { ...structuredClone(TEMPLATES.ja), total: "100", objectionDays: 10 };
checklist.milestones = checklist.milestones.map((m) => ({ ...m, amount: String(m.percent) }));
const checklistHash = core.hashJson(checklist);

test("canonical JSON is key-order independent", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: "x" }] }), canonical({ a: [2, { c: "x", d: 1 }], b: 1 }));
  assert.equal(core.hashJson({ b: 1, a: 2 }), core.hashJson({ a: 2, b: 1 }));
});

test("objection hash matches the on-chain convention (keccak256 of trimmed UTF-8 text)", () => {
  const t = "  マニフェストの写しがありません  ";
  assert.equal(core.textHash(t), ethers.keccak256(ethers.toUtf8Bytes(t.trim())));
});

test("templates are valid checklists in both languages with the same item ids", () => {
  for (const lang of ["en", "ja"]) {
    const cl = { ...TEMPLATES[lang], total: "100", objectionDays: 10, milestones: TEMPLATES[lang].milestones.map((m) => ({ ...m, amount: String(m.percent) })) };
    assert.equal(core.checklistItems(cl).length, 9);
  }
  assert.deepEqual(TEMPLATES.en.milestones.map((m) => m.items.map((i) => i.id)), TEMPLATES.ja.milestones.map((m) => m.items.map((i) => i.id)));
});

test("a record signed by one wallet but claiming another signer is rejected", async () => {
  const r = await sign(stranger, caseId, "checklist.sign", { checklistHash });
  r.signer = contractor.address.toLowerCase();
  assert.throws(() => core.verifyRecord(r), /signature/);
});

test("case flow: create, sign, link 3 jobs, evidence, reviews, package, objection, answer, decision", async () => {
  const create = await sign(client, caseId, "case.create", { caseId, client: client.address, contractor: contractor.address, escrow: ESCROW, evaluator: EVALUATOR, reviewer: reviewer.address, chainId: 31, checklist, checklistHash });
  // only the client may create
  const bad = await sign(contractor, caseId, "case.create", create.payload); // valid signature, but not by the client
  assert.equal((await call("POST", { op: "create" }, { body: bad })).status, 403);
  let r = await call("POST", { op: "create" }, { body: create });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call("POST", { op: "create" }, { body: create })).status, 409);

  // stranger cannot read; parties can
  assert.equal((await call("GET", { op: "case", id: caseId }, { w: stranger })).status, 403);
  assert.equal((await call("GET", { op: "case", id: caseId })).status, 401);
  for (const w of [client, contractor, reviewer]) assert.equal((await call("GET", { op: "case", id: caseId }, { w })).status, 200);
  const list = await call("GET", { op: "list" }, { w: reviewer });
  assert.equal(list.body.cases[0].role, "reviewer");

  // job link needs the contractor's signature first
  jobs.set("7", { client: client.address, provider: contractor.address, evaluator: EVALUATOR, escrow: ethers.parseUnits("30", 18), state: 1, specHash: await chain.specHashFor(EVALUATOR, checklistHash, 2) });
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "job.link", { milestone: "M1", jobId: "7" }) })).body.error, "not_signed");
  // client cannot sign as contractor
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "checklist.sign", { checklistHash }) })).status, 403);
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(contractor, caseId, "checklist.sign", { checklistHash }) })).status, 201);

  // wrong spec (item count of another milestone) is refused; then the three milestone jobs link
  jobs.set("8", { ...jobs.get("7"), escrow: ethers.parseUnits("20", 18) });
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "job.link", { milestone: "M3", jobId: "8" }) })).body.error, "chain_mismatch");
  jobs.set("9", { ...jobs.get("7"), escrow: ethers.parseUnits("50", 18), specHash: await chain.specHashFor(EVALUATOR, checklistHash, 5) });
  jobs.set("8", { ...jobs.get("7"), escrow: ethers.parseUnits("20", 18), specHash: await chain.specHashFor(EVALUATOR, checklistHash, 2) });
  for (const [m, id] of [["M1", "7"], ["M2", "8"], ["M3", "9"]]) {
    r = await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "job.link", { milestone: m, jobId: id }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // wrong amount
  jobs.set("10", { ...jobs.get("7"), escrow: 1n });

  // upload: party only; evidence must reference uploaded files
  const photo = new TextEncoder().encode("fake jpeg bytes");
  assert.equal((await call("POST", { op: "upload", id: caseId }, { w: stranger, body: photo, ctype: "image/jpeg" })).status, 403);
  const up = await call("POST", { op: "upload", id: caseId }, { w: contractor, body: photo, ctype: "image/jpeg" });
  assert.equal(up.status, 201);
  assert.equal(up.body.sha256, ethers.sha256(photo));
  const ghost = await sign(contractor, caseId, "evidence", { milestone: "M2", itemId: "m2-scaffold", files: [{ name: "x.jpg", sha256: ethers.ZeroHash.replace(/0$/, "1"), size: 1, type: "image/jpeg" }] });
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: ghost })).body.error, "missing_file");
  const file = { name: "scaffold-north.jpg", sha256: up.body.sha256, size: photo.length, type: "image/jpeg" };
  const ev1 = await sign(contractor, caseId, "evidence", { milestone: "M2", itemId: "m2-scaffold", files: [file], note: "north side" });
  r = await call("POST", { op: "record", id: caseId }, { body: ev1 });
  assert.equal(r.status, 201);
  const ev1hash = r.body.hash;
  // client asks for more, contractor adds, client approves
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "review", { itemId: "m2-scaffold", evidenceRecord: ev1hash, decision: "need_more", note: "" }) })).status, 400);
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "review", { itemId: "m2-scaffold", evidenceRecord: ev1hash, decision: "need_more", note: "south side missing" }) })).status, 201);
  let st = (await call("GET", { op: "case", id: caseId }, { w: client })).body.state;
  assert.equal(st.items["m2-scaffold"].status, "need_more");
  const ev2 = await call("POST", { op: "record", id: caseId }, { body: await sign(contractor, caseId, "evidence", { milestone: "M2", itemId: "m2-scaffold", files: [file], note: "south side" }) });
  st = (await call("GET", { op: "case", id: caseId }, { w: client })).body.state;
  assert.equal(st.items["m2-scaffold"].status, "updated");
  await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "review", { itemId: "m2-scaffold", evidenceRecord: ev2.body.hash, decision: "approved" }) });
  st = (await call("GET", { op: "case", id: caseId }, { w: contractor })).body.state;
  assert.equal(st.items["m2-scaffold"].status, "approved");

  // package refused while an item has no evidence; accepted when complete, and hashes are reproducible
  let pkg = core.packageFor(core.deriveCase(st.records), "M2");
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(contractor, caseId, "package", { ...pkg, jobId: "8", checklistHash }) })).body.error, "incomplete");
  await call("POST", { op: "record", id: caseId }, { body: await sign(contractor, caseId, "evidence", { milestone: "M2", itemId: "m2-main", files: [file] }) });
  st = (await call("GET", { op: "case", id: caseId }, { w: contractor })).body.state;
  pkg = core.packageFor(core.deriveCase(st.records), "M2");
  assert.equal(pkg.itemHashes.length, 2);
  assert.ok(pkg.itemHashes.every((h) => h !== ethers.ZeroHash));
  assert.equal(pkg.manifestSha256, ethers.sha256(core.manifestOf(checklistHash, pkg.itemHashes)));
  const tampered = { ...pkg, itemHashes: [pkg.itemHashes[1], pkg.itemHashes[0]], jobId: "8" };
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(contractor, caseId, "package", tampered) })).status, 400);
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(contractor, caseId, "package", { ...pkg, jobId: "8" }) })).status, 201);

  // objection: text must match its hash; only the client; must name a linked job
  const text = "マニフェストの写し（木くず）がありません。";
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "objection", { jobId: "8", text, textHash: ethers.ZeroHash, itemIds: ["m2-main"] }) })).status, 400);
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "objection", { jobId: "99", text, textHash: core.textHash(text) }) })).body.error, "not_linked");
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(contractor, caseId, "objection", { jobId: "8", text, textHash: core.textHash(text) }) })).status, 403);
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "objection", { jobId: "8", text, textHash: core.textHash(text), itemIds: ["m2-main"] }) })).status, 201);
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(contractor, caseId, "answer", { jobId: "8", text: "added the photo", itemIds: ["m2-main"] }) })).status, 201);
  // only the reviewer decides
  const dtext = "Evidence supports the contractor. Pay.";
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(client, caseId, "decision", { jobId: "8", payProvider: false, text: dtext, decisionHash: core.textHash(dtext) }) })).status, 403);
  assert.equal((await call("POST", { op: "record", id: caseId }, { body: await sign(reviewer, caseId, "decision", { jobId: "8", payProvider: true, text: dtext, decisionHash: core.textHash(dtext), itemIds: ["m2-main"] }) })).status, 201);
  st = (await call("GET", { op: "case", id: caseId }, { w: reviewer })).body.state;
  assert.equal(st.objections.length, 1);
  assert.equal(st.objections[0].payload.text, text);
  assert.equal(st.decisions[0].payload.payProvider, true);
  assert.equal(st.milestones.find((m) => m.key === "M2").packages.length, 1);

  // file read: party only, served with nosniff + sandbox
  assert.equal((await call("GET", { op: "file", id: caseId, sha: file.sha256 }, { w: stranger })).status, 403);
  const f = await call("GET", { op: "file", id: caseId, sha: file.sha256 }, { w: reviewer });
  assert.equal(f.status, 200);
  assert.deepEqual(f.body, photo);
  assert.equal(f.headers.get("x-content-type-options"), "nosniff");
  assert.equal(f.headers.get("content-security-policy"), "sandbox");
});

test("an expired or forged session is refused", async () => {
  const s = { wallet: client.address, issuedAt: now() - 25 * 3600 };
  s.sig = await client.signTypedData(CASE_DOMAIN, SESSION_TYPES, { purpose: SESSION_PURPOSE, ...s });
  assert.throws(() => core.verifySession(btoaUtf8(JSON.stringify(s)), now()), /sign in again/);
  const f = { wallet: client.address, issuedAt: now() };
  f.sig = await stranger.signTypedData(CASE_DOMAIN, SESSION_TYPES, { purpose: SESSION_PURPOSE, ...f });
  assert.throws(() => core.verifySession(btoaUtf8(JSON.stringify(f)), now()), /not signed/);
});

test("a case for other contracts is refused", async () => {
  const id = ethers.hexlify(ethers.randomBytes(16)).slice(2);
  const r = await sign(client, id, "case.create", { caseId: id, client: client.address, contractor: contractor.address, escrow: ESCROW, evaluator: stranger.address, reviewer: reviewer.address, chainId: 31, checklist, checklistHash });
  assert.equal((await call("POST", { op: "create" }, { body: r })).status, 400);
});
