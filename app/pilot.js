// Shared by job2.html (client), contractor.html and review.html: config, wallet, i18n, contracts, case record API.
import { makeCore, byArrival, CASE_DOMAIN, RECORD_TYPES, SESSION_TYPES, SESSION_PURPOSE, MAX_FILE_BYTES, btoaUtf8, lc } from "./case-core.js";
import { DICT } from "./i18n.js";

export const { ethers } = window;
export const core = makeCore(ethers);
export const $ = (id) => document.getElementById(id);
export const params = new URLSearchParams(location.search);
export const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

// ---------------------------------------------------------------- config (Rootstock testnet; overrides only on localhost, for a local fork)
const PUBLIC_RPC = "https://public-node.testnet.rsk.co";
export const CFG = {
  CHAIN_ID: 31, CHAIN_HEX: "0x1f", PUBLIC_RPC,
  EXPLORER: "https://rootstock-testnet.blockscout.com",
  RPC: (isLocal && params.get("rpc")) || PUBLIC_RPC,
  JOB_ADDR: (isLocal && params.get("escrow")) || "0x15C790fb445dc8Ed00aca65e424e26CDeB1999A0",
  // USDRIF, lower-cased: the explorer spelling uses the Rootstock EIP-1191 checksum, which ethers rejects.
  TOKEN_ADDR: "0x8dbf326e12a9ff37ed6ddf75ada548c2640a6482",
  EVALUATOR: (isLocal && params.get("evaluator")) || "0xca4E20f5903f795374B96331011Aaa24C45f6316",
  API: "/api/case",
};
export const FORK = CFG.RPC !== PUBLIC_RPC;

// Local fork testing only: an injected test wallet that forwards to anvil's unlocked dev accounts.
if (isLocal && params.has("devwallet")) await import("./dev-wallet.js").then((m) => m.install(CFG.RPC, Number(params.get("devwallet") || 0)));

export const JOB_ABI = [
  "function createJob(address provider, address evaluator, bytes32 specHash, uint64 expiredAt, uint256 amount) returns (uint256 jobId)",
  "function getJob(uint256 jobId) view returns ((address client, address provider, address evaluator, uint256 escrow, uint64 expiredAt, uint64 submittedAt, uint8 state, bool hashedOnChain, bytes32 specHash, bytes32 deliverable, bytes32 reason))",
  "function submit(uint256 jobId, bytes32 deliverable, bytes output)",
  "function jobCount() view returns (uint256)", "function credit(address) view returns (uint256)", "function evaluationWindow() view returns (uint64)",
  "function claimRefund(uint256 jobId)", "function withdraw()",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed evaluator, address provider, uint256 escrow, uint64 expiredAt, bytes32 specHash)",
  "error BadExpiry()", "error BadState()", "error EvaluatorNotIndependent()", "error NotExpired()", "error NothingToWithdraw()", "error NotProvider()", "error HashMismatch()", "error ZeroDeliverable()",
  "error PastDeadline()", "error Reentrancy()", "error TransferFailed()", "error UnexpectedAmountReceived(uint256 expected, uint256 received)",
  "error ZeroAddress()", "error ZeroEscrow()", "error ZeroRecipient()", "error NotEvaluator()",
];
export const EV_ABI = [
  "function object(uint256 jobId, bytes32 objectionHash)",
  "function objectionOf(uint256 jobId) view returns ((bytes32 hash, uint64 at, bool resolved))",
  "function objectionPeriod() view returns (uint64)", "function evaluationWindow() view returns (uint64)",
  "function job() view returns (address)", "function reviewer() view returns (address)",
  "function specHashFor(bytes32 checklistDocHash, uint256 items) view returns (bytes32)",
  "function releaseOnSilence(uint256 jobId, bytes32 checklistDocHash, bytes32[] fileHashes)",
  "function resolve(uint256 jobId, bool payProvider, bytes32 decisionHash)",
  "error AlreadyObjected()", "error BadState()", "error NotClient()", "error NotOurJob()", "error ObjectionPeriodOver()", "error ZeroHash()",
  "error NotReviewer()", "error ReviewerIsParty()", "error NoObjection()", "error AlreadyResolved()", "error ObjectionPeriodRunning()", "error OnHold()", "error IncompletePackage()",
];
export const ERC20_ABI = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];

export const read = new ethers.JsonRpcProvider(CFG.RPC, CFG.CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 });
export const jobR = new ethers.Contract(CFG.JOB_ADDR, JOB_ABI, read);
export const tokenR = new ethers.Contract(CFG.TOKEN_ADDR, ERC20_ABI, read);
export const evR = (a = CFG.EVALUATOR) => new ethers.Contract(a, EV_ABI, read);
const errIface = new ethers.Interface([...JOB_ABI, ...EV_ABI].filter((x) => x.startsWith("error")));
export const STATE = ["None", "Open", "Submitted", "Completed", "Rejected", "Expired"];

