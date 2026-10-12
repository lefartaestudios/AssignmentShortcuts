// Cloudflare Worker: web proxy for Assignment Shortcuts / About:NotBlank.
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> Hello World -> Edit code,
// paste this file, Deploy. Then set PROXY_URL in index.html to your worker's address.
//
// Optional variable (Settings -> Variables):
//   ALLOWED_ORIGINS   comma-separated list of sites allowed to call this worker from a
//                     browser, e.g. https://you.github.io  (default "*", any site)
//
// Endpoints
//   GET /proxy?url=<address>
//       The page or file exactly as the site sent it, with CORS headers and an
//       X-Final-URL header holding the address after redirects. index.html uses this.
//   GET /proxy?mode=browse&url=<address>
//       HTML comes back with its links rewritten and its fetch/XHR calls patched, so the
//       page keeps working inside a frame ("Show in frame").
//   GET /proxy?mode=module&url=<address>
//       A JavaScript file with its import statements pointed back through the proxy, so
//       ES modules (used by most modern sites) load. index.html asks for this itself.
//   GET /https://example.com/page
//       Older address form; same as browse mode.

const MAX_REDIRECTS = 6;
const MAX_BYTES = 25 * 1024 * 1024;
const FORWARD = ["user-agent", "accept", "accept-language", "content-type", "range"];
const STRIP = ["x-frame-options", "content-security-policy", "content-security-policy-report-only", "set-cookie",
  "content-encoding", "content-length", "transfer-encoding", "strict-transport-security",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods",
  "access-control-allow-headers", "access-control-expose-headers"];

// Refuse private and internal addresses (Cloudflare blocks most of these anyway).
export function blockedHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(":")) return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
  return false;
}

// ES modules: point their imports back through the proxy, and make location references
// report the site's real address (index.html provides window.__nbLoc).
const LOC_RE = /(?:(?<![\w$.])|\b(?:window|document|top|self|parent)\.)location\.(href|origin|protocol|host|hostname|port|pathname|search|hash|assign|replace|reload|toString)\b/g;
export function rewriteModule(src, baseUrl, proxyOrigin) {
  const mod = (u) => proxyOrigin + "/proxy?mode=module&url=" + encodeURIComponent(u);
  src = src.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\2/g, (m, pre, q, spec) => {
    if (!/^(\.{0,2}\/|https?:\/\/)/.test(spec)) return m;      // bare names are left alone
    try { const u = new URL(spec, baseUrl); return /^https?:$/.test(u.protocol) ? pre + q + mod(u.href) + q : m; } catch (e) { return m; }
  });
  return src.replace(LOC_RE, "window.__nbLoc.$1").replace(/\bdocument\.URL\b/g, "window.__nbLoc.href");
}

function corsHeaders(request, env) {
  const allowed = String((env && env.ALLOWED_ORIGINS) || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin");
  const h = new Headers({
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "x-final-url",
  });
  if (allowed.includes("*")) h.set("Access-Control-Allow-Origin", "*");
  else if (origin && allowed.includes(origin)) { h.set("Access-Control-Allow-Origin", origin); h.set("Vary", "Origin"); }
  return h;
}

function fail(cors, status, message) {
  const h = new Headers(cors);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ error: message }), { status, headers: h });
}

