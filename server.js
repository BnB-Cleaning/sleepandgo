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

/* ---------------- Notificări: email (SMTP, „de la admin") + SMS (SMSO.ro) ----------------
   Solicitantul primește email + SMS când Agentul Cleaning ÎNCEPE lucrul și când îl TERMINĂ.
   Configurare prin variabile de mediu (Railway → Variables):
     Email:  SMTP_HOST, SMTP_PORT (465 SSL / 587 STARTTLS), SMTP_USER, SMTP_PASS,
             MAIL_FROM (implicit = SMTP_USER sau ADMIN_EMAIL), MAIL_FROM_NAME
     SMS:    SMSO_API_KEY, SMSO_SENDER (ID-ul de expeditor aprobat în contul SMSO)
   Fără aceste variabile, notificările sunt pur și simplu sărite (fără eroare). */
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || ADMIN_EMAIL;
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "Sleep & Go Cleaning";
let mailer = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  try {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    console.log("[mail] SMTP activat:", SMTP_HOST + ":" + SMTP_PORT, "· expeditor", MAIL_FROM);
  } catch (e) { console.log("[mail] nodemailer lipsește sau config invalidă:", e.message); }
} else {
  console.log("[mail] fără SMTP — notificările email sunt dezactivate (setează SMTP_HOST/USER/PASS)");
}

const PHONE = process.env.PHONE || "0758.369.641";
const SMSO_API_KEY = process.env.SMSO_API_KEY || "";
const SMSO_SENDER = process.env.SMSO_SENDER || "";
const SMSO_URL = process.env.SMSO_URL || "https://app.smso.ro/api/v1/send";
if (SMSO_API_KEY && SMSO_SENDER) console.log("[sms] SMSO activat · expeditor", SMSO_SENDER);
else console.log("[sms] fără SMSO — notificările SMS sunt dezactivate (setează SMSO_API_KEY/SMSO_SENDER)");

/* Calculul prețului pe SERVER (nu se poate falsifica din client).
   Reproduce priceOf() din js/store.js: bază/m², +30% vârf (10–15), +10% weekend/sărbătoare,
   lenjerie 50 lei/set, consumabile (achiziție + 10% adaos). Întoarce totalul în bani (RON*100). */
const PRICE = { pricePerSqm: 0.6, linenSetPriceRon: 50, ronPerEur: 4.97, consumableMarkupPct: 10, weekendHolidaySurchargePct: 10, peakStart: 10, peakEnd: 15, peakSurchargePct: 30, refundableSurchargePct: 20, refundRetainPct: 10, refundDeadlineHour: 9, urgentSurchargePct: 40 };
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
  const baseEur = round2(round2(cleaningNet + linenEur) + consEur);
  // opțiuni cu suprataxă — EXCLUSIVE (nu se cumulează): urgența are prioritate dacă ambele apar
  const urgentAddEur = req.urgent ? round2(baseEur * PRICE.urgentSurchargePct / 100) : 0;
  const refundableAddEur = (req.refundable && !req.urgent) ? round2(baseEur * PRICE.refundableSurchargePct / 100) : 0;
  // discount (VIP sau ofertă de lansare, nu se cumulează) — suportat din comisionul adminului
  const discPct = Math.max(Number(req.vipDiscountPct) || 0, Number(req.launchDiscountPct) || 0);
  const launchDiscountEur = discPct ? round2(cleaningNet * discPct / 100) : 0;
  const totalEur = round2(baseEur + refundableAddEur + urgentAddEur - launchDiscountEur);
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