// ---------------------------------------------------------------- i18n (EN / JA)
let lang = (() => {
  const q = params.get("lang");
  if (q === "ja" || q === "en") return q;
  try { const s = localStorage.getItem("predge-lang"); if (s === "ja" || s === "en") return s; } catch {}
  return /^ja\b/i.test(navigator.language || "") ? "ja" : "en";
})();
export const getLang = () => lang;
export function t(key, vars = {}) {
  let s = DICT[lang]?.[key] ?? DICT.en[key];
  if (s === undefined) { console.warn("i18n missing", key); return key; }
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}
export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  if (document.body.dataset.title) document.title = t(document.body.dataset.title);
  document.querySelectorAll("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
}
const langListeners = [];
export const onLang = (f) => langListeners.push(f);
export function setLang(l) {
  lang = l;
  try { localStorage.setItem("predge-lang", l); } catch {}
  const u = new URL(location.href); u.searchParams.set("lang", l); history.replaceState(null, "", u);
  applyI18n();
  langListeners.forEach((f) => f());
}
export function bindLangSwitch() {
  document.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));
  applyI18n();
}

// ---------------------------------------------------------------- formatting
export let decimals = 18n;
tokenR.decimals().then((d) => { decimals = BigInt(d); }).catch(() => {});
const nf = () => (lang === "ja" ? "ja-JP" : "en-US");
export const fmtTok = (v) => Number(ethers.formatUnits(v, decimals)).toLocaleString(nf(), { maximumFractionDigits: 6 }) + " USDRIF";
export const fmtRbtc = (v) => Number(ethers.formatEther(v)).toLocaleString(nf(), { maximumFractionDigits: 8 }) + " tRBTC";
export const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const txLink = (h) => `<a href="${CFG.EXPLORER}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>`;
export const addrLink = (a) => FORK ? `<span class="mono">${a}</span>` : `<a href="${CFG.EXPLORER}/address/${a}" target="_blank" rel="noopener">${a}</a>`;
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
export function fmtTime(ts) {
  const d = new Date(Number(ts) * 1000);
  const local = new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-GB", { timeZone: TZ, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(d);
  return { utc: d.toISOString().replace(".000Z", "").replace("T", " "), local };
}
export function left(s) {
  if (s <= 0) return t("time.passed");
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return t("time.left", { d: d ? t("time.days", { d }) : "", h, m });
}
export function show(id, kind, html) { const el = typeof id === "string" ? $(id) : id; if (el) el.innerHTML = html ? `<div class="msg ${kind}">${html}</div>` : ""; }
export function addr(v, what) {
  const s = String(v || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(t("err.badAddress", { what }));
  return ethers.getAddress(s.toLowerCase()); // ignore checksum case (Rootstock and Ethereum checksums differ)
}
export function explain(e) {
  if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001 || e?.error?.code === 4001) return t("err.rejected");
  if (e?.revert?.name) return DICT.en["rv." + e.revert.name] ? t("rv." + e.revert.name) : `Reverted: ${e.revert.name}`;
  const datas = [e?.data, e?.info?.error?.data, e?.error?.data, e?.info?.error?.data?.data, e?.error?.data?.data];
  for (const d of datas) {
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
      try { const p = errIface.parseError(d); if (p) return DICT.en["rv." + p.name] ? t("rv." + p.name) : `Reverted: ${p.name}`; } catch {}
    }
  }
  if (e?.caseApi) return esc(e.message);
  const m = e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  if (/insufficient funds/i.test(m)) return t("err.noGas");
  return esc(m);
}

// ---------------------------------------------------------------- wallet
export const W = { account: null, signer: null };
async function ensureChain(eth) {
  const cur = await eth.request({ method: "eth_chainId" });
  if (parseInt(cur, 16) === CFG.CHAIN_ID) return;
  try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG.CHAIN_HEX }] }); }
  catch (e) {
    if (e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not been added/i.test(e?.message || "")) {
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: CFG.CHAIN_HEX, chainName: "Rootstock Testnet", nativeCurrency: { name: "Test RBTC", symbol: "tRBTC", decimals: 18 }, rpcUrls: [PUBLIC_RPC], blockExplorerUrls: [CFG.EXPLORER] }] });
    } else throw e;
  }
}
export async function connectWallet() {
  const eth = window.ethereum;
  if (!eth) throw Object.assign(new Error(t("err.noMetaMask")), { html: true });
  const accs = await eth.request({ method: "eth_requestAccounts" });
  await ensureChain(eth);
  const bp = new ethers.BrowserProvider(eth, "any");
  W.signer = await bp.getSigner(accs[0]);
  W.account = ethers.getAddress(String(accs[0]).toLowerCase());
  if (!eth._predgeHooked && eth.on) {
    eth._predgeHooked = true;
    eth.on("accountsChanged", () => location.reload());
    eth.on("chainChanged", () => location.reload());
  }
  return W.account;
}
export const isMe = (a) => !!W.account && lc(a) === lc(W.account);

