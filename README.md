# Bot Said 22

نظام أتمتة واتساب خاص (للاستخدام الشخصي فقط) — يدعم عدة حسابات واتساب، عدة بوتات، ومحرر تدفق بسيط للردود اليدوية بدون AI.

Système privé d'automatisation WhatsApp (usage personnel uniquement) — supporte plusieurs comptes, plusieurs bots et un éditeur de flux simple pour des réponses manuelles, sans IA.

> **⚠ Important / تحذير مهم**
>
> This app uses **WhatsApp Web (Baileys)** with QR auth — NOT the official Meta WhatsApp Business API. WhatsApp can disconnect or block accounts that exhibit spammy behavior. The system includes guard-rails (per-account FIFO queue, randomized delays, daily caps, cold-start ignore window, idempotency, group filtering, emergency stop) but you must avoid spammy use.
>
> هذا النظام يستعمل واتساب ويب (Baileys) عن طريق رمز QR — وليس واتساب Business API الرسمي. تجنّب الإرسال المكثّف أو المتكرر تفاديا للحظر.

---

## ✨ Features

- 🔐 Secure admin login (bcrypt + JWT cookie, single admin account)
- 📱 Multi-account WhatsApp support with isolated session folders
- 🔗 Live QR-code display via Server-Sent Events
- 🤖 Multi-bot support, link one bot to one or many accounts (with priority)
- 🎬 Media library (image / audio / video / document) with magic-byte validation
- 🌳 Visual flow builder: welcome / keyword / exact-match / option-number / fallback
- 🔢 Numbered menus (1, 2, 3 …) — interactive buttons can be added later
- 💬 Inbox: live conversations, manual replies, status tags, pause-per-contact
- 🛡 Anti-ban hardening: per-account queue, randomized delays, typing simulation, rate limits, daily caps, emergency stop
- 🌍 Bilingual UI: **العربية (RTL)** + **Français**
- 📊 Real-time dashboard with stats and recent messages

---

## 🧱 Architecture

```
┌─ React + Vite + Tailwind (RTL, ar/fr i18n) ───────────────┐
│  Login / Dashboard / Accounts / Bots / Flow / Media       │
│  Inbox / Contacts / Settings / Logs                       │
└──────────────┬─────────────────────────────────────────────┘
   REST + SSE  │
┌──────────────▼─────────────────────────────────────────────┐
│  Express + TypeScript  (auth via JWT cookie)              │
│  routes → services → adapters → Prisma → SQLite           │
└──────────────┬─────────────────────────────────────────────┘
               │
┌──────────────▼─────────────────────────────────────────────┐
│  WhatsAppSessionService  ← Baileys adapter (isolated)     │
│  BotEngineService        ← FlowMatcherService             │
│  MessageQueueService     ← p-queue per account            │
│  MediaService            ← LocalStorage adapter (S3 ready)│
└────────────────────────────────────────────────────────────┘
```

Folder structure: `server/src/{config, http, services, adapters, engine, lib}` and `client/src/{pages, components, api, store, i18n}`. The Baileys library is imported only from `server/src/adapters/whatsapp/BaileysAdapter.ts` — everything else uses the provider-agnostic types.

---

## 🚀 Quick start (development)

```bash
# 1. install everything
npm install

# 2. configure env
cp .env.example server/.env
# then edit server/.env — change JWT_SECRET and ADMIN_PASSWORD

# 3. database (sqlite, no install needed)
npm run db:push
npm run db:seed       # creates admin user + default settings

# 4. run both server and client
npm run dev
```

Then open **http://localhost:5173** and log in with the admin credentials from `.env`.

The client proxies `/api` to `http://localhost:4000`, so both must run.

---

## 📦 Production build

```bash
npm run build
npm start              # runs dist server on PORT (default 4000)
```

Then serve `client/dist` with any static server (nginx, Caddy, …) and reverse-proxy `/api` and `/api/events` (SSE) to the Node server. Make sure the proxy does NOT buffer SSE — for nginx use `proxy_buffering off;` on `/api/events`.

---

## 🚢 Production deploy (single VPS)