/* ---------------- Trimitere efectivă email + SMS ---------------- */
async function sendEmail(to, subject, text) {
  if (!mailer || !to) return { ok: false, skipped: true };
  try {
    await mailer.sendMail({ from: `"${MAIL_FROM_NAME}" <${MAIL_FROM}>`, to, subject, text });
    console.log("[mail] trimis către", to, "·", subject);
    return { ok: true };
  } catch (e) { console.log("[mail] eroare către", to, ":", e.message); return { ok: false, error: e.message }; }
}
// Normalizează la format E.164 pentru România (+40…)
function normalizePhoneRo(p) {
  let s = String(p || "").replace(/[\s.\-()]/g, "");
  if (!s) return "";
  if (s[0] === "+") return s;
  if (s.slice(0, 4) === "0040") return "+" + s.slice(2);
  if (s.slice(0, 2) === "40" && s.length >= 11) return "+" + s;
  if (s[0] === "0") return "+40" + s.slice(1);
  return s;
}
async function sendSms(to, body) {
  if (!SMSO_API_KEY || !SMSO_SENDER || !to) return { ok: false, skipped: true };
  const phone = normalizePhoneRo(to);
  if (!phone) return { ok: false, skipped: true };
  try {
    const params = new URLSearchParams({ sender: SMSO_SENDER, to: phone, body });
    const resp = await fetch(SMSO_URL, {
      method: "POST",
      headers: { "X-Authorization": SMSO_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && (Number(data.status) === 200 || data.responseToken)) {
      console.log("[sms] trimis către", phone, "· token", data.responseToken || "-");
      return { ok: true };
    }
    console.log("[sms] răspuns neașteptat (", resp.status, "):", JSON.stringify(data).slice(0, 200));
    return { ok: false, error: "SMSO status " + resp.status };
  } catch (e) { console.log("[sms] eroare către", phone, ":", e.message); return { ok: false, error: e.message }; }
}

/* ---------------- Notificări la START / FINAL curățenie ----------------
   Detectăm tranzițiile comparând starea veche (server) cu cea nouă (client).
   Flag-urile notifiedStartAt / notifiedEndAt asigură că se trimite o singură dată. */
function reqStarted(r) { return !!r && r.status === "in_progres"; }
function reqEnded(r) { return !!r && (r.status === "finalizat" || !!r.readyAt); }
// Marchează tranzițiile pe starea nouă (setează flag-uri) și întoarce lista de notificări de trimis.
function markTransitions(oldSt, newSt) {
  const oldById = new Map((oldSt.requests || []).map(r => [r.id, r]));
  const jobs = [];
  for (const r of (newSt.requests || [])) {
    const old = oldById.get(r.id);
    // păstrează flag-urile deja setate pe server (clientul poate să nu le retrimită)
    if (old && old.notifiedStartAt && !r.notifiedStartAt) r.notifiedStartAt = old.notifiedStartAt;
    if (old && old.notifiedEndAt && !r.notifiedEndAt) r.notifiedEndAt = old.notifiedEndAt;
    if (!r.notifiedStartAt && reqStarted(r)) {
      // tranziție reală doar dacă am văzut anterior solicitarea într-o stare mai timpurie;
      // dacă apare direct „pornită" (ex: prima rulare pe date vechi), doar marcăm flag-ul, fără trimitere
      const genuine = !!old && !reqStarted(old);
      r.notifiedStartAt = Date.now();
      if (genuine) jobs.push({ reqId: r.id, kind: "start" });
    }
    if (!r.notifiedEndAt && reqEnded(r)) {
      const genuine = !!old && !reqEnded(old);
      r.notifiedEndAt = Date.now();
      if (genuine) jobs.push({ reqId: r.id, kind: "end" });
    }
  }
  return jobs;
}
async function notifyRequester(st, reqId, kind) {
  const r = (st.requests || []).find(x => x.id === reqId);
  if (!r) return;
  const requester = (st.users || []).find(u => u.id === r.requesterId);
  if (!requester) return;
  const addr = r.address || r.area || "locația ta";
  const when = r.date ? ` (programare ${r.date}${r.startTime ? " " + r.startTime : ""})` : "";
  let subject, text, sms;
  if (kind === "start") {
    subject = "Curățenia a început — " + addr;
    text = `Bună, ${requester.name || ""}!\n\nAgentul Cleaning a început curățenia la ${addr}${when}.\n`
         + `Te anunțăm din nou imediat ce locația este gata pentru oaspeți.\n\n— Sleep & Go Cleaning`;
    sms = `Sleep & Go: curatenia a inceput la ${addr}. Te anuntam cand e gata.`;
  } else {
    subject = "Locația e gata pentru oaspeți — " + addr;
    text = `Bună, ${requester.name || ""}!\n\nCurățenia la ${addr}${when} este finalizată — locația este gata pentru oaspeți.\n\n`
         + `Îți mulțumim că folosești Sleep & Go Cleaning!\n\n— Sleep & Go Cleaning`;
    sms = `Sleep & Go: locatia ${addr} este gata pentru oaspeti. Multumim!`;
  }
  await Promise.all([sendEmail(requester.email, subject, text), sendSms(requester.phone, sms)]);
}

function uid(p) { return p + "_" + crypto.randomBytes(6).toString("hex"); }
function publicUser(u) { const { password, ...rest } = u || {}; return rest; }

/* =========================================================
   NEWSLETTER — abonare din footer + secvențe email la 2 zile (drip)
   - Abonații stau în state.newsletter.subs (server = sursă de adevăr; clienții nu-i pot modifica prin /api/state)
   - Secvențele (conținutul) + intervalul stau în state.newsletter.seq / intervalDays → EDITABILE din admin
   - Motorul drip rulează pe server (setInterval) și trimite prin SMTP-ul deja configurat
   ========================================================= */
const NEWSLETTER_CATEGORIES = ["solicitant", "executant", "spalatorie", "rental"];
function defaultNewsletterSeq() {
  return {
    solicitant: [
      { subject: "Bine ai venit la Sleep & Go Cleaning 🧽", body:
        "Bună{name}!\n\nÎți mulțumim pentru interes. Sleep & Go Cleaning este platforma de curățenie în regim hotelier pentru închirieri pe termen scurt (Airbnb, Booking) din București și Ilfov.\n\nCe facem pentru tine:\n• Turnover complet între check-out și check-in — curățenie, schimbat lenjeria, pregătit locația.\n• Plătești în avans, securizat, iar agenții din zona ta se înscriu la solicitarea ta — tu alegi pe cine vrei, după rating și recenzii.\n• Preț transparent, de la 0,6 €/m². Vezi totalul exact înainte să plătești.\n\nÎn zilele următoare îți trimitem, pas cu pas, cum funcționează totul." },
      { subject: "Cum funcționează: de la solicitare la locație gata 🛏️", body:
        "Bună{name}!\n\nUite cât de simplu e:\n1) Adaugi locația (cu un document de suprafață) — administratorul o validează.\n2) Alegi data și intervalul (program 8:00–22:00) și plătești în avans prin Stripe.\n3) Agenții Cleaning din zona ta se înscriu; tu îl alegi pe cel dorit.\n4) Primești notificări prin email și SMS când curățenia ÎNCEPE și când se TERMINĂ (locația e gata pentru oaspeți).\n\nPreț dinamic: +30% în intervalul de vârf 10:00–15:00, +10% în weekend și de sărbători. Fără costuri ascunse." },
      { subject: "Lenjerie, consumabile și garanție 🧺", body:
        "Bună{name}!\n\nCâteva lucruri care îți fac viața mai ușoară:\n• Lenjerie: îți etichetăm individual fiecare set și intră într-un circuit continuu (locație → spălătorie → depozitat la agent → înapoi), ca la fiecare check-in să existe lenjerie curată.\n• Consumabile la cerere (hârtie, apă, cafea, produse de curățenie).\n• Opțiuni: ⚡ Urgență (rezervi cu min. 5h înainte) și 🔓 Rambursabil (anulezi și primești 90% înapoi).\n• Garanție: dacă nu se face în intervalul rezervat → banii înapoi + 50 lei.\n• Agentul poate filma video înainte/după — util pentru despăgubiri la Airbnb/Booking.\n\nCând ești gata, creează-ți cont și trimite prima solicitare." },
    ],
    executant: [
      { subject: "Bun venit în rețeaua de Agenți Cleaning 🧹", body:
        "Bună{name}!\n\nMulțumim pentru interesul de a deveni Agent Cleaning în rețeaua Sleep & Go. Primești lucrări plătite în avans din zona ta, fără să cauți clienți.\n\nPe scurt:\n• Primești 70% din prețul curățeniei (comision platformă 30%).\n• Clientul plătește în avans — banii sunt garantați înainte să începi.\n• Tu decizi ce lucrări preiei.\n\nUrmează detaliile despre câștig și cum preiei lucrări." },
      { subject: "Cum preiei lucrări și cum ești plătit 💸", body:
        "Bună{name}!\n\nFluxul tău de lucru:\n1) Vezi doar solicitările plătite din zona ta.\n2) Te înscrii la cele care ți se potrivesc; clientul te alege după rating și recenzii.\n3) Faci curățenia, anunți «gata pentru oaspeți» și încasezi automat.\n\nBonusuri: adaosurile de vârf (+30%) și weekend/sărbători (+10%) îți cresc și ție partea. Când clientul alege ⚡ urgență (+40%) sau 🔓 rambursabil (+20%), primești și tu partea ta din primă." },
      { subject: "Lenjerie, consumabile, garanție și video 🎥", body:
        "Bună{name}!\n\nMai multe surse de venit:\n• Lenjerie: dacă o speli tu, primești 70% din tarif (50 lei/set). Sau o lași Serviciului de lenjerie.\n• Consumabile: îți recuperezi achiziția + 50% din adaos.\n• La înscriere: o garanție returnabilă care acoperă lenjeria și consumabilele din grija ta.\n• Buton video înainte/după — dovada necesară pentru despăgubiri (Airbnb/Booking).\n\nÎnscrie-te ca PFA/PFI/SRL și preia prima lucrare din zona ta." },
    ],
    spalatorie: [
      { subject: "Bun venit — Serviciu de lenjerie Sleep & Go 🧺", body:
        "Bună{name}!\n\nMulțumim pentru interesul de a deveni Serviciu de lenjerie partener. Procesezi lenjeria din regim hotelier din zona ta — volume constante, plată după procesare.\n\nCâștigi 70% din prețul fiecărui set spălat (50 lei/set), plus partea din consumabile. Urmează detaliile." },
      { subject: "Rute, spălare și distribuție de consumabile 🚐", body:
        "Bună{name}!\n\nCum câștigi:\n• Spălare lenjerie: 70% din tarif (50 lei/set) — speli, calci și returnezi.\n• Consumabile: distribui Agenților Cleaning și primești 30% din adaos (achiziția ți se rambursează).\n• Lenjerie închiriată: o speli tot tu și primești 70% din spălare.\n\nPreiei seturile pe care agentul din zona ta nu le spală, sau o rută întreagă." },
      { subject: "Cum ești plătit și ce îți trebuie 💶", body:
        "Bună{name}!\n\nÎncasezi după ce marchezi lenjeria gata (spălată, călcată, adusă), din avansul deja plătit de client.\n\nDe ce ai nevoie: mașină de spălat profesională + calandru, un autovehicul pentru livrări, spațiu de depozitare și o garanție returnabilă la înscriere.\n\nÎnscrie-te ca PFA/PFI/SRL și preia primele rute din zona ta." },
    ],
    rental: [
      { subject: "Închiriere lenjerii regim hotelier — bun venit 🛏️", body:
        "Bună{name}!\n\nMulțumim pentru interesul față de serviciul de închiriere lenjerii. Nu mai cumperi lenjerie proprie — o închiriezi de la noi: ți-o aducem, o ridicăm după check-out, o spălăm și o returnăm. Zero investiție inițială.\n\nTe contactăm cu tarifele potrivite zonei și numărului de lenjerii de care ai nevoie." },
      { subject: "Ce include un set și cum funcționează circuitul 🧼", body:
        "Bună{name}!\n\nUn set de lenjerie = 1 plic, 1 cearșaf, 2 fețe de pernă, 2 prosoape și 1 prosop de baie. Fiecare set este etichetat individual, ca să nu se încurce cu ale altcuiva.\n\nServiciul de lenjerie ridică lenjeria folosită, o spală și o calcă, apoi o readuce curată — circuitul se repetă la fiecare check-in, fără efort din partea ta." },
      { subject: "Următorii pași și zonele deservite 📍", body:
        "Bună{name}!\n\nAcoperim București (toate sectoarele) și localitățile limitrofe din Ilfov. Îți confirmăm disponibilitatea și tarifele la contact.\n\nPoți combina închirierea de lenjerii cu serviciul complet de curățenie în regim hotelier — o singură platformă pentru tot." },
    ],
  };
}
function ensureNewsletter(st) {
  if (!st.newsletter) st.newsletter = {};
  const n = st.newsletter;
  if (!Array.isArray(n.subs)) n.subs = [];
  if (!n.seq || typeof n.seq !== "object") n.seq = defaultNewsletterSeq();
  else for (const c of NEWSLETTER_CATEGORIES) if (!Array.isArray(n.seq[c])) n.seq[c] = defaultNewsletterSeq()[c];
  if (!(n.intervalDays > 0)) n.intervalDays = 2;
  return n;
}
function unsubUrl(sub) {
  const base = (process.env.PUBLIC_URL || "https://www.sleepandgocleaning.com").replace(/\/$/, "");
  return base + "/api/newsletter/unsubscribe?id=" + encodeURIComponent(sub.id) + "&e=" + encodeURIComponent(sub.email);
}
function renderSeqEmail(step, sub) {
  const name = sub.name ? (" " + String(sub.name).split(/\s+/)[0]) : "";
  const body = String(step.body || "").replace(/\{name\}/g, name);
  const footer = "\n\n—\nSleep & Go Cleaning · " + PHONE
    + "\nDacă nu mai vrei aceste emailuri, dezabonează-te: " + unsubUrl(sub);
  return { subject: step.subject || "Sleep & Go Cleaning", text: body + footer };
}
// Trimite pasul curent al secvenței către un abonat (fără a avansa)
async function sendSeqStep(st, sub, stepIdx) {
  const n = ensureNewsletter(st);
  const seq = (n.seq[sub.category] || []);
  const step = seq[stepIdx];
  if (!step) return { ok: false, done: true };
  const mail = renderSeqEmail(step, sub);
  return sendEmail(sub.email, mail.subject, mail.text);
}
// Motorul drip: trimite pașii scadenți și programează următorul la `intervalDays` zile
let newsletterTimer = null;
async function processNewsletter() {
  try {
    const st = await getState();
    const n = ensureNewsletter(st);
    const now = Date.now();
    const intervalMs = (n.intervalDays || 2) * 86400000;
    let changed = false;
    for (const sub of n.subs) {
      if (sub.unsubscribed || sub.done) continue;
      if (!(sub.nextSendAt <= now)) continue;
      const seq = n.seq[sub.category] || [];
      const idx = sub.step || 0;
      if (idx >= seq.length) { sub.done = true; changed = true; continue; }
      await sendSeqStep(st, sub, idx);           // trimite pasul curent
      sub.step = idx + 1; sub.lastSentAt = now;
      if (sub.step >= seq.length) sub.done = true;
      else sub.nextSendAt = now + intervalMs;
      changed = true;
    }
    if (changed) await saveState(st);
  } catch (e) { console.log("[newsletter] drip eroare:", e.message); }
}
function startNewsletterEngine() {
  if (newsletterTimer) return;
  const everyMs = parseInt(process.env.NEWSLETTER_TICK_MS || (5 * 60 * 1000), 10); // verifică la 5 min
  newsletterTimer = setInterval(processNewsletter, everyMs);
  setTimeout(processNewsletter, 8000); // o primă verificare la scurt timp după pornire
  console.log("[newsletter] motor drip activ (verificare la", Math.round(everyMs / 1000), "s )");
}
// Merge de protecție: clienții NU pot modifica lista de abonați prin /api/state (server = sursă de adevăr)
function mergeNewsletter(prev, next) {
  const pn = (prev && prev.newsletter) || {};
  if (!next.newsletter || typeof next.newsletter !== "object") next.newsletter = {};
  next.newsletter.subs = Array.isArray(pn.subs) ? pn.subs : (Array.isArray(next.newsletter.subs) ? next.newsletter.subs : []);
  // seq + intervalDays: adminul le poate edita din client (incoming câștigă), cu fallback pe server/implicit
  if (!next.newsletter.seq) next.newsletter.seq = pn.seq || defaultNewsletterSeq();
  if (!(next.newsletter.intervalDays > 0)) next.newsletter.intervalDays = pn.intervalDays || 2;
}

/* =========================================================
   REFERRAL — recomandă și câștigă (toate categoriile)
   - Recomanzi pe cineva cu linkul tău (?ref=COD). La înregistrare, noul cont primește referredBy.
   - Câștigi 10% din COMISIONUL platformei pentru primele 3 acțiuni ale celui recomandat
     (3 solicitări finalizate dacă e solicitant / 3 lucrări executate dacă e operator).
   - Plata se face după ce se acumulează 50 €.
   - Registrul (clicuri, credite, plăți) e ținut de server; clienții nu-l pot modifica prin /api/state.
   ========================================================= */
const REF_PCT = 10;          // % din comision
const REF_CAP = 3;           // primele N acțiuni ale recomandatului
const REF_PAYOUT_EUR = 50;   // prag de plată
function ensureReferrals(st) {
  if (!st.referrals || typeof st.referrals !== "object") st.referrals = {};
  const r = st.referrals;
  if (!r.clicks || typeof r.clicks !== "object") r.clicks = {};
  if (!Array.isArray(r.ledger)) r.ledger = [];
  if (!r.paid || typeof r.paid !== "object") r.paid = {};     // plăți cash făcute de admin
  if (!r.spent || typeof r.spent !== "object") r.spent = {};  // credit folosit de solicitant la plata serviciilor
  return r;
}
function genRefCode(st) {
  const AL = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const used = new Set((st.users || []).map(u => u.refCode).filter(Boolean));
  let code; do { code = Array.from({ length: 6 }, () => AL[Math.floor(Math.random() * AL.length)]).join(""); } while (used.has(code));
  return code;
}
function ensureRefCodes(st) {
  for (const u of (st.users || [])) if (!u.refCode) u.refCode = genRefCode(st);
}
function refEarned(st, userId) {
  return round2((st.referrals.ledger || []).filter(e => e.referrerId === userId).reduce((s, e) => s + (Number(e.amountEur) || 0), 0));
}
// sold disponibil = câștigat − plătit cash (admin) − cheltuit pe servicii
function refAvailable(st, userId) {
  const r = ensureReferrals(st);
  return round2(refEarned(st, userId) - (Number(r.paid[userId]) || 0) - (Number(r.spent[userId]) || 0));
}
// Creditează recomandările pentru solicitările nou-finalizate (tranziție reală)
function creditReferrals(prev, next) {
  const oldById = new Map((prev.requests || []).map(r => [r.id, r]));
  ensureReferrals(next);
  const byId = new Map((next.users || []).map(u => [u.id, u]));
  for (const r of (next.requests || [])) {
    if (!reqEnded(r)) continue;
    const old = oldById.get(r.id);
    if (!(old && !reqEnded(old))) continue;          // doar tranziția reală creditează
    const reward = round2((Number(r.commissionEur) || 0) * REF_PCT / 100);
    if (reward <= 0) continue;
    const creditSide = (userId, flag) => {
      if (!userId || r[flag]) return;
      const ru = byId.get(userId); if (!ru || !ru.referredBy) { r[flag] = true; return; }
      const referrer = byId.get(ru.referredBy); if (!referrer || referrer.id === ru.id) { r[flag] = true; return; }
      const cnt = next.referrals.ledger.filter(e => e.referredUserId === ru.id).length;
      if (cnt >= REF_CAP) { r[flag] = true; return; }
      next.referrals.ledger.push({ id: uid("rc"), referrerId: referrer.id, referredUserId: ru.id, reqId: r.id, role: ru.role || "", amountEur: reward, at: Date.now() });
      r[flag] = true;
    };
    creditSide(r.requesterId, "refCreditedRequester");
    creditSide(r.executorId, "refCreditedExecutor");
  }
}
// Protecție: registrul de referral + codurile rămân sub controlul serverului
function mergeReferral(prev, next) {
  next.referrals = (prev && prev.referrals) ? prev.referrals : { clicks: {}, ledger: [], paid: {} };
  const pu = new Map(((prev && prev.users) || []).map(u => [u.id, u]));
  for (const u of (next.users || [])) {
    const o = pu.get(u.id);
    if (o) { if (o.refCode) u.refCode = o.refCode; if (o.referredBy !== undefined && o.referredBy !== null) u.referredBy = o.referredBy; }
  }
  const pr = new Map(((prev && prev.requests) || []).map(r => [r.id, r]));
  for (const r of (next.requests || [])) {
    const o = pr.get(r.id);
    if (o) {
      if (o.refCreditedRequester) r.refCreditedRequester = true;
      if (o.refCreditedExecutor) r.refCreditedExecutor = true;
      if (o.commissionEur && !r.commissionEur) r.commissionEur = o.commissionEur;
    }
  }
}

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
const VIP = { baseRon: 100, extraRon: 50, discountPct: 10, periodDays: 30 };
function vipMonthlyRon(locations) { return VIP.baseRon + VIP.extraRon * (Math.max(1, Number(locations) || 1) - 1); }
function setVipOnState(st, userId, locationIdsCsv, sessionId) {
  const u = (st.users || []).find(x => x.id === userId);
  if (!u) return false;
  let ids = Array.isArray(locationIdsCsv) ? locationIdsCsv.slice()
    : String(locationIdsCsv || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!ids.length) ids = (st.locations || []).filter(l => l.ownerId === userId && l.status === "approved").map(l => l.id);
  ids = [...new Set(ids)];
  const loc = Math.max(1, ids.length);
  const now = Date.now();
  const prevUntil = (u.vip && u.vip.until && u.vip.until > now) ? u.vip.until : now;
  u.vip = { active: true, since: (u.vip && u.vip.since) || now, until: prevUntil + VIP.periodDays * 86400000, locationIds: ids, locations: loc, monthlyRon: vipMonthlyRon(loc), lastPaymentAt: now };
  if (sessionId) u.vip.stripeSessionId = sessionId;
  return true;
}
async function activateVipServer(userId, locationIdsCsv, sessionId) {
  const st = await getState();
  if (!setVipOnState(st, userId, locationIdsCsv, sessionId)) return false;
  await saveState(st);
  console.log("[stripe] VIP activat:", userId);
  return true;
}
const INVEST = { budgetEur: 10000, profitSharePct: 30, minEur: 500 };
async function activateInvestmentServer(userId, amountEur, sessionId) {
  const st = await getState();
  const u = (st.users || []).find(x => x.id === userId);
  if (!u) return false;
  const amt = Math.round((Number(amountEur) || 0) * 100) / 100;
  const now = Date.now();
  const prev = (u.investment && u.investment.active) ? (Number(u.investment.amountEur) || 0) : 0;
  u.investment = { active: true, amountEur: Math.round((prev + amt) * 100) / 100, since: (u.investment && u.investment.since) || now, lastPaymentAt: now };
  if (sessionId) u.investment.stripeSessionId = sessionId;
  await saveState(st);
  console.log("[stripe] Investiție activată:", userId, "·", amt, "€");
  return true;
}
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
      if (s.payment_status === "paid" && s.metadata && s.metadata.vip) {
        await activateVipServer(s.metadata.vip, s.metadata.locationIds, s.id);
      } else if (s.payment_status === "paid" && s.metadata && s.metadata.invest) {
        await activateInvestmentServer(s.metadata.invest, s.metadata.amountEur, s.id);
      } else if (s.payment_status === "paid" && s.metadata && s.metadata.reqId) {
        await markRequestPaid(s.metadata.reqId, s.id);
      }
    }
  } catch (e) { console.log("[stripe] webhook handler err:", e.message); }
  res.json({ received: true });
});