// Rootstock has no EIP-1559: legacy type-0 tx with an explicit gas price, like lib/rsk.mjs and the CLI.
export async function txOpts(estimate) {
  const gp = (BigInt(await read.send("eth_gasPrice", [])) * 12n) / 10n;
  const gas = await estimate;
  return { type: 0, gasPrice: gp, gasLimit: (gas * 13n) / 10n + 10000n };
}
export async function waitFor(tx, label, box) {
  show(box, "info", t("tx.sent", { label, link: txLink(tx.hash) }));
  for (let i = 0; i < 180; i++) {
    const rc = await read.getTransactionReceipt(tx.hash);
    if (rc) { if (rc.status !== 1) throw new Error(t("tx.failed", { label, link: txLink(tx.hash) })); return rc; }
    await new Promise((r) => setTimeout(r, FORK ? 300 : 4000));
  }
  throw new Error(t("tx.slow", { label, link: txLink(tx.hash) }));
}

// ---------------------------------------------------------------- case record API (signatures only: no gas)
const sessKey = () => `predge-case-session:${lc(W.account)}`;
export async function session() {
  if (!W.account) throw new Error(t("err.connectFirst"));
  try {
    const s = JSON.parse(sessionStorage.getItem(sessKey()) || "null");
    if (s && Date.now() / 1000 - s.issuedAt < 23 * 3600) return btoaUtf8(JSON.stringify(s));
  } catch {}
  const s = { wallet: W.account, issuedAt: Math.floor(Date.now() / 1000) };
  s.sig = await W.signer.signTypedData(CASE_DOMAIN, SESSION_TYPES, { purpose: SESSION_PURPOSE, ...s });
  try { sessionStorage.setItem(sessKey(), JSON.stringify(s)); } catch {}
  return btoaUtf8(JSON.stringify(s));
}
async function apiCall(q, { method = "GET", body, auth = false, ctype } = {}) {
  const headers = {};
  if (auth) headers["x-case-session"] = await session();
  if (ctype) headers["content-type"] = ctype;
  const res = await fetch(`${CFG.API}?${new URLSearchParams(q)}`, { method, headers, body });
  if ((res.headers.get("content-type") || "").includes("json")) {
    const j = await res.json();
    if (!res.ok) {
      if (res.status === 401) try { sessionStorage.removeItem(sessKey()); } catch {}
      throw Object.assign(new Error(t("api.err", { msg: j.message || j.error })), { caseApi: true, code: j.error, status: res.status });
    }
    return j;
  }
  if (!res.ok) throw Object.assign(new Error(t("api.err", { msg: res.status })), { caseApi: true });
  return res;
}
export const api = {
  config: () => apiCall({ op: "config" }),
  list: () => apiCall({ op: "list" }, { auth: true }),
  getCase: (id) => apiCall({ op: "case", id }, { auth: true }),
  async upload(id, file) {
    if (file.size > MAX_FILE_BYTES) throw Object.assign(new Error(t("up.tooLarge", { name: file.name, mb: MAX_FILE_BYTES / 1048576 })), { caseApi: true });
    return apiCall({ op: "upload", id }, { method: "POST", auth: true, body: file, ctype: file.type || "application/octet-stream" });
  },
  async file(id, sha) { const r = await apiCall({ op: "file", id, sha }, { auth: true }); return r.blob(); },
};
/** Sign a record with the connected wallet (EIP-712: MetaMask shows the summary and the hash) and store it. */
export async function signAndPost(caseId, kind, payload, summary, { create = false } = {}) {
  const r = { caseId, kind, summary, payload, issuedAt: Math.floor(Date.now() / 1000), signer: lc(W.account) };
  r.sig = await W.signer.signTypedData(CASE_DOMAIN, RECORD_TYPES, core.typedRecord(r));
  return apiCall(create ? { op: "create" } : { op: "record", id: caseId }, { method: "POST", body: JSON.stringify(r), ctype: "application/json" });
}
export async function sha256File(file) { return ethers.sha256(new Uint8Array(await file.arrayBuffer())); }

