/* Minimal static server for local testing (no deps). */

const http = require("http");
const fs = require("fs");
const path = require("path");

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

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url || "/", "http://local");
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
