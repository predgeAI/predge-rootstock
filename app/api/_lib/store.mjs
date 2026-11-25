// Storage for the private case record. Append-only: a record or a file is written once, never overwritten.
//   Vercel: private Vercel Blob store connected to the project (BLOB_READ_WRITE_TOKEN or OIDC + BLOB_STORE_ID).
//   Local dev and tests: a directory (CASE_STORE_DIR).
// Nothing in the store is public: the blob store is private and every read goes through the API's auth check.
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";

export function fsStore(root) {
  const base = resolve(root);
  const p = (key) => {
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) throw new Error("bad key");
    return full;
  };
  return {
    kind: "fs",
    async put(key, bytes, contentType) {
      const f = p(key);
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, bytes, { flag: "wx" }).catch((e) => { if (e.code !== "EEXIST") throw e; });
      await writeFile(f + ".ctype", contentType || "application/octet-stream").catch(() => {});
    },
    async get(key) {
      try {
        const bytes = await readFile(p(key));
        const contentType = await readFile(p(key) + ".ctype", "utf8").catch(() => "application/octet-stream");
        return { bytes: new Uint8Array(bytes), contentType };
      } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    },
    async exists(key) { try { await stat(p(key)); return true; } catch { return false; } },
    async list(prefix) {
      const dir = p(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
      try { return (await readdir(dir)).filter((n) => !n.endsWith(".ctype")).map((n) => prefix + n); } catch { return []; }
    },
  };
}

export async function blobStore() {
  const blob = await import("@vercel/blob");
  return {
    kind: "blob",
    async put(key, bytes, contentType) {
      try {
        await blob.put(key, Buffer.from(bytes), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: contentType || "application/octet-stream" });
      } catch (e) { if (!/already exists/i.test(String(e?.message))) throw e; }
    },
    async get(key) {
      const r = await blob.get(key, { access: "private", useCache: false });
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      const bytes = new Uint8Array(await new Response(r.stream).arrayBuffer());
      return { bytes, contentType: r.blob.contentType || "application/octet-stream" };
    },
    async exists(key) {
      try { return !!(await blob.head(key)); } catch { return false; }
    },
    async list(prefix) {
      const out = [];
      let cursor;
      do {
        const r = await blob.list({ prefix, cursor, limit: 1000 });
        out.push(...r.blobs.map((b) => b.pathname));
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}

export async function storeFromEnv(env = process.env) {
  if (env.CASE_STORE_DIR) return fsStore(env.CASE_STORE_DIR);
  if (env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID) return blobStore();
  return null;
}
