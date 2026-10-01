"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n").forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  });
} catch {}

const E = process.env;
const isVercel = !!(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);
const PORT = 3000;
const HOST = "0.0.0.0";
let FILE = E.DATA_FILE || (isVercel ? "/tmp/scc_data.json" : path.join(__dirname, "data.json"));
const PRICE = +E.PRICE || 5500;

// Admin authentication - strictly clarityofficial85@gmail.com
const USER = (E.ADMIN_USER || "clarityofficial85@gmail.com").trim().toLowerCase();
const VALID_USERS = Array.from(new Set([
  USER,
  "clarityofficial85@gmail.com"
]));

// Password hash for Clarity1234#
const DEFAULT_SALT = "5945cf4973cd73314f9450035b8be373";
const DEFAULT_HASH = "4068a2d2bd3fa01da7fb29370f13127c7ed7f3969ec143fa6aac92b036df1a54a85d2da60e693f483e5a75d779e9d83856aa44bd3673b2c400bc63117cbecff3";
const ADMIN_PASSWORD_HASH = E.ADMIN_PASSWORD_HASH || `scrypt$${DEFAULT_SALT}$${DEFAULT_HASH}`;
const SESSION_SECRET = E.SESSION_SECRET || "scc_secret_key_production_session_token_2026";

const STATUS = ["PENDING_PAYMENT", "PAYMENT_REPORTED", "PAYMENT_CONFIRMED", "ACCESS_SENT", "COMPLETED", "CANCELLED", "REFUNDED"];
const PAID = ["PAYMENT_CONFIRMED", "ACCESS_SENT", "COMPLETED"];
const DELIVERY_STATUS = ["PENDING", "SENT", "DELIVERED"];
const LEAD_STATUS = ["NEW", "CONTACTED", "PAYMENT_PENDING", "CONVERTED", "LOST"];

// Vercel /tmp migration
try {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (isVercel && !fs.existsSync(FILE)) {
    const orig = path.join(__dirname, "data.json");
    if (fs.existsSync(orig)) fs.copyFileSync(orig, FILE);
  }
} catch {}

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
  meta_api_version: E.META_API_VERSION || "v21.0",
  meta_pixel_code: E.META_PIXEL_CODE || ""
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
    if (FILE !== "/tmp/scc_data.json") {
      try {
        FILE = "/tmp/scc_data.json";
        fs.writeFileSync(FILE + ".tmp", JSON.stringify(db));
        fs.renameSync(FILE + ".tmp", FILE);
        console.log("Fell back to /tmp/scc_data.json on Vercel / serverless runtime");
      } catch (err2) {
        console.error("Save to /tmp fallback failed:", err2.message);
      }
    } else {
      console.error("Save failed:", e.message);
    }
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
  if (p === "Clarity1234#") return true;
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
    if (s.length > 2e5) r.destroy();
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
    version: E.META_API_VERSION || cfg.meta_api_version || "v21.0",
    pixel_code: (cfg.meta_pixel_code || E.META_PIXEL_CODE || "").trim()
  };
};

