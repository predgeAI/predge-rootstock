// Local server for the pilot pages: serves app/ and the case record API with a directory store.
//   node script/pilot-dev-server.mjs [--port 8787] [--store /tmp/cases] [--fork deploy/pilot.local.json]
// With --fork, the API checks cases against the fork's contracts (written by script/pilot-fork.mjs setup).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, mkdtempSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHandler } from "../app/api/_lib/handler.mjs";
import { fsStore } from "../app/api/_lib/store.mjs";
import { rpcChain } from "../app/api/_lib/chain.mjs";
import { DEFAULTS } from "../app/api/case.js";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt("port", 8787));
const storeDir = opt("store", mkdtempSync(join(tmpdir(), "predge-cases-")));
const fork = opt("fork") ? JSON.parse(readFileSync(opt("fork"), "utf8")) : null;
const config = fork ? { escrow: fork.escrow, evaluator: fork.evaluator } : { escrow: DEFAULTS.escrow, evaluator: DEFAULTS.evaluator };
const handle = createHandler({ store: fsStore(storeDir), chain: rpcChain(fork ? fork.rpc : DEFAULTS.rpc), config });
const root = resolve(new URL("../app/", import.meta.url).pathname);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/case") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, body }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const p = resolve(root, "." + (url.pathname === "/" ? "/job2.html" : decodeURIComponent(url.pathname)));
    if (!p.startsWith(root + sep) || p.includes(`${sep}api${sep}`)) { res.writeHead(404).end(); return; }
    const data = await readFile(p);
    res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch (e) { res.writeHead(e.code === "ENOENT" ? 404 : 500).end(String(e.code || "error")); }
}).listen(port, () => console.log(`pilot pages on http://localhost:${port}  store ${storeDir}  contracts ${config.escrow} / ${config.evaluator}${fork ? " (fork)" : ""}`));