**Prereqs:** Ubuntu 22.04+ / Debian 12+, Node 20+, `sqlite3` CLI, [PM2](https://pm2.keymetrics.io/) (`npm i -g pm2`), [Caddy](https://caddyserver.com/) (recommended — handles HTTPS automatically).

**1. Clone, install, provision:**

```bash
git clone <repo-url> bsa && cd bsa
npm ci
cd server && npx prisma db push && cd ..
cp server/.env.example server/.env
$EDITOR server/.env        # set JWT_SECRET, ADMIN_PASSWORD, and any optional flags
```

**2. Build & seed:**

```bash
npm run build
npm run db:seed            # first-time only — creates the admin user
```

**3. Start under PM2 (config: `ecosystem.config.cjs`):**

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                # follow the printed command to persist on reboot
pm2 logs bsa-server        # tail logs
pm2 restart bsa-server     # apply code changes after a `git pull`
```

The config is fork-mode with `instances: 1`. **Do not cluster** — Baileys sessions are stateful in-memory.

**4. HTTPS via Caddy (3-line config):**

Create `/etc/caddy/Caddyfile`:

```
your.domain {
  reverse_proxy /api/* localhost:4000
  root * /path/to/bsa/client/dist
  file_server
}
```

Then `sudo systemctl reload caddy`. Caddy fetches Let's Encrypt certs automatically and forwards SSE untouched.

**5. Hourly SQLite backups:**

```bash
crontab -e
# add:
0 * * * * cd /path/to/bsa && bash deploy/backup-db.sh >> logs/backup.log 2>&1
```

Backup script uses `sqlite3 .backup` (atomic — safe under concurrent writes), gzips, prunes >14 d old.

**6. Health probe** — hit `GET /api/health` for `{ ok, uptimeSec, memMB, dbOk, sessions: { connected: 1, … } }`. Returns 503 when the DB is unreachable so uptime monitors (UptimeRobot / Betterstack) can alert accurately.

**7. Upgrade flow:**

```bash
cd /path/to/bsa
git pull
npm ci
cd server && npx prisma db push && cd ..
npm run build
pm2 restart bsa-server
```

**Optional — error tracking:** set `SENTRY_DSN` in `server/.env` and `cd server && npm i @sentry/node`. Uncaught exceptions and unhandled rejections are shipped alongside the pino logs. Zero cost when the DSN is unset.

**Graceful shutdown:** SIGTERM (what PM2 sends on restart) stops the follow-up engine, closes every WA socket cleanly (credentials preserved so no re-QR needed), then disconnects Prisma. Deadline: 10 s.

---

## 🔄 Switching to PostgreSQL

Open `server/prisma/schema.prisma`, change:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Update `DATABASE_URL` in `server/.env` (`postgresql://user:pass@host:5432/db`), then:

```bash
npm run db:push
npm run db:seed
```

All queries are written to be portable; no SQLite-specific or Postgres-specific features are used.

---

## 📖 How it works

### 1. Connect a WhatsApp account

1. **Comptes WhatsApp / حسابات واتساب** → "إضافة حساب / Ajouter un compte"
2. Click on the new card → click **Connecter / الاتصال**
3. A QR code appears live (Server-Sent Events)
4. On your phone: WhatsApp → Settings → Linked devices → Link a device → scan the QR
5. Status flips to **متصل / Connecté** automatically

The session credentials are saved in `storage/sessions/<accountId>/`. After a server restart, the system auto-reconnects.

### 2. Create a bot and link it

1. **Bots** → "Créer un bot / إنشاء بوت"
2. Open the bot → in the "Linked accounts" card, click an account chip to link/unlink
3. A bot can be linked to many accounts; an account can be claimed by many bots — `priority` resolves ties (higher wins)

### 3. Build the flow (welcome + numbered menu)

1. In the bot editor click **Add a node** → choose **Welcome**
   - Title: `Welcome`
   - Response text:
     ```
     السلام عليكم، مرحبا بك. اختار السؤال اللي بغيتي:
     1 - شنو هو المنتج؟
     2 - شحال الثمن؟
     3 - طريقة الاستعمال
     4 - التوصيل
     5 - بغيت نطلب
     ```
2. Add a node for each answer (e.g. "Product info", trigger type **option_number**, response text = your answer)
3. On the Welcome node, click **Add option** five times. Set:
   - `optionNumber` = `1`, `targetNode` = the matching answer node
   - repeat for 2..5
4. Add a **Fallback** node (response: "Désolé, je n'ai pas compris…")
5. Save

When a customer first writes, the engine sends the welcome node + numbered list automatically. When they reply `1`, it sends the linked answer.

### 4. Media

**Médiathèque / مكتبة الوسائط** → upload images/audio/video/PDF. Then in the flow editor, attach a file to any node — it will be sent in order, after the response text.

Supported types & size caps: images/audio/docs ≤ 25 MB, video ≤ 100 MB. MIME is verified by magic bytes, not by client header.

### 5. Inbox

Live conversation view per contact. You can:
- Send manual text or media
- Pause/resume the bot for a single contact
- Change contact status (new / interested / ordered / rejected / needs_human)

### 6. Safety settings

In **Settings / Paramètres**:
- `Bot globally enabled` — global on/off
- `Emergency stop` — kills all outgoing immediately
- `Min/Max send delay (ms)` — randomized delay between sends (1200–3500 default)
- `Per-contact rate per minute / hour` — protection against loops
- `Cold-start ignore (seconds)` — drops messages older than N seconds after restart
- `Handover keywords` — when matched, contact is marked `needs_human`, bot pauses for them, and a configured handover message is sent

---

## 🧪 Testing checklist

- [ ] Login with seeded admin works; wrong password rejected
- [ ] Switch UI between AR/FR — RTL/LTR flips correctly
- [ ] Create WhatsApp account, click Connect → QR appears within ~5s
- [ ] Scan QR → status changes to `connected` automatically
- [ ] Create a bot, link the account, create welcome + 2 option nodes
- [ ] From a different phone, send first message → welcome arrives
- [ ] Reply `1` → option 1 answer arrives
- [ ] Reply with a handover keyword → bot pauses for that contact, status = needs_human
- [ ] Toggle `Emergency stop` on → no replies sent until toggled off
- [ ] Restart server → previously-connected accounts auto-reconnect; old messages are NOT replayed
- [ ] Upload image/audio/video/pdf → preview works in media library
- [ ] Attach media to a flow node → media is sent in order after text
- [ ] Inbox: send manual text/media; pause/resume bot for a contact

---

## 🚢 Deployment notes

Recommended for a single private server:

- Node 20+
- Run server with `pm2` (`pm2 start dist/index.js --name bsa`)
- nginx reverse proxy:
  - `/` → `client/dist`
  - `/api/` → `http://127.0.0.1:4000` (SSL terminated at nginx)
  - **Important** for SSE: `location /api/events { proxy_pass ...; proxy_buffering off; proxy_http_version 1.1; proxy_set_header Connection ''; }`
- Backup script: tarball `server/prisma/dev.db` + `storage/sessions/` + `storage/media/` daily

---

## 📁 Project layout

```
.
├── server/
│   ├── src/
│   │   ├── adapters/whatsapp/BaileysAdapter.ts   ← only file importing baileys
│   │   ├── adapters/storage/                      ← local storage (S3-ready)
│   │   ├── services/                              ← business logic
│   │   ├── engine/                                ← (reserved for future engine modules)
│   │   ├── http/                                  ← Express app, routes, middleware
│   │   ├── lib/                                   ← prisma, jid, retry helpers
│   │   ├── config/                                ← env, logger
│   │   └── index.ts                               ← bootstrap
│   └── prisma/
│       ├── schema.prisma
│       └── seed.ts
│
├── client/
│   └── src/
│       ├── pages/                                 ← Login, Dashboard, Accounts, Bots, …
│       ├── components/                            ← layout + ui + domain components
│       ├── api/                                   ← REST + SSE clients
│       ├── store/                                 ← Zustand stores
│       └── i18n/                                  ← ar.ts + fr.ts
│
└── storage/
    ├── sessions/<accountId>/                      ← Baileys MultiFileAuthState
    └── media/<yyyy>/<mm>/                         ← uploaded files
```

---

## 🔐 Default credentials

- username: `admin`
- password: `admin1234` ⚠ change this in `server/.env` (`ADMIN_PASSWORD`) **before** running `npm run db:seed`. Re-running seed updates the password.

---

## 🆘 Troubleshooting

- **QR doesn't appear** → check browser console for SSE errors; ensure proxy is not buffering on `/api/events`.
- **Account stuck in "connecting"** → likely a dropped session; click *Disconnect* then *Connect*. If it persists, click *Logout (wipe session)* and re-pair.
- **Messages not arriving** → check Settings → `Bot globally enabled` and `Emergency stop`; check the bot is `isActive` and linked to the account; check the contact isn't `botPaused`.
- **WhatsApp banned the number** → reduce `dailySendCap` and `min/max send delay`; do NOT use the bot for unsolicited bulk messages.

---

Built with: Node.js • TypeScript • Express • Prisma • SQLite • Baileys • React • Vite • Tailwind • Zustand
