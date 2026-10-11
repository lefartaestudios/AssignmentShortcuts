// About:NotBlank proxy server. Node 18+, no dependencies.
//   node server.js        -> http://localhost:3000
// Env: PORT, PUBLIC_URL (e.g. https://my-proxy.example.com, if behind a reverse proxy)
const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL;

const STRIP = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options",
  "content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie",
  "strict-transport-security", "cross-origin-opener-policy", "cross-origin-embedder-policy",
  "cross-origin-resource-policy", "access-control-allow-origin", "access-control-allow-credentials"]);

// ---- SSRF protection: never let the proxy reach private/internal addresses ----
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
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) URLs are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error("Blocked address");
}

// ---- Follow redirects manually so every hop is checked ----
async function fetchFollow(url, init) {
  let cur = new URL(url);
  for (let i = 0; i < 6; i++) {
    await assertPublic(cur);
    const r = await fetch(cur, { ...init, redirect: "manual" });
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

// ---- Script injected into proxied HTML: sends the page's fetch/XHR through the proxy ----
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

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "x-final-url");
}

async function handleProxy(req, res, reqUrl) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const target = reqUrl.searchParams.get("url");
  if (!target) { res.writeHead(400); return res.end("Missing ?url="); }

  try {
    const headers = {};
    for (const h of ["user-agent", "accept", "accept-language", "content-type", "range"]) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    let body;
    if (!["GET", "HEAD"].includes(req.method)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }
    const { res: r, finalUrl } = await fetchFollow(target, { method: req.method, headers, body });

    for (const [k, v] of r.headers) if (!STRIP.has(k.toLowerCase())) res.setHeader(k, v);
    res.setHeader("x-final-url", finalUrl);
    res.statusCode = r.status;

    const type = r.headers.get("content-type") || "";
    if (type.includes("text/html")) {
      let html = await r.text();
      const proto = req.headers["x-forwarded-proto"] || "http";
      const origin = PUBLIC_URL || `${proto}://${req.headers.host}`;
      const tag = shim(origin, finalUrl);
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
      res.end(html);
    } else {
      res.end(Buffer.from(await r.arrayBuffer()));
    }
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Proxy error: " + e.message);
  }
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/proxy") return handleProxy(req, res, u);
  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  }
  res.writeHead(404); res.end("Not found");
}).listen(PORT, () => console.log(`About:NotBlank running at http://localhost:${PORT}`));
