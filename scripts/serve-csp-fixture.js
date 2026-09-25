const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.CSP_FIXTURE_PORT) || 8765;
const POLICY = "default-src 'self'; script-src 'self'";
const html = fs.readFileSync(path.join(__dirname, "csp-self-fixture.html"), "utf8");

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/probe.js")) {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end("window.__cspFixtureLoaded = true;\n");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": POLICY,
    "Cache-Control": "no-store",
  });
  res.end(html);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`CSP fixture http://127.0.0.1:${PORT}/ policy: ${POLICY}`);
});