// Follow redirects by hand so every hop is checked, and report where we ended up.
async function fetchFollow(url, init) {
  let cur = new URL(url);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!/^https?:$/.test(cur.protocol)) throw new Error("Only http and https addresses are allowed");
    if (blockedHost(cur.hostname)) throw new Error("That address is not allowed");
    const r = await fetch(cur.href, { ...init, redirect: "manual" });
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

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const self = reqUrl.origin;
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // Work out which site we are proxying and how.
    let target, browse = false, moduleMode = false;
    if (reqUrl.pathname === "/proxy") {
      const t = reqUrl.searchParams.get("url");
      if (!t) return fail(cors, 400, "Missing ?url=");
      try { target = new URL(t); } catch (e) { return fail(cors, 400, "That is not a valid address"); }
      const mode = reqUrl.searchParams.get("mode");
      browse = mode === "browse";
      moduleMode = mode === "module";
    } else {
      browse = true;   // older address form: /https://example.com/page
      const direct = reqUrl.pathname.slice(1) + reqUrl.search;
      try {
        if (/^https?:\/\//i.test(direct)) target = new URL(direct);
        else {
          // Root-relative request such as /style.css: use the Referer to find the site.
          const ref = request.headers.get("Referer") || "";
          const m = ref.slice(self.length + 1).match(/^(https?:\/\/[^/]+)/i);
          if (!m) return fail(cors, 400, "Use /proxy?url=https://example.com");
          target = new URL(reqUrl.pathname + reqUrl.search, m[1]);
        }
      } catch (e) { return fail(cors, 400, "That is not a valid address"); }
    }
    const prox = (u) => self + "/proxy?mode=browse&url=" + encodeURIComponent(u);

    try {
      const headers = new Headers();
      for (const h of FORWARD) { const v = request.headers.get(h); if (v) headers.set(h, v); }
      if (!headers.has("user-agent")) headers.set("user-agent", "Mozilla/5.0 (compatible; AssignmentShortcuts/2.0)");
      let body;
      if (!["GET", "HEAD"].includes(request.method)) body = await request.arrayBuffer();

      const { res: upstream, finalUrl } = await fetchFollow(target.href, { method: request.method, headers, body });
      const declared = Number(upstream.headers.get("content-length"));
      if (declared > MAX_BYTES) return fail(cors, 413, "That file is too large for the proxy");

      // Clean up the response so it can be read by the page and shown in a frame.
      const out = new Headers(upstream.headers);
      for (const h of STRIP) out.delete(h);
      for (const [k, v] of cors) out.set(k, v);
      out.set("x-final-url", finalUrl);
      out.set("Cache-Control", "no-store");

      const type = out.get("Content-Type") || "";
      if (moduleMode) {
        out.set("Content-Type", "text/javascript; charset=utf-8");
        return new Response(rewriteModule(await upstream.text(), finalUrl, self), { status: upstream.status, headers: out });
      }
      if (!browse || !type.includes("text/html")) {
        return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
      }

      // Browse mode: rewrite links in HTML and patch fetch/XHR so the page keeps using the proxy.
      const base = new URL(finalUrl);
      const fix = (el, attr) => {
        const v = el.getAttribute(attr);
        if (!v || /^(data:|javascript:|mailto:|tel:|#|blob:)/i.test(v)) return;
        try { el.setAttribute(attr, prox(new URL(v, base).href)); } catch (e) {}
      };
      const patch = `<script>(function(){var S=${JSON.stringify(self)},B=${JSON.stringify(finalUrl)};
function f(u){try{var a=new URL(u,B);return a.origin===S?u:S+"/proxy?mode=browse&url="+encodeURIComponent(a.href)}catch(e){return u}}
var of=window.fetch;window.fetch=function(r,i){return of(typeof r==="string"?f(r):r,i)};
var ox=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=f(u);return ox.apply(this,arguments)};
})();</script>`;
      return new HTMLRewriter()
        .on("head", { element(el) { el.prepend(patch, { html: true }); } })
        .on("a[href],link[href],area[href]", { element(el) { fix(el, "href"); } })
        .on("script[src],img[src],iframe[src],source[src],video[src],audio[src]", { element(el) { fix(el, "src"); } })
        .on("form[action]", { element(el) { fix(el, "action"); } })
        .on("meta[http-equiv]", { element(el) { if (/^refresh$/i.test(el.getAttribute("http-equiv") || "")) el.remove(); } })
        .transform(new Response(upstream.body, { status: upstream.status, headers: out }));
    } catch (e) {
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      return fail(cors, timedOut ? 504 : 502, timedOut ? "The site took too long to answer" : "Proxy error: " + e.message);
    }
  },
};
