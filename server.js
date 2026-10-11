// Assignment Shortcuts / About:NotBlank: proxy server. Node 18+, no dependencies.
//
//   node server.js            -> http://localhost:3000
//
// Environment variables (all optional):
//   PORT             port to listen on (default 3000)
//   PUBLIC_URL       this server's public address, if it sits behind a reverse proxy
//   ALLOWED_ORIGINS  comma-separated list of sites allowed to call /proxy from a browser
//                    (default "*", which lets any site use it; set this when you deploy)
//   RATE_LIMIT       requests per minute per visitor (default 120)
//   TRUST_PROXY      set to 1 to read the visitor's address from X-Forwarded-For
//
// Endpoints
//   GET /proxy?url=<address>
//       The page or file exactly as the site sent it, with CORS headers and an
//       X-Final-URL header holding the address after redirects. index.html uses this
//       when PROXY_URL points at this server.
//   GET /proxy?mode=browse&url=<address>
//       Same, but HTML also gets a script that sends the page's own fetch/XHR calls back
//       through the proxy. Used by the "Show in frame" button.
//   GET /health        returns "ok"
//   GET /              serves index.html (and /favicon.ico) from this folder
const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL;
const ALLOWED = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 120;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const MAX_REDIRECTS = 6;
const TIMEOUT_MS = 25000;
const MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_UA = "Mozilla/5.0 (compatible; AssignmentShortcuts/2.0)";

// Headers that must not be passed on: they would block framing, tie the response to the
// proxy's own connection, or leak cookies and CORS rules from the real site.
const STRIP = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options",
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie",
  "strict-transport-security", "cross-origin-opener-policy", "cross-origin-embedder-policy",
  "cross-origin-resource-policy", "access-control-allow-origin", "access-control-allow-credentials",
  "access-control-allow-methods", "access-control-allow-headers", "access-control-expose-headers"]);

// ---- Visitors: a simple per-address rate limit ----
const hits = new Map();
function limited(req) {
  const fwd = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  const who = fwd || req.socket.remoteAddress || "?";
  const now = Date.now();
  let h = hits.get(who);
  if (!h || now > h.reset) { h = { n: 0, reset: now + 60000 }; hits.set(who, h); }
  h.n++;
  return h.n > RATE_LIMIT;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60000).unref();

// ---- SSRF protection: never let the proxy reach private or internal addresses ----
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80")) return true;
  if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
  return false;
}
async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https addresses are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error("That address is not allowed");
}

// ---- Follow redirects by hand so every hop is checked, and report where we ended up ----
async function fetchFollow(url, init) {
  let cur = new URL(url);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublic(cur);
    const r = await fetch(cur, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      cur = new URL(loc, cur);
      if ([301, 302, 303].includes(r.status) && init.method !== "GET" && init.method !== "HEAD") {
        init = { ...init, method: "GET", body: undefined };
      }
      continue;
    }
    return { res: r, finalUrl: cur.href };
  }
  throw new Error("Too many redirects");
}

// ---- Browse mode: sends the page's fetch/XHR back through the proxy ----
function shim(proxyOrigin, baseUrl) {
  const code = `(function(){var P=${JSON.stringify(proxyOrigin)},B=${JSON.stringify(baseUrl)};
function w(u){try{var a=new URL(u,B);if(!/^https?:$/.test(a.protocol)||a.href.indexOf(P+"/")===0)return u;
return P+"/proxy?url="+encodeURIComponent(a.href);}catch(e){return u}}
var f=window.fetch;window.fetch=function(i,o){
if(typeof i==="string"||i instanceof URL)return f.call(this,w(String(i)),o);
if(i&&i.url)return f.call(this,new Request(w(i.url),i),o);return f.apply(this,arguments)};
var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=w(String(u));return x.apply(this,arguments)};
})();`;
  return "<script>" + code.replace(/<\//g, "<\\/") + "</script>";
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && ALLOWED.includes(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "x-final-url");
}

function fail(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: message }));
}

async function handleProxy(req, res, reqUrl) {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (limited(req)) return fail(res, 429, "Too many requests. Slow down and try again in a minute.");
  const target = reqUrl.searchParams.get("url");
  if (!target) return fail(res, 400, "Missing ?url=");
  try { new URL(target); } catch (e) { return fail(res, 400, "That is not a valid address"); }
  const browse = reqUrl.searchParams.get("mode") === "browse";

  try {
    const headers = { "user-agent": DEFAULT_UA };
    for (const h of ["user-agent", "accept", "accept-language", "content-type", "range"]) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    let body;
    if (!["GET", "HEAD"].includes(req.method)) {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_BYTES) return fail(res, 413, "Request too large"); chunks.push(c); }
      body = Buffer.concat(chunks);
    }
    const { res: r, finalUrl } = await fetchFollow(target, { method: req.method, headers, body });

    const declared = Number(r.headers.get("content-length"));
    if (declared > MAX_BYTES) return fail(res, 413, "That file is too large for the proxy");

    for (const [k, v] of r.headers) if (!STRIP.has(k.toLowerCase())) res.setHeader(k, v);
    res.setHeader("x-final-url", finalUrl);
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = r.status;
    if (req.method === "HEAD") return res.end();

    const type = r.headers.get("content-type") || "";
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) return fail(res, 413, "That file is too large for the proxy");

    if (browse && type.includes("text/html")) {
      let html = buf.toString("utf8");
      const proto = req.headers["x-forwarded-proto"] || "http";
      const origin = PUBLIC_URL || `${proto}://${req.headers.host}`;
      const tag = shim(origin, finalUrl);
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(html);
    }
    res.end(buf);
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    fail(res, timedOut ? 504 : 502, timedOut ? "The site took too long to answer" : "Proxy error: " + e.message);
  }
}

const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/favicon.ico": ["favicon.ico", "image/x-icon"],
};

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/proxy") return handleProxy(req, res, u);
  if (u.pathname === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
  const f = FILES[u.pathname];
  if (f) {
    const file = path.join(__dirname, f[0]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": f[1] });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end("Not found");
}).listen(PORT, () => console.log(`Assignment Shortcuts proxy running at http://localhost:${PORT}`));
