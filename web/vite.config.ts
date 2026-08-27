import { defineConfig, type Plugin } from "vite";
import { promises as fs } from "node:fs";
import path from "node:path";

const SAVED_MAPS_DIR = path.resolve(__dirname, "saved-maps");

/** Sanitizes a user-supplied save name into a safe filename (no path traversal, no extension games). */
function sanitizeName(raw: string): string | null {
  const name = raw.trim().replace(/[^a-zA-Z0-9а-яА-ЯёЁ _-]/g, "");
  if (!name) return null;
  return name.slice(0, 80);
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

/**
 * Dev-only API so the map editor saves/loads strictly from web/saved-maps/ —
 * no browser "Save As" dialog, no picking a location, just a fixed project folder.
 */
function mapStoragePlugin(): Plugin {
  return {
    name: "civa-map-storage",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/maps")) return next();

        await fs.mkdir(SAVED_MAPS_DIR, { recursive: true });
        const url = new URL(req.url, "http://localhost");
        const segments = url.pathname.split("/").filter(Boolean); // ["api","maps", maybe name]

        try {
          if (req.method === "GET" && segments.length === 2) {
            // GET /api/maps -> list saved maps with mtime
            const files = await fs.readdir(SAVED_MAPS_DIR);
            const entries = await Promise.all(
              files
                .filter((f) => f.endsWith(".json"))
                .map(async (f) => {
                  const stat = await fs.stat(path.join(SAVED_MAPS_DIR, f));
                  return { name: f.replace(/\.json$/, ""), savedAt: stat.mtime.toISOString() };
                })
            );
            entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(entries));
            return;
          }

          if (req.method === "GET" && segments.length === 3) {
            // GET /api/maps/:name -> file contents
            const name = sanitizeName(decodeURIComponent(segments[2]));
            if (!name) return send(res, 400, { error: "bad name" });
            const filePath = path.join(SAVED_MAPS_DIR, `${name}.json`);
            const text = await fs.readFile(filePath, "utf-8").catch(() => null);
            if (text === null) return send(res, 404, { error: "not found" });
            res.setHeader("Content-Type", "application/json");
            res.end(text);
            return;
          }

          if (req.method === "POST" && segments.length === 2) {
            // POST /api/maps  body: { name, data }
            const body = await readJsonBody(req);
            const name = sanitizeName(String(body.name ?? ""));
            if (!name) return send(res, 400, { error: "bad name" });
            const filePath = path.join(SAVED_MAPS_DIR, `${name}.json`);
            await fs.writeFile(filePath, JSON.stringify(body.data, null, 2), "utf-8");
            send(res, 200, { ok: true, name });
            return;
          }

          if (req.method === "DELETE" && segments.length === 3) {
            const name = sanitizeName(decodeURIComponent(segments[2]));
            if (!name) return send(res, 400, { error: "bad name" });
            await fs.unlink(path.join(SAVED_MAPS_DIR, `${name}.json`)).catch(() => {});
            send(res, 200, { ok: true });
            return;
          }

          send(res, 404, { error: "no such route" });
        } catch (err) {
          send(res, 500, { error: String(err) });
        }
      });
    },
  };
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default defineConfig({
  plugins: [mapStoragePlugin()],
});
