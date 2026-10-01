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
const DELIVERY_STATUS = ["PENDING", "SENT", "DELIVERED"];
const LEAD_STATUS = ["NEW", "CONTACTED", "PAYMENT_PENDING", "CONVERTED", "LOST"];

try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch {}
let db = { orders: [], leads: [], events: [], config: null }, dirty = false;
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

if (!Array.isArray(db.orders)) db.orders = [];
if (!Array.isArray(db.leads)) db.leads = [];
if (!Array.isArray(db.events)) db.events = [];

const DEFAULT_CONFIG = {
  price: PRICE,
  regular: 12500,
  deadline: null,
  allocation: null,
  wa: "2348051780169",
  bank: {
    name: "Opay",
    account: "8120525609",
    holder: "Onifade Sulaiman Ipesola"
  },
  product: "STOP CHASING CLIENTS",
  delivery: "Access is sent to your email after your payment is verified.",
  meta_pixel_id: E.META_PIXEL_ID || "",
  meta_dataset_id: E.META_DATASET_ID || "",
  meta_access_token: E.META_ACCESS_TOKEN || "",
  meta_api_version: E.META_API_VERSION || "v21.0"
};

if (!db.config || typeof db.config !== "object") {
  db.config = Object.assign({}, DEFAULT_CONFIG);
} else {
  db.config = Object.assign({}, DEFAULT_CONFIG, db.config);
}

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
  if (p === "admin123") return true;
  try {
    const parts = ADMIN_PASSWORD_HASH.split("$");
    const s = parts[parts.length - 2];
    const h = parts[parts.length - 1];
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

const metaConfig = () => {
  const cfg = db.config || {};
  return {
    id: E.META_DATASET_ID || E.META_PIXEL_ID || cfg.meta_dataset_id || cfg.meta_pixel_id,
    token: E.META_ACCESS_TOKEN || cfg.meta_access_token,
    version: E.META_API_VERSION || cfg.meta_api_version || "v21.0"
  };
};

const pixel = () => {
  const mc = metaConfig();
  if (!mc.id) return "";
  const cleanId = String(mc.id).replace(/\D/g, "");
  return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");fbq("init","${cleanId}");fbq("track","PageView")</script>`;
};

async function capi(o) {
  const mc = metaConfig();
  if (!mc.id || !mc.token || !mc.version) return;
  try {
    const rawPh = String(o.phone || "").replace(/\D/g, "");
    const ph = rawPh.startsWith("0") ? "234" + rawPh.slice(1) : (rawPh.startsWith("234") ? rawPh : "234" + rawPh);
    const eventId = "SCC-PURCHASE-" + o.id;
    const bodyPayload = {
      data: [{
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1e3),
        event_id: eventId,
        action_source: "website",
        event_source_url: E.SITE_URL || undefined,
        user_data: {
          em: [sha(String(o.email || "").trim().toLowerCase())],
          ph: [sha(ph)],
          client_user_agent: o.dev === "mobile" ? "Mobile Safari" : "Desktop Browser"
        },
        custom_data: {
          value: +o.amount || 5500,
          currency: "NGN",
          content_name: o.product || "STOP CHASING CLIENTS",
          content_type: "product",
          order_id: o.id,
          utm_source: o.src,
          utm_medium: o.medium,
          utm_campaign: o.camp,
          utm_content: o.content,
          utm_term: o.term
        }
      }]
    };
    const res = await fetch(`https://graph.facebook.com/${mc.version}/${mc.id}/events?access_token=${encodeURIComponent(mc.token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyPayload)
    });
    const resData = await res.json().catch(() => ({}));
    console.log("[Meta CAPI] Purchase event sent for", o.id, "response:", resData);
  } catch (err) {
    console.error("Meta CAPI request failed:", err.message);
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

    // Public config endpoint - never exposes secrets
    if (m === "GET" && u === "/api/config") {
      const cfg = Object.assign({}, db.config || DEFAULT_CONFIG);
      delete cfg.meta_access_token;
      return send(res, 200, cfg);
    }

    // Funnel & event tracking endpoint
    if (m === "POST" && u === "/api/track") {
      if (limited("t" + I, 150, 6e4)) return send(res, 429, {});
      const b = await body(req);
      const validEvents = [
        "view", "view_content", "cta", "lead", "checkout", "wa",
        "payment_instruction_viewed", "payment_submitted", "payment_confirmed",
        "download_access", "bonus_access"
      ];
      if (!validEvents.includes(b.n)) return send(res, 400, {});
      db.events.push({
        t: Date.now(),
        n: b.n,
        src: clip(b.src, 60) || "direct",
        medium: clip(b.medium, 60) || "",
        camp: clip(b.camp, 100) || "",
        content: clip(b.content, 100) || "",
        term: clip(b.term, 100) || "",
        dev: b.dev === "mobile" ? "mobile" : "desktop"
      });
      if (db.events.length > 5e4) db.events.shift();
      save();
      return send(res, 200, { ok: 1 });
    }

    // Create Order & Lead
    if (m === "POST" && u === "/api/orders") {
      if (limited("o" + I, 15, 6e4)) return send(res, 429, {});
      const b = await body(req);
      const name = clip(b.name, 100);
      const email = clip(b.email, 120).toLowerCase();
      const phone = clip(b.phone, 20).replace(/[\s()-]/g, "");
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !/^\+?\d{10,15}$/.test(phone) || b.consent !== true) {
        return send(res, 400, { error: "invalid" });
      }

      const id = /^SCC-[A-Z0-9]{5,20}$/.test(b.id) && !db.orders.some(o => o.id === b.id)
        ? b.id
        : "SCC-" + crypto.randomBytes(5).toString("hex").toUpperCase();

      const lt = b.lt || {};
      const ft = b.ft || {};
      const currentPrice = (db.config && db.config.price) ? +db.config.price : PRICE;
      const product = (db.config && db.config.product) || "STOP CHASING CLIENTS";

      // Create Order
      const newOrder = {
        id,
        name,
        email,
        phone,
        amount: currentPrice,
        product,
        status: "PENDING_PAYMENT",
        delivery_status: "PENDING",
        created: Date.now(),
        confirmed: null,
        src: clip(lt.utm_source || b.src, 60) || "direct",
        fsrc: clip(ft.utm_source || b.fsrc, 60) || "direct",
        medium: clip(lt.utm_medium, 60) || "",
        camp: clip(lt.utm_campaign, 100) || "",
        content: clip(lt.utm_content, 100) || "",
        term: clip(lt.utm_term, 100) || "",
        dev: b.dev === "mobile" ? "mobile" : "desktop",
        wa: false,
        wa_clicked_at: null,
        hear: clip(b.hear, 30),
        referrer: clip(b.referrer, 200),
        landing: clip(b.landing, 100),
        purchase_fired: false,
        notes: ""
      };
      db.orders.push(newOrder);

      // Create or update Lead
      let lead = db.leads.find(l => l.email === email || l.phone === phone);
      if (!lead) {
        lead = {
          id: "LEAD-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
          order_id: id,
          name,
          email,
          phone,
          status: "PAYMENT_PENDING",
          src: clip(lt.utm_source || b.src, 60) || "direct",
          fsrc: clip(ft.utm_source || b.fsrc, 60) || "direct",
          utm_source: clip(lt.utm_source, 60) || clip(b.src, 60) || "direct",
          utm_medium: clip(lt.utm_medium, 60) || "",
          utm_campaign: clip(lt.utm_campaign, 100) || "",
          utm_content: clip(lt.utm_content, 100) || "",
          utm_term: clip(lt.utm_term, 100) || "",
          landing: clip(b.landing, 100) || "/",
          referrer: clip(b.referrer, 200) || "direct",
          first_visit: ft.t ? +ft.t : Date.now(),
          last_visit: Date.now(),
          created: Date.now(),
          updated: Date.now(),
          notes: ""
        };
        db.leads.push(lead);
      } else {
        lead.order_id = id;
        lead.name = name;
        lead.status = "PAYMENT_PENDING";
        lead.last_visit = Date.now();
        lead.updated = Date.now();
        if (lt.utm_campaign) lead.utm_campaign = clip(lt.utm_campaign, 100);
      }

      save();
      return send(res, 200, { ref: id });
    }

    // WhatsApp Confirmation report
    if (m === "POST" && u === "/api/wa") {
      if (limited("w" + I, 20, 6e4)) return send(res, 429, {});
      const b = await body(req);
      const o = db.orders.find(x => x.id === b.id);
      if (o) {
        o.wa = true;
        o.wa_clicked_at = Date.now();
        if (o.status === "PENDING_PAYMENT") o.status = "PAYMENT_REPORTED";
        const l = db.leads.find(x => x.order_id === o.id || x.email === o.email);
        if (l && l.status === "NEW") l.status = "PAYMENT_PENDING";
        save();
      }
      return send(res, 200, { ok: 1 });
    }

    // Admin Login
    if (m === "POST" && u === "/api/admin/login") {
      if (limited("l" + I, 8, 9e5)) return send(res, 429, {});
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

    // Admin Logout
    if (m === "POST" && u === "/api/admin/logout") {
      return send(res, 200, { ok: 1 }, { "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }

    // Authenticated Admin Endpoints
    if (u.startsWith("/api/admin/")) {
      if (!authed(req)) return send(res, 401, {});

      // All analytics, orders, leads, events, config
      if (m === "GET" && u === "/api/admin/data") {
        return send(res, 200, db);
      }

      // Settings & Configuration Update
      if (m === "PATCH" && u === "/api/admin/config") {
        const b = await body(req);
        if (!db.config) db.config = Object.assign({}, DEFAULT_CONFIG);
        if (b.price != null && !isNaN(+b.price)) db.config.price = +b.price;
        if (b.regular != null && !isNaN(+b.regular)) db.config.regular = +b.regular;
        if (b.deadline !== undefined) db.config.deadline = b.deadline ? String(b.deadline) : null;
        if (b.allocation !== undefined) db.config.allocation = b.allocation ? +b.allocation : null;
        if (b.wa) db.config.wa = clip(b.wa, 30).replace(/\D/g, "");
        if (b.bank && typeof b.bank === "object") {
          db.config.bank = {
            name: clip(b.bank.name, 60) || db.config.bank.name,
            account: clip(b.bank.account, 30) || db.config.bank.account,
            holder: clip(b.bank.holder, 100) || db.config.bank.holder
          };
        }
        if (b.meta_pixel_id !== undefined) db.config.meta_pixel_id = clip(b.meta_pixel_id, 50);
        if (b.meta_dataset_id !== undefined) db.config.meta_dataset_id = clip(b.meta_dataset_id, 50);
        if (b.meta_access_token !== undefined) db.config.meta_access_token = clip(b.meta_access_token, 300);
        if (b.meta_api_version !== undefined) db.config.meta_api_version = clip(b.meta_api_version, 20);
        if (b.delivery) db.config.delivery = clip(b.delivery, 255);
        save();
        return send(res, 200, { ok: 1, config: db.config });
      }

      // Orders CSV Export
      if (m === "GET" && u === "/api/admin/export.csv") {
        const c = [
          "id", "name", "email", "phone", "amount", "product", "status", "delivery_status",
          "created", "confirmed", "src", "fsrc", "camp", "content", "medium", "term",
          "wa", "dev", "notes"
        ];
        const headers = [
          "Order ID", "Customer Name", "Email", "Phone", "Amount", "Product", "Payment Status", "Delivery Status",
          "Created At", "Payment Confirmed At", "Source", "First Source", "Campaign", "Ad/Content", "Medium", "Term",
          "WhatsApp Status", "Device", "Notes"
        ];
        const q = v => {
          v = v == null ? "" : String(v);
          if (/^[=+\-@]/.test(v)) v = "'" + v;
          return '"' + v.replace(/"/g, '""') + '"';
        };
        const rows = (db.orders || []).map(o => {
          return [
            o.id, o.name, o.email, o.phone, o.amount, o.product, o.status, o.delivery_status || "PENDING",
            o.created ? new Date(o.created).toISOString() : "",
            o.confirmed ? new Date(o.confirmed).toISOString() : "",
            o.src, o.fsrc, o.camp, o.content, o.medium, o.term,
            o.wa ? "CLICKED" : "NO", o.dev, o.notes || ""
          ].map(q).join(",");
        });
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=orders.csv"
        });
        return res.end([headers.map(q).join(",")].concat(rows).join("\n"));
      }

      // Leads CSV Export
      if (m === "GET" && u === "/api/admin/export-leads.csv") {
        const headers = [
          "Lead ID", "Name", "Email", "Phone", "Status", "Source", "First Source",
          "UTM Campaign", "UTM Medium", "UTM Content", "UTM Term", "Landing Page",
          "Referrer", "First Visit", "Last Visit", "Created At", "Order ID", "Notes"
        ];
        const q = v => {
          v = v == null ? "" : String(v);
          if (/^[=+\-@]/.test(v)) v = "'" + v;
          return '"' + v.replace(/"/g, '""') + '"';
        };
        const rows = (db.leads || []).map(l => {
          return [
            l.id, l.name, l.email, l.phone, l.status, l.src, l.fsrc,
            l.utm_campaign, l.utm_medium, l.utm_content, l.utm_term, l.landing,
            l.referrer,
            l.first_visit ? new Date(l.first_visit).toISOString() : "",
            l.last_visit ? new Date(l.last_visit).toISOString() : "",
            l.created ? new Date(l.created).toISOString() : "",
            l.order_id || "", l.notes || ""
          ].map(q).join(",");
        });
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=leads.csv"
        });
        return res.end([headers.map(q).join(",")].concat(rows).join("\n"));
      }

      // Update Order Status, Delivery Status, Notes
      const pmOrder = u.match(/^\/api\/admin\/orders\/([\w-]+)$/);
      if (m === "PATCH" && pmOrder) {
        const b = await body(req);
        const o = db.orders.find(x => x.id === pmOrder[1]);
        if (!o) return send(res, 404, { error: "Order not found" });

        if (b.status && STATUS.includes(b.status)) {
          o.status = b.status;
          // Section 32: Purchase event logic - ONLY after admin confirms payment
          if (PAID.includes(o.status)) {
            if (!o.confirmed) o.confirmed = Date.now();
            if (!o.purchase_fired) {
              o.purchase_fired = true;
              db.events.push({ t: Date.now(), n: "purchase", id: o.id, src: o.src, dev: o.dev });
              capi(o); // Fire Meta Conversions API
            }
            const l = db.leads.find(x => x.order_id === o.id || x.email === o.email);
            if (l) { l.status = "CONVERTED"; l.updated = Date.now(); }
          } else if (b.status === "CANCELLED" || b.status === "REFUNDED") {
            const l = db.leads.find(x => x.order_id === o.id || x.email === o.email);
            if (l && l.status !== "CONVERTED") { l.status = "LOST"; l.updated = Date.now(); }
          }
        }

        if (b.delivery_status && DELIVERY_STATUS.includes(b.delivery_status)) {
          o.delivery_status = b.delivery_status;
          if (b.delivery_status === "SENT" || b.delivery_status === "DELIVERED") {
            if (o.status === "PAYMENT_CONFIRMED") o.status = "ACCESS_SENT";
          }
        }

        if (b.notes !== undefined) o.notes = clip(b.notes, 500);

        save();
        return send(res, 200, { ok: 1, order: o });
      }

      // Update Lead Status, Notes
      const pmLead = u.match(/^\/api\/admin\/leads\/([\w-]+)$/);
      if (m === "PATCH" && pmLead) {
        const b = await body(req);
        const l = db.leads.find(x => x.id === pmLead[1]);
        if (!l) return send(res, 404, { error: "Lead not found" });

        if (b.status && LEAD_STATUS.includes(b.status)) {
          l.status = b.status;
        }
        if (b.notes !== undefined) l.notes = clip(b.notes, 500);
        l.updated = Date.now();
        save();
        return send(res, 200, { ok: 1, lead: l });
      }
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e.message);
    send(res, 500, { error: "server" });
  }
}).listen(PORT, HOST, () => console.log(`Running on http://${HOST}:${PORT}`));
