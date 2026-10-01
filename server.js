"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n").forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  });
} catch {}

const E = process.env;
const PORT = 3000;
const HOST = "0.0.0.0";
const FILE = E.DATA_FILE || path.join(__dirname, "data.json");
const PRICE = +E.PRICE || 5500;
const USER = E.ADMIN_USER || "admin";
const VALID_USERS = Array.from(new Set([USER.toLowerCase(), "admin", "clarity"]));

// Safe fallback for dev/preview environments:
// Default password is "admin123" with default salt
const DEFAULT_SALT = "49438eb8366c00b18485bcf40a1f8388";
const DEFAULT_HASH = "a6bd8f3e5448192efeed2c1a4385768b924c595d3e2e0d9251877b2125d92475f578f779f48d6922ada3d8d67c140cd3b39bd3359a90d7f65cb2c3197611baea";
const ADMIN_PASSWORD_HASH = E.ADMIN_PASSWORD_HASH || `$${DEFAULT_SALT}$${DEFAULT_HASH}`;
const SESSION_SECRET = E.SESSION_SECRET || "scc_default_session_secret_for_preview_mode_2026";

if (!E.SESSION_SECRET || !E.ADMIN_PASSWORD_HASH) {
  console.log("[Notice] Using default dev credentials: user = '" + USER + "', password = 'admin123'. Set SESSION_SECRET and ADMIN_PASSWORD_HASH in environment for production.");
}

const STATUS = ["PENDING_PAYMENT", "PAYMENT_REPORTED", "PAYMENT_CONFIRMED", "ACCESS_SENT", "COMPLETED", "CANCELLED", "REFUNDED"];
const PAID = ["PAYMENT_CONFIRMED", "ACCESS_SENT", "COMPLETED"];

try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch {}
let db = { orders: [], events: [] }, dirty = false;
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

const save = () => {
  if (dirty) return;
  dirty = true;
  setTimeout(() => { dirty = false; flush(); }, 400);
};

const flush = () => {
  try {
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(db));
    fs.renameSync(FILE + ".tmp", FILE);
  } catch (e) {
    console.error("Save failed:", e.message);
  }
};

process.on("SIGTERM", () => { flush(); process.exit(0); });
process.on("SIGINT", () => { flush(); process.exit(0); });

const hits = new Map();
const limited = (k, max, win) => {
  const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < win);
  a.push(n);
  hits.set(k, a);
  return a.length > max;
};

const ipOf = r => (r.headers["x-forwarded-for"] || "").split(",")[0].trim() || r.socket.remoteAddress;
const sign = v => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("hex");
const token = () => {
  const x = Date.now() + 12 * 36e5;
  return x + "." + sign(String(x));
};

