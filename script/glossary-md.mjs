// Writes docs/glossary-ja.md from app/glossary.js (the list the pages use).
import { writeFileSync, mkdirSync } from "node:fs";
import { GLOSSARY } from "../app/glossary.js";

const cell = (s) => String(s).replace(/\|/g, "\\|");
const md = `# Glossary EN / JA (draft for IBUKI's review)

Terms used on the client page (\`app/job2.html\`), the contractor page (\`app/contractor.html\`) and the reviewer
screen (\`app/review.html\`). Generated from \`app/glossary.js\` by \`node script/glossary-md.mjs\`; edit the JS list,
not this file. Hosted as \`glossary.html\` next to the pages.

Please mark any term that is not natural in Japanese demolition work. 解体工事の現場で不自然な用語があればご指摘ください。

| English | 日本語 | Note |
|---|---|---|
${GLOSSARY.map((g) => `| ${cell(g.en)} | ${cell(g.ja)} | ${cell(g.note)} |`).join("\n")}
`;
mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
writeFileSync(new URL("../docs/glossary-ja.md", import.meta.url), md);
console.log(`wrote docs/glossary-ja.md (${GLOSSARY.length} terms)`);
