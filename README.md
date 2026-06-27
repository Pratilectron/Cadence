# Cadence

Quiet rooms, loud ideas — a real-time chat app with rooms, roles, media uploads, and an admin panel.

## Features

- Real-time messaging (Socket.IO)
- Public, private, and locked rooms
- Discord-style per-room roles and permissions
- File, image, audio, emoji, and GIF attachments
- Screen recording with preview
- Activity logs and themed image lightbox
- Super-admin panel (users, rooms, storage, settings)

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Configure super admins in `.env`:

```
SUPER_ADMIN_USERNAMES=you@example.com
```

**Never commit `.env`** — it is gitignored. Copy from `.env.example` only. Run `npm run check-secrets` before pushing to catch accidental staging.

Optional: enable the bundled pre-commit hook (one-time, per clone):

```bash
git config core.hooksPath .githooks
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run the server |
| `npm run dev` | Run with file watch |
| `npm test` | Smoke tests |
| `npm run check-secrets` | Block commits of `.env`, `data/`, keys |
| `npm run deploy` | Pull latest code, install deps, Passenger reload (server) |
| `npm run restart` | Local dev: free port and start server. On DirectAdmin/Passenger, touches `tmp/restart.txt` instead |

## Automated updates

Cadence can auto-deploy when you push to `main`.

### Option A — GitHub Actions (recommended)

1. On the **server**, set in DirectAdmin env vars:
   - `DEPLOY_WEBHOOK_SECRET` — long random string
2. In **GitHub** → repo → Settings → Secrets and variables → Actions, add:
   - `DEPLOY_WEBHOOK_URL` — `https://yourdomain.com/api/deploy/webhook`
   - `DEPLOY_WEBHOOK_SECRET` — same value as on the server
3. Push to `main`. CI runs tests, then the Deploy workflow calls your webhook.

### Option B — GitHub repository webhook

1. Set `DEPLOY_WEBHOOK_SECRET` on the server.
2. GitHub → Settings → Webhooks → Add webhook:
   - **Payload URL:** `https://yourdomain.com/api/deploy/webhook`
   - **Content type:** `application/json`
   - **Secret:** same as `DEPLOY_WEBHOOK_SECRET`
   - **Events:** Just the push event
3. Only pushes to `main` are applied (override with `DEPLOY_BRANCH`).

### Option C — Cron polling (no webhook)

On the server, add a cron job (every 5–15 minutes):

```bash
*/10 * * * * cd /path/to/cadence && bash scripts/poll-updates.sh
```

### Manual deploy on server

```bash
npm run deploy
```

This runs `git pull`, `npm install --omit=dev`, and touches `tmp/restart.txt` (Passenger reload).

## Production (DirectAdmin / Passenger)

Cadence runs as a plain Node.js HTTP server (no Express). It is compatible with DirectAdmin **Setup Node.js App** and Phusion Passenger.

### Deploy workflow

On the server after each push to `main`:

```bash
git pull origin main
npm install --omit=dev
npm run restart
```

`npm run restart` on the server only writes `tmp/restart.txt` (Passenger reload). **Do not use `npm start` on DirectAdmin** — Passenger already runs `server.js`.

Or click **Restart** in the DirectAdmin Node.js panel (recommended after deploy).

**Important:** After `git pull`, always click **Run NPM Install** in the Node.js app panel, then **Restart**.

Cadence ships a **bundled SQLite** (`vendor/sql-asm.js`) so the database works even when native modules fail. NPM Install only needs to succeed for `socket.io`, `busboy`, and `dotenv` — heavy packages (`sharp`, `@tensorflow/tfjs`, `nsfwjs`) are optional and enable image moderation when they install.

To diagnose module issues on the server: `npm run check-host`

To rebuild native modules (`better-sqlite3`, `sharp`) for your Node version after install:

```bash
npm run install-native
```

On DirectAdmin, run that via SSH from the application root after `npm install`, or use **Run NPM Install** then restart.

### DirectAdmin panel settings

| Setting | Value |
|---------|--------|
| Application root | Project directory (contains `server.js`) |
| Application startup file | `server.js` |
| Application mode | Production |

### Required environment variables (hosting panel)

Set these in DirectAdmin → **Setup Node.js App** → **Environment variables** (not in Git):

| Variable | Example | Purpose |
|----------|---------|---------|
| `PUBLIC_URL` | `https://yourdomain.com` | CORS origins + startup logs |
| `ALLOWED_ORIGINS` | `https://yourdomain.com` | Socket.IO CORS (must match your site) |
| `SUPER_ADMIN_USERNAMES` | `you@example.com` | Admin panel access |
| `NODE_ENV` | `production` | Recommended for production |

`PORT` is assigned automatically by Passenger — **do not set `PORT` in the panel or `.env` on production**.

### Notes

- `.env` is optional locally via `dotenv`; production values should live in the hosting panel.
- Persistent data lives in **`data/cadence.db`** (SQLite) plus upload files — ensure `data/` is writable.
- On shared hosting without native module builds, Cadence falls back to **sql.js** automatically if `better-sqlite3` is unavailable. Run **NPM Install** in your hosting panel after each deploy (do not upload `node_modules` from your PC).
- Health check: `GET /api/health`
- **Content moderation:** NSFWJS scans images and screen-record frames client-side; server re-checks image uploads (`NSFW_ENABLED` in env)
- WebSockets (`/socket.io`) must be enabled on your web server (Apache `mod_proxy_wstunnel` or equivalent).

## Stack

Node.js, Socket.IO, Busboy — static frontend with Motion One animations.

## License

MIT