// ---------------------------------------------------------------- shared rendering
export const itemStatusBadge = (s) => `<span class="pill st-${s}">${esc(t("item.st." + s))}</span>`;
export function fileLinks(caseId, files) {
  return files.map((f) => `<button type="button" class="link" data-open="${esc(f.sha256)}" data-case="${esc(caseId)}" data-name="${esc(f.name)}" title="sha256 ${esc(f.sha256)}">${esc(f.name)}</button>`).join(" ");
}
/** Opens a private file (fetched with the session, never a public URL) and checks its sha256 against the record. */
export function bindFileOpen(root, onMsg) {
  root.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-open]");
    if (!b) return;
    ev.preventDefault();
    try {
      const blob = await api.file(b.dataset.case, b.dataset.open);
      const sha = ethers.sha256(new Uint8Array(await blob.arrayBuffer()));
      const ok = sha === b.dataset.open;
      onMsg?.(ok ? "ok" : "err", t(ok ? "file.hashOk" : "file.hashBad", { name: esc(b.dataset.name) }));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener";
      if (!/^(image\/|application\/pdf|text\/plain)/.test(blob.type)) a.download = b.dataset.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { onMsg?.("err", explain(e)); }
  });
}
export function recordWho(st, signer) {
  const s = lc(signer);
  return s === st.client ? t("role.client") : s === st.contractor ? t("role.contractor") : s === st.reviewer ? t("role.reviewer") : short(s);
}
/** Item history (evidence + reviews, oldest first) for the reviewer and both parties. */
export function itemHistory(st, it) {
  const rows = [...it.uploads, ...it.reviews].sort(byArrival);
  if (!rows.length) return `<p class="hint">${esc(t("item.noEvidence"))}</p>`;
  return `<ol class="hist">` + rows.map((r) => {
    const when = fmtTime(r.issuedAt).local;
    if (r.kind === "evidence") return `<li><b>${esc(t("hist.evidence"))}</b> · ${esc(when)} · ${esc(recordWho(st, r.signer))}<br>${fileLinks(st.caseId, r.payload.files)}${r.payload.note ? `<br><span class="note">${esc(r.payload.note)}</span>` : ""}</li>`;
    return `<li><b>${esc(t("hist.review." + r.payload.decision))}</b> · ${esc(when)} · ${esc(recordWho(st, r.signer))}${r.payload.note ? `<br><span class="note">${esc(r.payload.note)}</span>` : ""}</li>`;
  }).join("") + `</ol>`;
}
export function itemSpec(it) {
  return `<dl class="spec"><dt>${esc(t("cl.evidence"))}</dt><dd>${esc(it.evidence)}</dd><dt>${esc(t("cl.viewpoint"))}</dt><dd>${esc(it.viewpoint)}</dd><dt>${esc(t("cl.timing"))}</dt><dd>${esc(it.timing)}</dd></dl>`;
}
/** On-chain status of the milestone jobs of a case. */
export async function chainJobs(st) {
  const ev = evR(st.evaluator);
  const [period, blk] = await Promise.all([ev.objectionPeriod(), read.getBlock("latest")]);
  const out = {};
  for (const m of st.milestones) {
    if (!m.job) continue;
    const id = BigInt(m.job.jobId);
    const [j, o] = await Promise.all([jobR.getJob(id), ev.objectionOf(id)]);
    out[m.key] = { id: m.job.jobId, j, o: { hash: o.hash, at: Number(o[1]), resolved: o.resolved }, objected: o.hash !== ethers.ZeroHash, state: STATE[Number(j.state)], objEnd: Number(j.submittedAt) + Number(period) };
  }
  return { jobs: out, now: blk.timestamp, period: Number(period) };
}
export function jobStateText(cj, now) {
  if (!cj) return t("ms.noJob");
  if (cj.state === "Submitted" && cj.objected && !cj.o.resolved) return t("ms.st.onHold");
  if (cj.state === "Submitted" && now >= cj.objEnd) return t("ms.st.silent");
  return t("ms.st." + cj.state);
}
export function devBanner() {
  if (!isLocal || (!FORK && !params.has("devwallet"))) return;
  const d = document.createElement("div");
  d.className = "devbar";
  d.textContent = `LOCAL TEST${FORK ? " · fork RPC " + CFG.RPC : ""}${params.has("devwallet") ? " · dev wallet #" + (params.get("devwallet") || 0) : ""} · escrow ${short(CFG.JOB_ADDR)}`;
  document.body.prepend(d);
}
export { lc, MAX_FILE_BYTES };