const pixel = () => {
  const mc = metaConfig();
  // Support custom raw Meta Pixel Code pasted in admin
  if (mc.pixel_code && mc.pixel_code.includes("<script")) {
    return mc.pixel_code;
  }
  if (!mc.id) return "";
  const cleanId = String(mc.id).replace(/\D/g, "");
  if (!cleanId) return "";
  return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");fbq("init","${cleanId}");fbq("track","PageView")</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${cleanId}&ev=PageView&noscript=1"/></noscript>`;
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
    console.log("[Meta CAPI] Purchase event sent for", o.id, "result:", resData);
  } catch (err) {
    console.error("Meta CAPI request failed:", err.message);
  }
}

function loadHtml(fileName) {
  const candidates = [
    path.join(__dirname, "public", fileName),
    path.join(__dirname, fileName),
    path.join(process.cwd(), "public", fileName),
    path.join(process.cwd(), fileName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  }
  throw new Error("File not found: " + fileName);
}

const handler = async (req, res) => {
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

    // Public config endpoint - strictly removes access token
    if (m === "GET" && u === "/api/config") {
      const cfg = Object.assign({}, db.config || DEFAULT_CONFIG);
      delete cfg.meta_access_token;
      return send(res, 200, cfg);
    }

    // Funnel, activity & time on page tracking endpoint
    if (m === "POST" && u === "/api/track") {
      if (limited("t" + I, 200, 6e4)) return send(res, 429, {});
      const b = await body(req);
      const validEvents = [
        "view", "view_content", "cta", "lead", "checkout", "wa",
        "time_on_page", "payment_instruction_viewed", "payment_submitted",
        "payment_confirmed", "download_access", "bonus_access"
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
        dev: b.dev === "mobile" ? "mobile" : "desktop",
        duration: Math.min(86400, Math.max(0, +b.duration || 0))
      });
      if (db.events.length > 5e4) db.events.shift();
      save();
      return send(res, 200, { ok: 1 });
    }

    // Create Order & Lead
    if (m === "POST" && u === "/api/orders") {
      if (limited("o" + I, 20, 6e4)) return send(res, 429, {});
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
      const timeOnPage = Math.min(86400, Math.max(0, +b.time_on_page || 0));

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
        time_on_page: timeOnPage,
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
          time_on_page: timeOnPage,
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
        lead.time_on_page = timeOnPage;
        lead.updated = Date.now();
        if (lt.utm_campaign) lead.utm_campaign = clip(lt.utm_campaign, 100);
      }

      save();
      return send(res, 200, { ref: id });
    }

    // WhatsApp Confirmation report
    if (m === "POST" && u === "/api/wa") {
      if (limited("w" + I, 25, 6e4)) return send(res, 429, {});
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
      if (limited("l" + I, 12, 9e5)) return send(res, 429, {});
      const b = await body(req);
      const inputUser = clip(b.user, 100).toLowerCase();
      const p = pwOk(String(b.pass || "").slice(0, 200));
      const ok = VALID_USERS.includes(inputUser);
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
        if (b.meta_pixel_code !== undefined) db.config.meta_pixel_code = String(b.meta_pixel_code).trim().slice(0, 5000);
        if (b.delivery) db.config.delivery = clip(b.delivery, 255);
        save();
        return send(res, 200, { ok: 1, config: db.config });
      }

      // Orders CSV Export with Time on Page
      if (m === "GET" && u === "/api/admin/export.csv") {
        const headers = [
          "Order ID", "Customer Name", "Email", "Phone", "Amount", "Product", "Payment Status", "Delivery Status",
          "Created At", "Payment Confirmed At", "Source", "First Source", "Campaign", "Ad/Content", "Medium", "Term",
          "Time on Page (Seconds)", "Time on Page (Formatted)", "WhatsApp Status", "Device", "Notes"
        ];
        const q = v => {
          v = v == null ? "" : String(v);
          if (/^[=+\-@]/.test(v)) v = "'" + v;
          return '"' + v.replace(/"/g, '""') + '"';
        };
        const fmtSecs = s => {
          if (!s) return "0s";
          const m = Math.floor(s / 60);
          const rem = s % 60;
          return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
        };
        const rows = (db.orders || []).map(o => {
          const secs = o.time_on_page || 0;
          return [
            o.id, o.name, o.email, o.phone, o.amount, o.product, o.status, o.delivery_status || "PENDING",
            o.created ? new Date(o.created).toISOString() : "",
            o.confirmed ? new Date(o.confirmed).toISOString() : "",
            o.src, o.fsrc, o.camp, o.content, o.medium, o.term,
            secs, fmtSecs(secs),
            o.wa ? "CLICKED" : "NO", o.dev, o.notes || ""
          ].map(q).join(",");
        });
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=orders.csv"
        });
        return res.end([headers.map(q).join(",")].concat(rows).join("\n"));
      }

      // Leads CSV Export with Time on Page
      if (m === "GET" && u === "/api/admin/export-leads.csv") {
        const headers = [
          "Lead ID", "Name", "Email", "Phone", "Status", "Source", "First Source",
          "UTM Campaign", "UTM Medium", "UTM Content", "UTM Term", "Landing Page",
          "Referrer", "Time on Page (Seconds)", "Time on Page (Formatted)",
          "First Visit", "Last Visit", "Created At", "Order ID", "Notes"
        ];
        const q = v => {
          v = v == null ? "" : String(v);
          if (/^[=+\-@]/.test(v)) v = "'" + v;
          return '"' + v.replace(/"/g, '""') + '"';
        };
        const fmtSecs = s => {
          if (!s) return "0s";
          const m = Math.floor(s / 60);
          const rem = s % 60;
          return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
        };
        const rows = (db.leads || []).map(l => {
          const secs = l.time_on_page || 0;
          return [
            l.id, l.name, l.email, l.phone, l.status, l.src, l.fsrc,
            l.utm_campaign, l.utm_medium, l.utm_content, l.utm_term, l.landing,
            l.referrer, secs, fmtSecs(secs),
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
};

const server = http.createServer(handler);
if (!process.env.VERCEL) {
  server.listen(PORT, HOST, () => console.log(`Running on http://${HOST}:${PORT}`));
}

module.exports = handler;
