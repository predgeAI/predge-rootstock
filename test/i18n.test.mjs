// Every UI string exists in EN and JA, with the same {placeholders}; every key the pages use exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DICT } from "../app/i18n.js";
import { GLOSSARY } from "../app/glossary.js";

const files = ["app/job2.html", "app/contractor.html", "app/review.html", "app/pilot.js"].map((f) => [f, readFileSync(new URL("../" + f, import.meta.url), "utf8")]);
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("EN and JA have the same keys and placeholders", () => {
  const en = Object.keys(DICT.en).sort(), ja = Object.keys(DICT.ja).sort();
  assert.deepEqual(ja.filter((k) => !DICT.en[k]), [], "keys only in JA");
  assert.deepEqual(en.filter((k) => !DICT.ja[k]), [], "keys missing in JA");
  for (const k of en) assert.equal(ph(DICT.ja[k]), ph(DICT.en[k]), `placeholders differ for ${k}`);
});

test("every key used by the pages exists", () => {
  const used = new Set();
  for (const [, src] of files) {
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-html|-ph)?="([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-title="([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !k.endsWith(".") && !DICT.en[k]);
  assert.deepEqual(missing, []);
  assert.ok(used.size > 150, `only ${used.size} keys found`);
});

test("dynamic key families are complete", () => {
  const fam = { "jst.": ["None", "Open", "Submitted", "Completed", "Rejected", "Expired"], "jshort.": ["None", "Open", "Submitted", "Completed", "Rejected", "Expired"],
    "ms.st.": ["None", "Open", "Submitted", "Completed", "Rejected", "Expired", "onHold", "silent"], "item.st.": ["missing", "submitted", "updated", "approved", "need_more"],
    "role.": ["client", "contractor", "reviewer"], "kind.": ["case.create", "checklist.sign", "job.link", "evidence", "review", "package", "objection", "answer", "decision"], "hist.review.": ["approved", "need_more"] };
  for (const [p, ks] of Object.entries(fam)) for (const k of ks) assert.ok(DICT.en[p + k] && DICT.ja[p + k], p + k);
});

test("glossary entries are filled in both languages", () => {
  for (const g of GLOSSARY) assert.ok(g.en && g.ja, JSON.stringify(g));
  const terms = GLOSSARY.map((g) => g.en).join(" ");
  for (const w of ["completion", "acceptance", "objection", "manifest", "milestone", "evidence"]) assert.ok(terms.includes(w), w);
});
