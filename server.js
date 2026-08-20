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

/* ---------------- App ---------------- */
const app = express();
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
  app.listen(PORT, () => console.log("Sleep & Go pe portul " + PORT));
})();
