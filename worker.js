// Cloudflare Worker: a small web proxy for About:NotBlank.
// Usage: https://YOUR-WORKER.workers.dev/https://example.com/page
export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    const self = reqUrl.origin;

    // Work out which site we are proxying.
    let target;
    const direct = reqUrl.pathname.slice(1) + reqUrl.search;
    if (/^https?:\/\//i.test(direct)) {
      target = new URL(direct);
    } else {
      // Root-relative request (e.g. /style.css): use the Referer to find the site.
      const ref = request.headers.get("Referer") || "";
      const m = ref.slice(self.length + 1).match(/^(https?:\/\/[^/]+)/i);
      if (!m) return new Response("Add a full address after the slash, e.g. /https://example.com", { status: 400 });
      target = new URL(reqUrl.pathname + reqUrl.search, m[1]);
    }
    const origin = target.origin;
    const prox = (u) => self + "/" + u;

    // Forward the request.
    const headers = new Headers(request.headers);
    headers.set("Referer", origin + "/");
    headers.set("Origin", origin);
    headers.delete("Cookie");
    const upstream = await fetch(target.href, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });

    // Clean up the response so it can be shown in a frame.
    const out = new Headers(upstream.headers);
    for (const h of ["x-frame-options", "content-security-policy", "content-security-policy-report-only", "set-cookie", "content-encoding", "content-length"]) out.delete(h);
    out.set("Access-Control-Allow-Origin", "*");
    const loc = out.get("Location");
    if (loc) out.set("Location", prox(new URL(loc, target).href));

    const type = out.get("Content-Type") || "";
    if (!type.includes("text/html")) {
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    // Rewrite links in HTML and patch fetch/XHR so the page keeps using the proxy.
    const fix = (el, attr) => {
      const v = el.getAttribute(attr);
      if (!v || /^(data:|javascript:|mailto:|tel:|#|blob:)/i.test(v)) return;
      try { el.setAttribute(attr, prox(new URL(v, target).href)); } catch (e) {}
    };
    const patch = `<script>(function(){var S=${JSON.stringify(self)},O=${JSON.stringify(origin)};
function f(u){try{var a=new URL(u,O+"/");return a.origin===S?u:S+"/"+a.href}catch(e){return u}}
var of=window.fetch;window.fetch=function(r,i){return of(typeof r==="string"?f(r):r,i)};
var ox=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=f(u);return ox.apply(this,arguments)};
})();</script>`;
    return new HTMLRewriter()
      .on("head", { element(el) { el.prepend(patch, { html: true }); } })
      .on("a[href],link[href],area[href]", { element(el) { fix(el, "href"); } })
      .on("script[src],img[src],iframe[src],source[src],video[src],audio[src]", { element(el) { fix(el, "src"); } })
      .on("form[action]", { element(el) { fix(el, "action"); } })
      .transform(new Response(upstream.body, { status: upstream.status, headers: out }));
  },
};
