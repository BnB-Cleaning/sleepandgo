/* =========================================================
   Sleep & Go Cleaning — server (Node + Express)
   - Servește aplicația (public/index.html)
   - API: /api/auth/* și /api/state
   - Stocare: PostgreSQL pe Railway (DATABASE_URL) sau fișier local pentru dev
   ========================================================= */
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "sgc-dev-secret-change-me";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@sleepandgocleaning.com").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

/* ---------------- Stripe (plată reală, opțional) ---------------- */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
let stripe = null;
if (STRIPE_SECRET_KEY) {
  try { stripe = require("stripe")(STRIPE_SECRET_KEY); console.log("[stripe] activat (plată reală)"); }
  catch (e) { console.log("[stripe] pachetul lipsește sau cheia e invalidă:", e.message); }
} else {
  console.log("[stripe] fără chei — aplicația folosește plata simulată");
}

/* Calculul prețului pe SERVER (nu se poate falsifica din client).
   Reproduce priceOf() din js/store.js: bază/m², +30% vârf (10–15), +10% weekend/sărbătoare,
   lenjerie 50 lei/set, consumabile (achiziție + 10% adaos). Întoarce totalul în bani (RON*100). */
const PRICE = { pricePerSqm: 0.6, linenSetPriceRon: 50, ronPerEur: 4.97, consumableMarkupPct: 10, weekendHolidaySurchargePct: 10, peakStart: 10, peakEnd: 15, peakSurchargePct: 30 };
const LEGAL_HOLIDAYS = ["01-01", "01-02", "01-24", "05-01", "06-01", "08-15", "11-30", "12-01", "12-25", "12-26"];
const round2 = (n) => Math.round(n * 100) / 100;
function priceOfServer(req, st) {
  const s = st.settings || {};
  const pps = (s.pricePerSqm > 0) ? s.pricePerSqm : PRICE.pricePerSqm;
  const ronPerEur = (s.ronPerEur > 0) ? s.ronPerEur : PRICE.ronPerEur;
  const ronToEur = (ron) => round2(ron / ronPerEur);
  const h = parseInt(String(req.startTime || "").split(":")[0], 10);
  const cleaning = (Number(req.sqm) || 0) * pps;
  const peakPct = (!isNaN(h) && h >= PRICE.peakStart && h < PRICE.peakEnd) ? PRICE.peakSurchargePct : 0;
  const afterPeak = round2(cleaning + round2(cleaning * peakPct / 100));
  let surPct = 0;
  if (req.date) {
    const d = new Date(req.date + "T00:00:00");
    if (!isNaN(d.getTime())) {
      const day = d.getDay(), md = String(req.date).slice(5);
      if (day === 0 || day === 6 || LEGAL_HOLIDAYS.includes(md)) surPct = PRICE.weekendHolidaySurchargePct;
    }
  }
  const cleaningNet = round2(afterPeak + round2(afterPeak * surPct / 100));
  const linenSets = req.linens ? (Number(req.linenSets) || 0) : 0;
  const linenEur = ronToEur(linenSets * PRICE.linenSetPriceRon);
  const consCostRon = (req.consumables || []).reduce((sum, c) => {
    const p = (st.products || []).find(x => x.id === c.productId);
    return sum + (p ? p.priceRon * (Number(c.qty) || 0) : 0);
  }, 0);
  const consRon = round2(consCostRon + round2(consCostRon * PRICE.consumableMarkupPct / 100));
  const consEur = ronToEur(consRon);
  const totalEur = round2(round2(cleaningNet + linenEur) + consEur);
  const totalRon = Math.round(totalEur * ronPerEur);   // lei afișați clientului
  return { totalEur, totalRon, baniRon: totalRon * 100 };
}

