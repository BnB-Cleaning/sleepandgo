# Sleep & Go Cleaning — platformă (Node + Railway)

Aplicație de curățenie regim hotelier cu backend real (multi-utilizator).

- **Front-end**: `public/index.html` (o singură pagină, self-contained)
- **Back-end**: `server.js` (Express) — API auth + stare partajată
- **Bază de date**: PostgreSQL pe Railway (se creează singură la pornire)

## Deploy pe Railway (din GitHub)

1. Urcă acest folder într-un repo GitHub.
2. Pe [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → alege repo-ul.
3. În proiect: **+ New** → **Database** → **Add PostgreSQL**.
4. La serviciul web → tab **Variables** → adaugă:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referință către baza Postgres)
   - `ADMIN_EMAIL` = emailul tău de admin
   - `ADMIN_PASSWORD` = o parolă sigură (adminul se creează automat cu ea)
   - `SESSION_SECRET` = un text lung, aleatoriu
5. Railway face build (`npm install`) și pornește (`npm start`). Serverul creează singur tabelele și contul admin.
6. La serviciul web → **Settings** → **Networking** → **Generate Domain** → primești un URL public (ex. `sleepandgo.up.railway.app`).

## Domeniu propriu (opțional, mai târziu)
În Railway → Settings → Networking → **Custom Domain** → `sleepandgocleaning.com`, apoi setezi CNAME-ul indicat în DNS.

## Local (dev)
```
npm install
npm start
```
Fără `DATABASE_URL`, folosește un fișier local `.data/kv.json` (doar pentru test).