// --- Video-uri înainte/după (dovadă pentru despăgubiri) ---
// Stocate SEPARAT de starea principală (chei kv „vid:<reqId>:<kind>"), ca să nu îngreuneze state-ul.
// Servite ca fișier video direct, pentru <video src=...>. Upload cu limită proprie de corp.
app.get("/api/video/:reqId/:kind", async (req, res) => {
  try {
    const v = await store.get("vid:" + req.params.reqId + ":" + req.params.kind);
    if (!v) return res.status(404).end();
    const m = /^data:([^;]+);base64,(.*)$/.exec(v);
    if (!m) return res.status(404).end();
    res.setHeader("Content-Type", m[1]);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(m[2], "base64"));
  } catch (e) { res.status(500).end(); }
});
app.post("/api/video/:reqId/:kind", express.json({ limit: "35mb" }), async (req, res) => {
  try {
    const uid = readSession(req);
    if (!uid) return res.status(401).json({ ok: false, error: "Neautentificat." });
    const { reqId, kind } = req.params;
    if (kind !== "before" && kind !== "after") return res.status(400).json({ ok: false, error: "Tip invalid." });
    const dataUrl = req.body && req.body.dataUrl;
    if (!dataUrl || typeof dataUrl !== "string" || !/^data:video\//.test(dataUrl))
      return res.status(400).json({ ok: false, error: "Video invalid." });
    const st = await getState();
    const r = (st.requests || []).find(x => x.id === reqId);
    if (!r) return res.status(404).json({ ok: false, error: "Solicitare inexistentă." });
    const me = (st.users || []).find(u => u.id === uid);
    const isAdmin = me && me.role === "admin";
    if (r.executorId !== uid && !isAdmin) return res.status(403).json({ ok: false, error: "Nu ești Agentul Cleaning al acestei lucrări." });
    await store.set("vid:" + reqId + ":" + kind, dataUrl);
    r[kind === "after" ? "videoAfter" : "videoBefore"] = { at: Date.now(), by: uid };
    await saveState(st);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.use(express.json({ limit: "25mb" }));

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
    if (!["solicitant", "executant", "spalatorie", "investitor"].includes(role))
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
    // referral: cod propriu + cine l-a recomandat (din ?ref=COD)
    ensureReferrals(st);
    user.refCode = genRefCode(st);
    const refCode = String(b.ref || "").trim().toUpperCase();
    if (refCode) { const referrer = st.users.find(u => u.refCode === refCode); if (referrer && referrer.id !== id) user.referredBy = referrer.id; }
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
// Elimină datele personale ale solicitanților pentru non-admini (investitorii văd doar agregate)
function sanitizeStateForNonAdmin(st) {
  const out = { ...st };
  out.rentalLeads = (st.rentalLeads || []).map(l => ({ locations: Number(l.locations) || 0, createdAt: l.createdAt }));
  out.offerLeads = (st.offerLeads || []).map(l => ({ createdAt: l.createdAt }));
  return out;
}
app.get("/api/state", async (req, res) => {
  const st = await getState();
  const id = readSession(req);
  const me = (st.users || []).find(u => u.id === id);
  const isAdmin = !!(me && me.role === "admin");
  // nu trimitem parole (ele stau în pw:<id>) și ascundem datele personale ale solicitanților de non-admini
  res.json({ ok: true, state: isAdmin ? st : sanitizeStateForNonAdmin(st), sessionUid: id });
});

app.post("/api/state", async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ ok: false, error: "Neautentificat." });
  const incoming = req.body && req.body.state;
  if (!incoming || typeof incoming !== "object")
    return res.status(400).json({ ok: false, error: "Stare invalidă." });
  // detectăm tranzițiile (start/final curățenie) și marcăm flag-urile pe starea nouă
  let jobs = [];
  try {
    const prev = await getState();
    jobs = markTransitions(prev, incoming);
    mergeNewsletter(prev, incoming);   // abonații rămân sub controlul serverului
    mergeReferral(prev, incoming);     // registrul de referral rămâne sub controlul serverului
    creditReferrals(prev, incoming);   // creditează recomandările la finalizarea solicitărilor
    // doar adminul poate modifica lista de solicitanți (leads); non-adminii primesc versiunea agregată,
    // deci le păstrăm intacte pe cele reale ca să nu le suprascrie / piardă la salvare
    const me = (prev.users || []).find(u => u.id === id);
    if (!(me && me.role === "admin")) { incoming.rentalLeads = prev.rentalLeads || []; incoming.offerLeads = prev.offerLeads || []; }
  } catch (e) { console.log("[notify] diff eșuat:", e.message); }
  // păstrăm parolele intacte: state nu conține parole, deci doar salvăm (cu flag-urile de notificare)
  await saveState(incoming);
  res.json({ ok: true });
  // trimitem notificările DUPĂ ce am răspuns clientului (nu blocăm salvarea)
  for (const j of jobs) notifyRequester(incoming, j.reqId, j.kind).catch(() => {});
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
    // scade creditul din recomandări deja aplicat pe această solicitare
    const ronPerEur2 = ((st.settings || {}).ronPerEur > 0) ? st.settings.ronPerEur : PRICE.ronPerEur;
    const creditBani = Math.round((Number(r.refCreditUsed) || 0) * ronPerEur2 * 100);
    price.baniRon = Math.max(0, price.baniRon - creditBani);
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

// --- Abonament VIP: creează sesiunea de Checkout (încasare în avans) ---
app.post("/api/pay/vip/checkout", async (req, res) => {
  try {
    const uid = readSession(req);
    if (!uid) return res.status(401).json({ ok: false, error: "Neautentificat." });
    if (!stripe) return res.json({ ok: false, error: "stripe_unconfigured" });
    const st = await getState();
    const me = (st.users || []).find(u => u.id === uid);
    if (!me) return res.status(404).json({ ok: false, error: "Cont inexistent." });
    const approved = (st.locations || []).filter(l => l.ownerId === uid && l.status === "approved").map(l => l.id);
    let ids = Array.isArray(req.body && req.body.locationIds) ? req.body.locationIds.filter(x => approved.includes(x)) : [];
    if (!ids.length) ids = approved;
    ids = [...new Set(ids)];
    const locations = Math.max(1, ids.length);
    const monthlyRon = vipMonthlyRon(locations);
    const baniRon = Math.round(monthlyRon * 100);   // lei → bani
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const origin = req.headers.origin || (proto + "://" + req.headers.host);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "ron",
          product_data: { name: "Abonament VIP Member — " + locations + (locations === 1 ? " locație" : " locații"), description: "Acces VIP: 10% reducere la fiecare solicitare · " + VIP.periodDays + " zile" },
          unit_amount: baniRon,
        },
        quantity: 1,
      }],
      metadata: { vip: uid, locations: String(locations), locationIds: ids.join(",") },
      success_url: origin + "/?vip=1&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: origin + "/?vipcancel=1",
    });
    res.json({ ok: true, url: session.url });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- Admin: activează / revocă manual abonamentul VIP (marchează plătit fără Stripe) ---
app.post("/api/vip/admin-set", async (req, res) => {
  try {
    const uid = readSession(req);
    const st = await getState();
    const me = (st.users || []).find(u => u.id === uid);
    if (!me || me.role !== "admin") return res.status(403).json({ ok: false, error: "Doar administratorul." });
    const b = req.body || {};
    const target = (st.users || []).find(u => u.id === b.userId);
    if (!target) return res.status(404).json({ ok: false, error: "Cont inexistent." });
    if (b.active === false) {
      if (target.vip) target.vip.active = false;
    } else {
      if (!setVipOnState(st, b.userId, b.locationIds)) return res.status(400).json({ ok: false, error: "Nu s-a putut activa." });
      target.vip.grantedByAdmin = true;
    }
    await saveState(st);
    res.json({ ok: true, vip: target.vip || null });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- Investiție în sistemul de închiriere lenjerii: Checkout (încasare în avans) ---
app.post("/api/pay/invest/checkout", async (req, res) => {
  try {
    const uid = readSession(req);
    if (!uid) return res.status(401).json({ ok: false, error: "Neautentificat." });
    if (!stripe) return res.json({ ok: false, error: "stripe_unconfigured" });
    const amountEur = Math.round((Number(req.body && req.body.amountEur) || 0) * 100) / 100;
    if (amountEur < INVEST.minEur) return res.status(400).json({ ok: false, error: "Suma minimă este " + INVEST.minEur + " €." });
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const origin = req.headers.origin || (proto + "://" + req.headers.host);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: "Investiție — sistem închiriere lenjerii Sleep & Go", description: INVEST.profitSharePct + "% din profit pe durata acționariatului" },
          unit_amount: Math.round(amountEur * 100),
        },
        quantity: 1,
      }],
      metadata: { invest: uid, amountEur: String(amountEur) },
      success_url: origin + "/?invest=1&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: origin + "/?investcancel=1",
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
    if (s && s.payment_status === "paid" && s.metadata && s.metadata.vip) {
      await activateVipServer(s.metadata.vip, s.metadata.locationIds, s.id);
      return res.json({ ok: true, paid: true, vip: true });
    }
    if (s && s.payment_status === "paid" && s.metadata && s.metadata.invest) {
      await activateInvestmentServer(s.metadata.invest, s.metadata.amountEur, s.id);
      return res.json({ ok: true, paid: true, invest: true });
    }
    if (s && s.payment_status === "paid" && s.metadata && s.metadata.reqId) {
      await markRequestPaid(s.metadata.reqId, s.id);
      return res.json({ ok: true, paid: true, reqId: s.metadata.reqId });
    }
    res.json({ ok: true, paid: false });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- Rambursare (opțiune rambursabilă): 90% înapoi, 10% reținut ---
app.post("/api/pay/refund", async (req, res) => {
  try {
    const uid = readSession(req);
    if (!uid) return res.status(401).json({ ok: false, error: "Neautentificat." });
    const reqId = req.body && req.body.reqId;
    const st = await getState();
    const r = (st.requests || []).find(x => x.id === reqId);
    if (!r) return res.status(404).json({ ok: false, error: "Solicitare inexistentă." });
    if (r.requesterId !== uid) return res.status(403).json({ ok: false, error: "Nu este solicitarea ta." });
    // eligibilitate
    if (!r.refundable) return res.json({ ok: false, error: "Solicitarea nu are opțiunea rambursabilă." });
    if (r.refundedAt) return res.json({ ok: false, error: "Solicitarea a fost deja rambursată." });
    if (!["platit", "acceptat"].includes(r.status))
      return res.json({ ok: false, error: "Rambursarea nu mai e posibilă (lucrarea a început sau e finalizată)." });
    // termen: ora 9:00 în ziua curățeniei (parsare naivă — backstop; gate-ul principal e în client, pe fusul RO)
    const dl = new Date((r.date || "") + "T" + String(PRICE.refundDeadlineHour).padStart(2, "0") + ":00:00");
    if (!(isFinite(dl.getTime()) && Date.now() < dl.getTime()))
      return res.json({ ok: false, error: `Termenul de rambursare (ora ${PRICE.refundDeadlineHour}:00 în ziua curățeniei) a trecut.` });

    const price = priceOfServer(r, st);
    const refundBani = Math.round(price.baniRon * (100 - PRICE.refundRetainPct) / 100);
    const ronPerEur = (st.settings && st.settings.ronPerEur > 0) ? st.settings.ronPerEur : PRICE.ronPerEur;
    const refundEur = round2((refundBani / 100) / ronPerEur);
    const retainedEur = round2(price.totalEur - refundEur);

    // refund real în Stripe (90%), dacă avem sesiunea de plată
    if (stripe && r.stripeSessionId) {
      try {
        const sess = await stripe.checkout.sessions.retrieve(String(r.stripeSessionId));
        const pi = sess && sess.payment_intent;
        if (pi) await stripe.refunds.create({ payment_intent: String(pi), amount: refundBani });
      } catch (e) {
        return res.status(502).json({ ok: false, error: "Rambursarea Stripe a eșuat: " + String(e.message || e) });
      }
    }

    // actualizează starea
    r.status = "anulat";
    r.refundedAt = Date.now();
    r.refundEur = refundEur;
    r.refundRetainedEur = retainedEur;
    r.refundRetainPct = PRICE.refundRetainPct;
    await saveState(st);
    console.log("[stripe] rambursare:", reqId, refundBani, "bani");
    res.json({ ok: true, refundEur, retainedEur });
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

/* ---------------- Newsletter: abonare publică din footer ---------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post("/api/newsletter", async (req, res) => {
  try {
    const b = req.body || {};
    const category = NEWSLETTER_CATEGORIES.includes(b.category) ? b.category : null;
    const email = String(b.email || "").trim().toLowerCase();
    if (!category) return res.status(400).json({ ok: false, error: "Categorie invalidă." });
    if (!EMAIL_RE.test(email)) return res.status(422).json({ ok: false, error: "Email invalid." });
    const st = await getState();
    const n = ensureNewsletter(st);
    // dedupe: dacă există deja (categorie+email) și e activ, nu retrimitem
    let sub = n.subs.find(s => s.category === category && s.email === email);
    if (sub && !sub.unsubscribed) return res.json({ ok: true, already: true });
    if (sub && sub.unsubscribed) {   // reactivare
      sub.unsubscribed = false; sub.done = false; sub.step = 0; sub.nextSendAt = Date.now();
    } else {
      sub = {
        id: uid("sub"), category, email,
        name: String(b.name || "").slice(0, 120), phone: String(b.phone || "").slice(0, 40),
        createdAt: Date.now(), step: 0, nextSendAt: Date.now(), lastSentAt: null, done: false, unsubscribed: false,
      };
      n.subs.push(sub);
    }
    await saveState(st);
    res.json({ ok: true });
    // trimite imediat primul email (pasul 0) și avansează, în fundal
    (async () => {
      try {
        const st2 = await getState(); const n2 = ensureNewsletter(st2);
        const s2 = n2.subs.find(s => s.id === sub.id); if (!s2 || s2.unsubscribed) return;
        const seq = n2.seq[category] || [];
        if ((s2.step || 0) < seq.length) {
          await sendSeqStep(st2, s2, s2.step || 0);
          s2.step = (s2.step || 0) + 1; s2.lastSentAt = Date.now();
          if (s2.step >= seq.length) s2.done = true;
          else s2.nextSendAt = Date.now() + (n2.intervalDays || 2) * 86400000;
          await saveState(st2);
        }
      } catch (e) { console.log("[newsletter] primul email eroare:", e.message); }
    })();
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Dezabonare (link din email) — pagină simplă
app.get("/api/newsletter/unsubscribe", async (req, res) => {
  try {
    const id = String(req.query.id || ""); const email = String(req.query.e || "").toLowerCase();
    const st = await getState(); const n = ensureNewsletter(st);
    const sub = n.subs.find(s => s.id === id && s.email === email);
    if (sub) { sub.unsubscribed = true; await saveState(st); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dezabonare — Sleep & Go Cleaning</title><style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f3f7fc;color:#1f2733;display:grid;place-items:center;min-height:100vh;margin:0}.c{background:#fff;border:1px solid #e3e9f1;border-radius:16px;padding:32px;max-width:440px;text-align:center;box-shadow:0 18px 50px rgba(31,60,110,.12)}h1{font-size:20px;margin:0 0 8px}p{color:#5c6875;line-height:1.6}a{color:#009FE3;font-weight:700;text-decoration:none}</style></head><body><div class="c"><div style="font-size:40px">🧽</div><h1>${sub ? "Te-ai dezabonat" : "Link invalid sau deja folosit"}</h1><p>${sub ? "Nu vei mai primi emailuri de la Sleep & Go Cleaning pe adresa <strong>" + email + "</strong>." : "Nu am găsit abonarea. Poate te-ai dezabonat deja."}</p><p><a href="https://www.sleepandgocleaning.com">← Înapoi la sleepandgocleaning.com</a></p></div></body></html>`);
  } catch (e) { res.status(500).end("Eroare."); }
});

// Admin: șterge un abonat
app.post("/api/newsletter/remove", async (req, res) => {
  try {
    const uidReq = readSession(req);
    const st = await getState();
    const me = (st.users || []).find(u => u.id === uidReq);
    if (!me || me.role !== "admin") return res.status(403).json({ ok: false, error: "Doar administratorul." });
    const id = req.body && req.body.id;
    const n = ensureNewsletter(st);
    const before = n.subs.length;
    n.subs = n.subs.filter(s => s.id !== id);
    await saveState(st);
    res.json({ ok: true, removed: before - n.subs.length });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Admin: compune și trimite acum un email către o categorie (broadcast) — „email composer"
app.post("/api/newsletter/broadcast", async (req, res) => {
  try {
    const uidReq = readSession(req);
    const st = await getState();
    const me = (st.users || []).find(u => u.id === uidReq);
    if (!me || me.role !== "admin") return res.status(403).json({ ok: false, error: "Doar administratorul." });
    const b = req.body || {};
    const category = b.category === "all" ? "all" : (NEWSLETTER_CATEGORIES.includes(b.category) ? b.category : null);
    const subject = String(b.subject || "").trim();
    const bodyTxt = String(b.body || "").trim();
    if (!category) return res.status(400).json({ ok: false, error: "Categorie invalidă." });
    if (!subject || !bodyTxt) return res.status(422).json({ ok: false, error: "Completează subiectul și mesajul." });
    if (!mailer) return res.json({ ok: false, error: "SMTP neconfigurat (setează SMTP_HOST/USER/PASS)." });
    const n = ensureNewsletter(st);
    const targets = n.subs.filter(s => !s.unsubscribed && (category === "all" || s.category === category));
    let sent = 0;
    for (const s of targets) {
      const name = s.name ? (" " + String(s.name).split(/\s+/)[0]) : "";
      const text = bodyTxt.replace(/\{name\}/g, name)
        + "\n\n—\nSleep & Go Cleaning · " + PHONE
        + "\nDezabonare: " + unsubUrl(s);
      const r = await sendEmail(s.email, subject, text);
      if (r.ok) sent++;
    }
    res.json({ ok: true, sent, total: targets.length });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

/* ---------------- Referral: click pe link (public) + plată (admin) ---------------- */
app.post("/api/ref/click", async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || "").trim().toUpperCase();
    if (!code) return res.json({ ok: false });
    const st = await getState(); const r = ensureReferrals(st);
    const exists = (st.users || []).some(u => u.refCode === code);
    if (!exists) return res.json({ ok: false });
    r.clicks[code] = (r.clicks[code] || 0) + 1;
    await saveState(st);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.post("/api/ref/payout", async (req, res) => {
  try {
    const uidReq = readSession(req);
    const st = await getState();
    const me = (st.users || []).find(u => u.id === uidReq);
    if (!me || me.role !== "admin") return res.status(403).json({ ok: false, error: "Doar administratorul." });
    const userId = req.body && req.body.userId;
    const target = (st.users || []).find(u => u.id === userId);
    const iban = target ? (target.refIban || (target.business && target.business.iban) || "") : "";
    if (!iban) return res.json({ ok: false, error: "Utilizatorul nu are IBAN setat — nu se poate vira." });
    const r = ensureReferrals(st);
    const avail = refAvailable(st, userId);          // doar soldul rămas (după credit cheltuit)
    r.paid[userId] = round2((Number(r.paid[userId]) || 0) + Math.max(0, avail));
    await saveState(st);
    res.json({ ok: true, paid: Math.max(0, avail), iban });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
// Solicitantul folosește creditul din recomandări pentru a plăti (parțial/integral) o solicitare
app.post("/api/ref/redeem", async (req, res) => {
  try {
    const uidReq = readSession(req);
    if (!uidReq) return res.status(401).json({ ok: false, error: "Neautentificat." });
    const reqId = req.body && req.body.reqId;
    const st = await getState();
    const r = (st.requests || []).find(x => x.id === reqId);
    if (!r) return res.status(404).json({ ok: false, error: "Solicitare inexistentă." });
    if (r.requesterId !== uidReq) return res.status(403).json({ ok: false, error: "Nu este solicitarea ta." });
    if (r.status !== "nou") return res.json({ ok: false, error: "Solicitarea nu mai poate fi plătită." });
    const ref = ensureReferrals(st);
    const available = refAvailable(st, uidReq);
    if (available <= 0) return res.json({ ok: false, error: "Nu ai credit din recomandări disponibil." });
    const total = round2(priceOfServer(r, st).totalEur - (Number(r.refCreditUsed) || 0));
    const creditUsed = round2(Math.min(available, total));
    if (creditUsed <= 0) return res.json({ ok: false, error: "Nimic de acoperit din credit." });
    ref.spent[uidReq] = round2((Number(ref.spent[uidReq]) || 0) + creditUsed);
    r.refCreditUsed = round2((Number(r.refCreditUsed) || 0) + creditUsed);
    const remaining = round2(total - creditUsed);
    let fullyPaid = false;
    if (remaining <= 0.009) { r.status = "platit"; r.paidAt = Date.now(); fullyPaid = true; }
    await saveState(st);
    res.json({ ok: true, creditUsed, fullyPaid, remainingEur: Math.max(0, remaining), available: refAvailable(st, uidReq) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- SEO: robots.txt + sitemap.xml dinamic (listează articolele de blog) ---
const SITE_URL = (process.env.SITE_URL || "https://www.sleepandgocleaning.com").replace(/\/+$/, "");

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(`User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    const st = await getState();
    const now = Date.now();
    const posts = Array.isArray(st.blog) ? st.blog.filter(p => p && p.published !== false && (!p.publishAt || p.publishAt <= now)) : [];
    const iso = (t) => new Date(t || Date.now()).toISOString();
    const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const staticUrls = [
      { loc: "/", pr: "1.0", cf: "weekly" },
      { loc: "/agenti-cleaning", pr: "0.8", cf: "monthly" },
      { loc: "/serviciu-lenjerie", pr: "0.8", cf: "monthly" },
      { loc: "/inchiriere-lenjerii", pr: "0.7", cf: "monthly" },
      { loc: "/blog", pr: "0.7", cf: "weekly" },
      { loc: "/despre-noi", pr: "0.5", cf: "yearly" },
      { loc: "/termeni-si-conditii", pr: "0.3", cf: "yearly" },
    ];
    const urls = [
      ...staticUrls.map(u => `  <url><loc>${SITE_URL}${u.loc}</loc><changefreq>${u.cf}</changefreq><priority>${u.pr}</priority></url>`),
      ...posts.map(p => `  <url><loc>${SITE_URL}/blog/${xmlEsc(encodeURIComponent(p.slug))}</loc><lastmod>${iso(p.updatedAt || p.publishAt || p.createdAt)}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`),
    ];
    res.type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`
    );
  } catch (e) {
    res.status(500).type("text/plain").send("sitemap error");
  }
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
  try { const st = await getState(); ensureNewsletter(st); ensureReferrals(st); ensureRefCodes(st); await saveState(st); } catch (e) {}
  startNewsletterEngine();   // motor drip newsletter (secvențe email la 2 zile)
  app.listen(PORT, () => console.log("Sleep & Go pe portul " + PORT));
})();