const authed = r => {
  const authHeader = (r.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const m = (r.headers.cookie || "").match(/sid=(\d+)\.([a-f0-9]{64})/);
  const raw = authHeader || (m ? `${m[1]}.${m[2]}` : null);
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 2) return false;
  const [exp, sig] = parts;
  if (!exp || !sig || +exp < Date.now()) return false;
  const a = Buffer.from(sign(exp)), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const pwOk = p => {
  try {
    const [, s, h] = ADMIN_PASSWORD_HASH.split("$");
    if (!s || !h) return false;
    const d = crypto.scryptSync(p, Buffer.from(s, "hex"), 64);
    const h2 = Buffer.from(h, "hex");
    return d.length === h2.length && crypto.timingSafeEqual(d, h2);
  } catch {
    return false;
  }
};

const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const send = (res, c, o, h = {}) => {
  res.writeHead(c, { "Content-Type": "application/json", "Cache-Control": "no-store", ...h });
  res.end(JSON.stringify(o));
};

const body = r => new Promise(ok => {
  let s = "";
  r.on("data", c => {
    s += c;
    if (s.length > 1e4) r.destroy();
  });
  r.on("end", () => {
    try { ok(JSON.parse(s || "{}")); } catch { ok({}); }
  });
});

const sha = v => crypto.createHash("sha256").update(v).digest("hex");

const pixel = () => E.META_PIXEL_ID ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");fbq("init","${E.META_PIXEL_ID.replace(/\D/g,"")}");fbq("track","PageView")</script>` : "";

async function capi(o) {
  const id = E.META_DATASET_ID || E.META_PIXEL_ID, t = E.META_ACCESS_TOKEN, v = E.META_API_VERSION;
  if (!id || !t || !v) return;
  try {
    const ph = o.phone.replace(/\D/g, "").replace(/^0/, "234");
    await fetch(`https://graph.facebook.com/${v}/${id}/events?access_token=${encodeURIComponent(t)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [{
          event_name: "Purchase",
          event_time: Math.floor(Date.now() / 1e3),
          event_id: o.id,
          action_source: "website",
          event_source_url: E.SITE_URL || undefined,
          user_data: { em: [sha(o.email.toLowerCase())], ph: [sha(ph)] },
          custom_data: { value: o.amount, currency: "NGN", content_name: "STOP CHASING CLIENTS", order_id: o.id }
        }]
      })
    });
  } catch {
    console.error("Meta CAPI request failed");
  }
}

function loadHtml(fileName) {
  const pubPath = path.join(__dirname, "public", fileName);
  if (fs.existsSync(pubPath)) return fs.readFileSync(pubPath, "utf8");
  const rootPath = path.join(__dirname, fileName);
  if (fs.existsSync(rootPath)) return fs.readFileSync(rootPath, "utf8");
  throw new Error("File not found: " + fileName);
}

http.createServer(async (req, res) => {
  const u = req.url.split("?")[0], m = req.method, I = ipOf(req);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Note: X-Frame-Options is omitted so the app functions within AI Studio preview iframe

  try {
    if ((m === "GET" || m === "HEAD") && u === "/healthz") return send(res, 200, { ok: 1 });

    if ((m === "GET" || m === "HEAD") && (u === "/" || u === "/index.html")) {
      let h = loadHtml("index.html");
      h = h.replace("<!--PIXEL-->", pixel());
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(m === "HEAD" ? "" : h);
    }

    if ((m === "GET" || m === "HEAD") && (u === "/admin" || u === "/admin.html")) {
      const h = loadHtml("admin.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(m === "HEAD" ? "" : h);
    }

    if (m === "POST" && u === "/api/track") {
      if (limited("t" + I, 120, 6e4)) return send(res, 429, {});
      const b = await body(req);
      if (!["view", "cta", "lead", "checkout", "wa"].includes(b.n)) return send(res, 400, {});
      db.events.push({ t: Date.now(), n: b.n, src: clip(b.src, 60) || "direct", dev: b.dev === "mobile" ? "mobile" : "desktop" });
      if (db.events.length > 5e4) db.events.shift();
      save();
      return send(res, 200, { ok: 1 });
    }

    if (m === "POST" && u === "/api/orders") {
      if (limited("o" + I, 10, 6e4)) return send(res, 429, {});
      const b = await body(req), name = clip(b.name, 100), email = clip(b.email, 120).toLowerCase(), phone = clip(b.phone, 20).replace(/[\s()-]/g, "");
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !/^\+?\d{10,15}$/.test(phone) || b.consent !== true) {
        return send(res, 400, { error: "invalid" });
      }
      const id = /^SCC-[A-Z0-9]{5,20}$/.test(b.id) && !db.orders.some(o => o.id === b.id) ? b.id : "SCC-" + crypto.randomBytes(5).toString("hex").toUpperCase();
      const lt = b.lt || {}, ft = b.ft || {};
      db.orders.push({
        id, name, email, phone, amount: PRICE, status: "PENDING_PAYMENT", created: Date.now(), confirmed: null,
        src: clip(lt.utm_source || b.src, 60) || "direct", fsrc: clip(ft.utm_source || b.fsrc, 60) || "direct",
        medium: clip(lt.utm_medium, 60), camp: clip(lt.utm_campaign, 100), content: clip(lt.utm_content, 100),
        term: clip(lt.utm_term, 100), dev: b.dev === "mobile" ? "mobile" : "desktop", wa: false,
        hear: clip(b.hear, 30), referrer: clip(b.referrer, 200), landing: clip(b.landing, 100), notes: ""
      });
      save();
      return send(res, 200, { ref: id });
    }

    if (m === "POST" && u === "/api/wa") {
      if (limited("w" + I, 20, 6e4)) return send(res, 429, {});
      const b = await body(req), o = db.orders.find(x => x.id === b.id);
      if (o) {
        o.wa = true;
        if (o.status === "PENDING_PAYMENT") o.status = "PAYMENT_REPORTED";
        save();
      }
      return send(res, 200, { ok: 1 });
    }

    if (m === "POST" && u === "/api/admin/login") {
      if (limited("l" + I, 5, 9e5)) return send(res, 429, {});
      const b = await body(req);
      const p = pwOk(String(b.pass || "").slice(0, 200));
      const ok = VALID_USERS.includes(clip(b.user, 60).toLowerCase());
      if (p && ok) {
        const t = token();
        const cookie = `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`;
        return send(res, 200, { ok: 1, token: t }, { "Set-Cookie": cookie });
      }
      return send(res, 401, {});
    }

    if (m === "POST" && u === "/api/admin/logout") {
      return send(res, 200, { ok: 1 }, { "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }

    if (u.startsWith("/api/admin/")) {
      if (!authed(req)) return send(res, 401, {});

      if (m === "GET" && u === "/api/admin/data") return send(res, 200, db);

      if (m === "GET" && u === "/api/admin/export.csv") {
        const c = ["id", "name", "email", "phone", "amount", "status", "created", "confirmed", "src", "fsrc", "medium", "camp", "content", "term", "dev", "wa", "hear", "referrer", "landing", "notes"];
        const q = v => {
          v = v == null ? "" : String(v);
          if (/^[=+\-@]/.test(v)) v = "'" + v;
          return '"' + v.replace(/"/g, '""') + '"';
        };
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=orders.csv"
        });
        return res.end([c.join(",")].concat(db.orders.map(o => c.map(k => q(o[k])).join(","))).join("\n"));
      }

      const pm = u.match(/^\/api\/admin\/orders\/([\w-]+)$/);
      if (m === "PATCH" && pm) {
        const b = await body(req), o = db.orders.find(x => x.id === pm[1]);
        if (!o || !STATUS.includes(b.status)) return send(res, 400, {});
        o.status = b.status;
        if (PAID.includes(o.status) && !o.confirmed) {
          o.confirmed = Date.now();
          db.events.push({ t: Date.now(), n: "purchase", id: o.id, src: o.src, dev: o.dev });
          capi(o);
        }
        save();
        return send(res, 200, { ok: 1 });
      }
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e.message);
    send(res, 500, { error: "server" });
  }
}).listen(PORT, HOST, () => console.log(`Running on http://${HOST}:${PORT}`));