/* ---------------- STOCARE (kv: cheie -> text) ---------------- */
// Producție (Railway): Postgres. Dev local: fișier JSON.
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
  });
  store = {
    async init() {
      await pool.query("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
    },
    async get(k) {
      const r = await pool.query("SELECT v FROM kv WHERE k=$1", [k]);
      return r.rows[0] ? r.rows[0].v : null;
    },
    async set(k, v) {
      await pool.query(
        "INSERT INTO kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v",
        [k, v]
      );
    },
  };
  console.log("[storage] PostgreSQL (Railway)");
} else {
  const file = path.join(__dirname, ".data", "kv.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mem = {};
  try { mem = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { mem = {}; }
  const flush = () => fs.writeFileSync(file, JSON.stringify(mem));
  store = {
    async init() {},
    async get(k) { return k in mem ? mem[k] : null; },
    async set(k, v) { mem[k] = v; flush(); },
  };
  console.log("[storage] fișier local (.data/kv.json)");
}

/* ---------------- Parole (hash cu scrypt, fără dependințe) ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return salt + ":" + hash;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(pw, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(test, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- Sesiune (cookie semnat) ---------------- */
function sign(uid) {
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update(String(uid)).digest("hex");
  return uid + "." + mac;
}
function readSession(req) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const val = decodeURIComponent(m[1]);
  const dot = val.lastIndexOf(".");
  if (dot < 0) return null;
  const uid = val.slice(0, dot), mac = val.slice(dot + 1);
  const good = crypto.createHmac("sha256", SESSION_SECRET).update(uid).digest("hex");
  if (mac.length !== good.length) return null;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good)) ? uid : null;
}
function setSession(res, uid) {
  res.setHeader("Set-Cookie",
    `sid=${encodeURIComponent(sign(uid))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; Max-Age=0");
}

/* ---------------- Starea aplicației (un singur document JSON) ---------------- */
const PRODUCTS_SEED_VERSION = 2;   // crește când schimbi lista de mai jos → se aplică pe baza existentă
const SEED_PRODUCTS = [
  { id: "p_hartie", name: "Hârtie igienică", unit: "rolă", priceRon: 2, lowAt: 4, active: true },
  { id: "p_apa", name: "Apă (sticlă)", unit: "sticlă", priceRon: 7, lowAt: 6, active: true },
  { id: "p_cafea", name: "Cafea", unit: "pungă 250g", priceRon: 32, lowAt: 2, active: true },
  { id: "p_bomboane", name: "Bomboane", unit: "cutie", priceRon: 1, lowAt: 2, active: true },
  { id: "p_detergent", name: "Detergent vase", unit: "500 ml", priceRon: 5, lowAt: 2, active: true },
  { id: "p_domestos", name: "Domestos", unit: "sticlă", priceRon: 17, lowAt: 2, active: true },
];
function freshState() {
  return {
    settings: { commissionPct: 30, ronPerEur: 4.97 },
    users: [],
    locations: [],
    requests: [],
    reviews: [],
    products: SEED_PRODUCTS,
  };
}
async function getState() {
  const raw = await store.get("state");
  if (raw) return JSON.parse(raw);
  const st = freshState();
  await store.set("state", JSON.stringify(st));
  return st;
}
async function saveState(st) { await store.set("state", JSON.stringify(st)); }

function uid(p) { return p + "_" + crypto.randomBytes(6).toString("hex"); }
function publicUser(u) { const { password, ...rest } = u || {}; return rest; }

// Aplică lista canonică de produse pe baza existentă (o singură dată per versiune)
async function ensureProducts() {
  const st = await getState();
  if (!st.settings) st.settings = {};
  if ((st.settings.productsSeedVersion || 0) < PRODUCTS_SEED_VERSION) {
    st.products = SEED_PRODUCTS;
    st.settings.productsSeedVersion = PRODUCTS_SEED_VERSION;
    await saveState(st);
    console.log("[seed] produse actualizate la versiunea", PRODUCTS_SEED_VERSION);
  }
}

async function ensureAdmin() {
  const st = await getState();
  if (!st.users.some(u => u.role === "admin")) {
    const id = uid("u");
    st.users.push({ id, name: "Administrator", email: ADMIN_EMAIL, role: "admin", area: null });
    await store.set("pw:" + id, hashPassword(ADMIN_PASSWORD));
    await saveState(st);
    console.log("[seed] admin creat:", ADMIN_EMAIL);
  }
}

// Conversie one-off: promovează un solicitant la Agent Cleaning (executant) cu date generice.
// Setează env PROMOTE_EXECUTANT="email1,email2". Rulează la pornire; idempotent (acționează doar cât e solicitant).
async function promoteExecutants() {
  const emails = (process.env.PROMOTE_EXECUTANT || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return;
  const st = await getState();
  let changed = false;
  for (const email of emails) {
    const u = (st.users || []).find(x => (x.email || "").toLowerCase() === email);
    if (!u) { console.log("[promote] utilizator negăsit:", email); continue; }
    if (u.role === "executant") { console.log("[promote] deja Agent Cleaning:", email); continue; }
    u.role = "executant";
    if (!u.business) u.business = {
      type: "SRL",
      name: (u.name || "Agent Cleaning") + " SRL",
      cui: "RO00000000",
      regCom: "J40/0000/2024",
      iban: "RO49AAAA1B31007593840000",
    };
    if (!u.area) u.area = "București - Sector 3";
    if (!u.phone) u.phone = "0700000000";
    changed = true;
    console.log("[promote] convertit în Agent Cleaning:", email);
  }
  if (changed) await saveState(st);
}

/* ---------------- App ---------------- */
const app = express();

// marchează o solicitare ca plătită (idempotent) — folosit de webhook și de /verify
async function markRequestPaid(reqId, sessionId) {
  const st = await getState();
  const r = (st.requests || []).find(x => x.id === reqId);
  if (!r) return false;
  if (r.status === "nou") {
    r.status = "platit";
    r.paidAt = Date.now();
    if (sessionId) r.stripeSessionId = sessionId;
    await saveState(st);
    console.log("[stripe] solicitare plătită:", reqId);
  }
  return true;
}

// Webhook Stripe — trebuie înregistrat ÎNAINTE de express.json (are nevoie de body-ul brut)
app.post("/api/pay/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(200).send("stripe off");
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString("utf8"));   // dev, fără verificare semnătură
    }
  } catch (e) {
    return res.status(400).send("Webhook signature error: " + e.message);
  }
  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      if (s.payment_status === "paid" && s.metadata && s.metadata.reqId) {
        await markRequestPaid(s.metadata.reqId, s.id);
      }
    }
  } catch (e) { console.log("[stripe] webhook handler err:", e.message); }
  res.json({ received: true });
});

app.use(express.json({ limit: "6mb" }));

// --- Auth ---
app.post("/api/auth/register", async (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || "").trim();
    const email = (b.email || "").trim().toLowerCase();
    const pass = String(b.password || "");
    const role = b.role;
    if (!name || !email || pass.length < 4)
      return res.status(422).json({ ok: false, error: "Completează nume, email și parolă (min 4)." });
    if (!["solicitant", "executant", "spalatorie"].includes(role))
      return res.status(422).json({ ok: false, error: "Rol invalid." });
    const needsBiz = role === "executant" || role === "spalatorie";
    if (needsBiz) {
      const biz = b.business || {};
      if (!["PFA", "PFI", "SRL"].includes(biz.type))
        return res.status(422).json({ ok: false, error: "Doar PFA, PFI sau SRL." });
      if (!biz.name || !biz.cui || !biz.iban)
        return res.status(422).json({ ok: false, error: "Completează firma, CUI/CIF și IBAN." });
      if (!b.phone) return res.status(422).json({ ok: false, error: "Completează un telefon." });
    }
    const st = await getState();
    if (st.users.some(u => u.email.toLowerCase() === email))
      return res.status(409).json({ ok: false, error: "Există deja un cont cu acest email." });
    const id = uid("u");
    const user = {
      id, name, email, role,
      area: needsBiz ? (b.area || null) : null,
      phone: b.phone || "", address: b.address || "",
      business: needsBiz ? b.business : null,
    };
    st.users.push(user);
    await store.set("pw:" + id, hashPassword(pass));
    await saveState(st);
    setSession(res, id);
    res.json({ ok: true, user: publicUser(user) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const pass = String(req.body.password || "");
    const st = await getState();
    const u = st.users.find(x => x.email.toLowerCase() === email);
    if (!u) return res.status(401).json({ ok: false, error: "Email sau parolă incorecte." });
    const stored = await store.get("pw:" + u.id);
    if (!verifyPassword(pass, stored))
      return res.status(401).json({ ok: false, error: "Email sau parolă incorecte." });
    setSession(res, u.id);
    res.json({ ok: true, user: publicUser(u) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/api/auth/logout", (req, res) => { clearSession(res); res.json({ ok: true }); });

app.get("/api/auth/me", async (req, res) => {
  const id = readSession(req);
  if (!id) return res.json({ ok: true, user: null });
  const st = await getState();
  const u = st.users.find(x => x.id === id);
  res.json({ ok: true, user: u ? publicUser(u) : null });
});

// --- Stare partajată ---
app.get("/api/state", async (req, res) => {
  const st = await getState();
  // nu trimitem parole (ele stau în pw:<id>, nu în state)
  res.json({ ok: true, state: st, sessionUid: readSession(req) });
});

app.post("/api/state", async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ ok: false, error: "Neautentificat." });
  const incoming = req.body && req.body.state;
  if (!incoming || typeof incoming !== "object")
    return res.status(400).json({ ok: false, error: "Stare invalidă." });
  // păstrăm parolele intacte: state nu conține parole, deci doar salvăm
  await saveState(incoming);
  res.json({ ok: true });
});

// --- Plată reală: creează sesiunea de Checkout (autentificat, doar propria solicitare) ---
app.post("/api/pay/checkout", async (req, res) => {
  try {
    const uid = readSession(req);
    if (!uid) return res.status(401).json({ ok: false, error: "Neautentificat." });
    if (!stripe) return res.json({ ok: false, error: "stripe_unconfigured" });
    const reqId = req.body && req.body.reqId;
    const st = await getState();
    const r = (st.requests || []).find(x => x.id === reqId);
    if (!r) return res.status(404).json({ ok: false, error: "Solicitare inexistentă." });
    if (r.requesterId !== uid) return res.status(403).json({ ok: false, error: "Nu este solicitarea ta." });
    if (r.status !== "nou") return res.json({ ok: false, error: "already_paid" });
    const price = priceOfServer(r, st);
    if (!price.baniRon || price.baniRon < 200) return res.status(400).json({ ok: false, error: "Sumă invalidă." });
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const origin = req.headers.origin || (proto + "://" + req.headers.host);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "ron",
          product_data: {
            name: "Curățenie regim hotelier — " + (r.sqm || 0) + " m²",
            description: (r.date || "") + " · " + (r.startTime || "") + "–" + (r.endTime || ""),
          },
          unit_amount: price.baniRon,
        },
        quantity: 1,
      }],
      metadata: { reqId: r.id, requesterId: uid },
      success_url: origin + "/?paid=" + encodeURIComponent(r.id) + "&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: origin + "/?paycancel=" + encodeURIComponent(r.id),
    });
    res.json({ ok: true, url: session.url });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- Confirmă plata după întoarcerea de pe pagina Stripe (success_url) ---
app.get("/api/pay/verify", async (req, res) => {
  try {
    if (!stripe) return res.json({ ok: false, error: "stripe_unconfigured" });
    const sid = req.query.session_id;
    if (!sid) return res.status(400).json({ ok: false, error: "Lipsă session_id." });
    const s = await stripe.checkout.sessions.retrieve(String(sid));
    if (s && s.payment_status === "paid" && s.metadata && s.metadata.reqId) {
      await markRequestPaid(s.metadata.reqId, s.id);
      return res.json({ ok: true, paid: true, reqId: s.metadata.reqId });
    }
    res.json({ ok: true, paid: false });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- Lead-uri publice (ofertă din simulator / închiriere lenjerii) — fără autentificare ---
app.post("/api/lead", async (req, res) => {
  try {
    const b = req.body || {};
    const type = b.type;
    const data = b.data || {};
    if (!["offer", "rental"].includes(type)) return res.status(400).json({ ok: false, error: "Tip invalid." });
    if (!data.name || !data.phone) return res.status(422).json({ ok: false, error: "Completează numele și telefonul." });
    const st = await getState();
    const key = type === "offer" ? "offerLeads" : "rentalLeads";
    if (!Array.isArray(st[key])) st[key] = [];
    const base = {
      id: uid(type), name: String(data.name).slice(0, 120), phone: String(data.phone).slice(0, 40),
      email: String(data.email || "").slice(0, 190), note: String(data.note || "").slice(0, 500), createdAt: Date.now(),
    };
    if (type === "offer") base.quote = data.quote || null;
    else base.locations = Number(data.locations) || 0;
    st[key].push(base);
    await saveState(st);
    res.json({ ok: true, lead: base });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- Aplicația (o singură pagină, self-contained) ---
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

/* ---------------- Boot ---------------- */
(async () => {
  await store.init();
  await getState();      // creează starea inițială dacă lipsește
  await ensureProducts(); // aplică lista de produse (versiune)
  await ensureAdmin();   // creează adminul dacă lipsește
  await promoteExecutants(); // conversie one-off solicitant → Agent Cleaning (env PROMOTE_EXECUTANT)
  app.listen(PORT, () => console.log("Sleep & Go pe portul " + PORT));
})();
