/* Minimal static server for local testing (no deps). */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8080);
const ROOT = process.cwd();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const clean = decoded.replace(/\0/g, "");
  if (clean.includes("..")) return null;
  return clean;
}

function isLoopback(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

let rebuildInFlight = false;
let rebuildStartedAt = "";
let rebuildFinishedAt = "";
let rebuildExitCode = 0;

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url || "/", "http://local");

    if (u.pathname === "/__rebuild") {
      if (!isLoopback(req.socket.remoteAddress)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
        return;
      }

      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(
          JSON.stringify({
            ok: true,
            inFlight: rebuildInFlight,
            startedAt: rebuildStartedAt,
            finishedAt: rebuildFinishedAt,
            exitCode: rebuildExitCode,
          }),
        );
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
        return;
      }

      if (rebuildInFlight) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: "Rebuild already running" }));
        return;
      }

      rebuildInFlight = true;
      rebuildStartedAt = new Date().toISOString();
      const child = spawn(process.execPath, ["scripts/build-data.mjs"], {
        cwd: ROOT,
        stdio: "inherit",
      });

      const done = (ok, code, error) => {
        rebuildInFlight = false;
        rebuildExitCode = typeof code === "number" ? code : -1;
        rebuildFinishedAt = new Date().toISOString();
        res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(
          JSON.stringify({
            ok,
            code,
            error: error || "",
            startedAt: rebuildStartedAt,
            finishedAt: rebuildFinishedAt,
          }),
        );
      };

      child.on("error", (e) => done(false, -1, String(e && e.message ? e.message : e)));
      child.on("exit", (code) => done(code === 0, typeof code === "number" ? code : -1, ""));
      return;
    }

    let p = safePath(u.pathname);
    if (!p) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (p === "/") p = "/index.html";

    const full = path.join(ROOT, p);
    fs.stat(full, (err, st) => {
      if (err || !st) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const file = st.isDirectory() ? path.join(full, "index.html") : full;
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext] || "application/octet-stream";

      const s = fs.createReadStream(file);
      s.on("error", () => {
        res.writeHead(500);
        res.end("Server error");
      });
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
      });
      s.pipe(res);
    });
  } catch {
    res.writeHead(400);
    res.end("Bad request");
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`http://localhost:${PORT}`);
});
