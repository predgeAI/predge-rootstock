// The private case record API. One function, routed by `op`:
//   GET  ?op=config                       public: which contracts this deployment serves
//   POST ?op=create                       body: signed case.create record (the client)
//   POST ?op=record&id=<caseId>           body: a signed record (party; role checked per kind)
//   POST ?op=upload&id=<caseId>           body: file bytes; header x-case-session (party)
//   GET  ?op=case&id=<caseId>             header x-case-session (party): records + derived state
//   GET  ?op=list                         header x-case-session: cases where the wallet is a party
//   GET  ?op=file&id=<caseId>&sha=<0x..>  header x-case-session (party): file bytes
// "Party" = the case's client, contractor, or the reviewer of the case's objection contract. Nobody else
// can read anything; there is no admin read path in this API.
import { ethers } from "ethers";
import { makeCore, CaseError, MAX_FILE_BYTES, lc } from "../../case-core.js";

const core = makeCore(ethers);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const CASE_ID = /^[0-9a-f]{32}$/;
const SHA = /^0x[0-9a-f]{64}$/;
const SAFE_TYPES = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf|text\/plain|video\/mp4)$/;

export function createHandler({ store, chain, config, now = () => Math.floor(Date.now() / 1000) }) {
  const recKey = (id, r) => `cases/${id}/r/${String(r.receivedAt).padStart(15, "0")}-${r.hash.slice(2)}.json`;
  const fileKey = (id, sha) => `cases/${id}/f/${sha.slice(2)}`;

  async function loadRecords(id) {
    const keys = await store.list(`cases/${id}/r/`);
    const recs = await Promise.all(keys.map(async (k) => JSON.parse(new TextDecoder().decode((await store.get(k)).bytes))));
    return recs;
  }
  async function loadCase(id) {
    if (!CASE_ID.test(id || "")) throw new CaseError("bad_id", "bad case id", 400);
    const recs = await loadRecords(id);
    if (!recs.length) throw new CaseError("no_case", "case not found", 404);
    return { recs, st: core.deriveCase(recs) };
  }
  const isParty = (st, a) => [st.client, st.contractor, st.reviewer].includes(lc(a));
  async function saveRecord(id, r, prev = []) {
    // arrival order defines the record order (item hashes depend on it): strictly increasing per case
    r.receivedAt = Math.max(Date.now(), ...prev.map((x) => (x.receivedAt || 0) + 1));
    await store.put(recKey(id, r), new TextEncoder().encode(JSON.stringify(r)), "application/json");
  }
  function session(req) {
    const tok = req.headers.get("x-case-session");
    if (!tok) throw new CaseError("no_session", "sign in first", 401);
    return core.verifySession(tok, now());
  }
  const parseAmount = (s) => ethers.parseUnits(String(s), 18);

  return async function handle(req) {
    try {
      const url = new URL(req.url);
      const op = url.searchParams.get("op");
      const id = url.searchParams.get("id");
      if (req.method === "GET" && op === "config") return json(200, { chainId: 31, escrow: config.escrow, evaluator: config.evaluator, storage: store?.kind ?? null });
      if (!store) throw new CaseError("no_storage", "the case record storage is not configured on this deployment", 503);

      if (req.method === "POST" && (op === "create" || op === "record")) {
        const text = await req.text();
        if (text.length > 60000) throw new CaseError("too_large", "record too large", 413);
        const r = JSON.parse(text);
        const { hash: _ignored, ...clean } = r;
        const rec = { caseId: clean.caseId, kind: clean.kind, summary: clean.summary, payload: clean.payload, issuedAt: clean.issuedAt, signer: lc(clean.signer), sig: clean.sig };
        rec.hash = core.verifyRecord(rec);
        if (rec.issuedAt > now() + 300 || now() - rec.issuedAt > 3600) throw new CaseError("stale", "the signature is too old or in the future; sign again", 400);
        if (op === "create") {
          if ((await store.list(`cases/${rec.caseId}/r/`)).length) throw new CaseError("exists", "case already exists", 409);
          await core.checkCreate(rec, chain, config);
          await saveRecord(rec.caseId, rec);
          const p = rec.payload;
          for (const a of [p.client, p.contractor, p.reviewer]) await store.put(`index/${lc(a)}/${rec.caseId}`, new TextEncoder().encode("1"), "text/plain");
          return json(201, { ok: true, hash: rec.hash, caseId: rec.caseId });
        }
        if (rec.caseId !== id) throw new CaseError("bad_id", "caseId differs from the URL", 400);
        const { recs, st } = await loadCase(id);
        if (recs.some((x) => x.hash === rec.hash)) throw new CaseError("exists", "record already stored", 409);
        const role = await core.checkRecord(st, rec, chain, { parseAmount, fileExists: (sha) => store.exists(fileKey(id, sha)) });
        await saveRecord(id, rec, recs);
        return json(201, { ok: true, hash: rec.hash, role });
      }

      if (req.method === "POST" && op === "upload") {
        const who = session(req);
        const { st } = await loadCase(id);
        if (!isParty(st, who)) throw new CaseError("not_party", "not a party of this case", 403);
        const buf = new Uint8Array(await req.arrayBuffer());
        if (!buf.length) throw new CaseError("empty", "empty file", 400);
        if (buf.length > MAX_FILE_BYTES) throw new CaseError("too_large", `file larger than ${MAX_FILE_BYTES / 1048576} MB`, 413);
        const sha = ethers.sha256(buf);
        const ct = String(req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        await store.put(fileKey(id, sha), buf, SAFE_TYPES.test(ct) ? ct : "application/octet-stream");
        return json(201, { ok: true, sha256: sha, size: buf.length });
      }

      if (req.method === "GET" && op === "case") {
        const who = session(req);
        const { st } = await loadCase(id);
        if (!isParty(st, who)) throw new CaseError("not_party", "not a party of this case", 403);
        return json(200, { you: who, state: st });
      }

      if (req.method === "GET" && op === "list") {
        const who = session(req);
        const ids = (await store.list(`index/${who}/`)).map((k) => k.split("/").pop());
        const out = [];
        for (const cid of ids) {
          try {
            const { st } = await loadCase(cid);
            if (!isParty(st, who)) continue;
            out.push({ caseId: cid, title: st.checklist.title, total: st.checklist.total, createdAt: st.createdAt, client: st.client, contractor: st.contractor, role: who === st.client ? "client" : who === st.contractor ? "contractor" : "reviewer" });
          } catch { /* skip unreadable */ }
        }
        out.sort((a, b) => b.createdAt - a.createdAt);
        return json(200, { you: who, cases: out });
      }

      if (req.method === "GET" && op === "file") {
        const who = session(req);
        const sha = String(url.searchParams.get("sha") || "").toLowerCase();
        if (!SHA.test(sha)) throw new CaseError("bad_sha", "bad sha", 400);
        const { st } = await loadCase(id);
        if (!isParty(st, who)) throw new CaseError("not_party", "not a party of this case", 403);
        const f = await store.get(fileKey(id, sha));
        if (!f) throw new CaseError("no_file", "file not found", 404);
        return new Response(f.bytes, { status: 200, headers: { "content-type": f.contentType, "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "private, no-store" } });
      }
      throw new CaseError("bad_op", "unknown operation", 404);
    } catch (e) {
      if (e instanceof CaseError) return json(e.status, { error: e.code, message: e.message });
      if (e instanceof SyntaxError) return json(400, { error: "bad_json", message: "body is not JSON" });
      console.error("case api", e);
      return json(500, { error: "internal", message: "internal error" });
    }
  };
}
