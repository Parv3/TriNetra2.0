# Deploying Trinetra

Trinetra has two parts:

- **The exam server** — API, proctor console (`/admin`), candidate web app (`/app/`), live video signalling, and the optional PostgreSQL mirror. One per exam/institution.
- **The desktop app** (Electron) — the locked-down exam browser students install. It either runs its own embedded server (single-laptop demo) or connects to a central server.

Pick the setup that matches where the exam happens.

---

## Option A — One exam hall, one proctor laptop (no internet needed)

Good for a lab or classroom where everyone is on the same Wi-Fi.

1. On the proctor laptop: `npm install`, `npm run fetch-models` (once), then `npm start`.
   The proctor console is the **Proctor console** link on the sign-in screen, or `http://localhost:4100/admin`.
2. Allow the app through Windows Firewall on **private networks** when Windows asks.
3. Students join one of two ways:
   - **Browser:** open the HTTPS link shown at the top of the proctor console (`https://<laptop-IP>:5100/app/index.html`). The certificate is self-signed, so each browser shows a warning once — choose *Advanced → Proceed*. HTTPS is required: browsers refuse the camera on plain `http://` from another machine.
   - **Desktop app (stronger lockdown):** install the app on each student machine and put a `trinetra.config.json` next to the executable:
     ```json
     { "serverUrl": "http://<proctor-laptop-IP>:4100" }
     ```
     The desktop app may use plain `http://` because its pages load locally, so the camera still works.

Data lives in `data/proctor_store.json` on the proctor laptop. Back it up after the exam.

## Option B — Central server for many rooms or remote students

### 1. Server (Docker, with HTTPS and PostgreSQL)

Requirements: a Linux VM (2 vCPU / 4 GB is plenty for a few hundred candidates), Docker, a DNS name pointing at it, ports 80/443 open.

```bash
git clone <your repo> trinetra && cd trinetra
cp deploy/.env.example deploy/.env      # set TRINETRA_DOMAIN and POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

This starts PostgreSQL, the Trinetra server (with the PostgreSQL mirror on), and Caddy, which obtains a Let's Encrypt certificate automatically. Then:

- Proctor console: `https://<your-domain>/admin`
- Candidate web app: `https://<your-domain>/app/`
- Teachers' SQL access: see [TEACHER_SQL.md](TEACHER_SQL.md)

Managed alternatives work the same way: run the Docker image on Render, Railway, Fly.io, Azure App Service or AWS (ECS/Lightsail), and set `DATABASE_URL` to a managed PostgreSQL (Neon, Supabase, RDS…). The platform's HTTPS replaces Caddy. Keep exactly **one** server instance — sessions and live video signalling are held in the server's memory.

> The proctor console currently has no login. Before exposing it on the internet, put `/admin` behind your institution's SSO or at least HTTP basic auth on the reverse proxy (e.g. Caddy `basicauth`), or keep the server on a VPN.

### 2. Desktop app for students

```bash
npm run fetch-models   # bundles the phone-detection model for offline use
npm run dist           # Windows installer in release/  (dist:mac / dist:linux on those systems)
```

Ship the installer with a `trinetra.config.json` placed next to the installed `.exe` (or in `%APPDATA%/Trinetra Secure Browser/`):

```json
{ "serverUrl": "https://exams.your-college.edu" }
```

You can also set `TRINETRA_SERVER_URL` instead of the file. Unsigned installers trigger Windows SmartScreen; sign the build with your institution's code-signing certificate for a clean install.

### 3. Exam day

1. Proctor creates the exam in the console and shares the join code.
2. In production the one-time sign-in code is **not** shown to the student: it appears in the proctor console, and the invigilator reads it out after checking the student's ID. (Set `TRINETRA_SHOW_OTP=1` to show it on screen instead, e.g. for remote practice tests.)
3. After the exam, teachers query results and logs in PostgreSQL.

---

## Option C — Free online server on Render

A public `https://` address for the exam server, the student web app and the proctor console, free and without a card. The repository includes a Render Blueprint (`render.yaml`).

**Free plan trade-offs:** the server sleeps after 15 minutes without visitors, and the first visit after that takes about a minute. There is no disk, so the server keeps its data in your Supabase database (`TRINETRA_STATE_IN_DB=1`) and loads it back whenever it starts.

1. **Supabase first.** You need the Session pooler connection string (Supabase → **Connect** → **Session pooler**, with your database password filled in). See *Cloud database* below.
2. **Push the repository to GitHub**, including `render.yaml`.
3. On **render.com**, sign up with GitHub, then **New → Blueprint** and pick the repository. Render reads `render.yaml` and asks for:
   - `DATABASE_URL`: the Session pooler connection string.
   - `ANTHROPIC_API_KEY`: optional, for real AI explanations in Guided help. Leave empty to use the built-in hints.
4. Click **Apply**. The first build takes 5–10 minutes. Your address appears at the top, like `https://trinetra-xxxx.onrender.com`.
5. **Create the owner proctor account.** Open `https://<your-address>/admin`. It asks for a **setup key**: in Render, open the service → **Environment** and copy `TRINETRA_SETUP_KEY`. Enter it with your name and password, and note the Proctor ID it shows.
6. **Check it:** `https://<your-address>/api/system/database` should show `"stateStore":{"enabled":true,…}`.

**How people use it**
- **Proctor:** `https://<your-address>/admin`.
- **Students in the desktop app:** next to "Exam hosted on", click **Change** and enter `https://<your-address>`.
- **Students in a browser** (no lockdown, camera proctoring still on): `https://<your-address>/`.
- **Download page:** `https://<your-address>/download` links to the installer on GitHub Releases (see below).

**Publish the installer on GitHub Releases** so the download page works: on GitHub, open **Releases → Draft a new release**, create the tag `v1.0.0`, attach `release/Trinetra Secure Browser Setup 1.0.0.exe`, and publish.

**Before real exams:** remove `TRINETRA_SHOW_OTP` in Render's Environment tab, so one-time codes go to the proctor console instead of the student's screen. Live video between laptops on different networks uses a public STUN server; strict campus networks may also need a TURN relay.

## Cloud database and Google sign-in (Supabase)

Any Supabase account works. To move Trinetra to a new account or project:

1. **Create a project** at supabase.com (free plan is enough). Note the region.
2. **Create the schema.** Open *SQL Editor → New query*, paste [`supabase/schema.sql`](../supabase/schema.sql) and run it. (Optional: the exam server also creates it on first connect.) Regenerate the file after schema changes with `npm run export-schema`.
3. **Point the app at it.** Put a `trinetra.config.json` next to the installed app (or in `%APPDATA%\Trinetra Secure Browser`), based on `deploy/trinetra.config.example.json`:
   - `databaseUrl` — *Project Settings → Database → Connection string → Session pooler* (contains the database password; keep this file private).
   - `supabaseUrl`, `supabaseAnonKey` — *Project Settings → API*: the project URL and the **publishable** key. Never use the `service_role`/secret key.
   To build these two into the installer instead, edit `"trinetra"` in `package.json` and run `npm run dist`.
4. **Student sign-in by email code (Gmail).** Students type their email, get a code, and stay signed in afterwards.
   - *Authentication → Sign In / Providers → Email*: enabled (it is by default). Keep "Confirm email" on.
   - *Authentication → Emails → Templates → Magic Link*: put the code in the email, for example
     `<h2>Your Trinetra sign-in code</h2><p>Enter this code in the exam browser: <strong>{{ .Token }}</strong></p><p>It expires in 1 hour. If you didn't ask for it, ignore this email.</p>`
     Do the same in the *Confirm signup* template, which is what first-time students receive.
   - *Authentication → SMTP Settings*: Supabase's built-in sender only allows a few emails per hour, enough for testing only. For a class, add your own sender, e.g. Resend (free, 3,000/month) or Gmail (`smtp.gmail.com`, port 587, an app password from a Google account with 2-step verification).
   - Optional, *Authentication → Rate Limits*: raise "emails sent per hour" once custom SMTP is on.
5. **Optional: Google button.** When a Google provider is switched on (*Sign In / Providers → Google*, needs an OAuth client from Google Cloud with redirect `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`, plus `http://localhost:3000/**` under *URL Configuration*), a "Continue with Google" button appears next to the email sign-in. Nothing to change in the app.
6. **Teacher access** — see [TEACHER_SQL.md](TEACHER_SQL.md).

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4100` | HTTP port of the server |
| `HTTPS_PORT` | `PORT + 1000` | Self-signed HTTPS listener for LAN browser candidates |
| `TRINETRA_DISABLE_HTTPS` | — | `1` turns the self-signed listener off (when a proxy provides TLS) |
| `TRINETRA_DATA_DIR` | `./data` | Local data store and certificates |
| `DATABASE_URL` | — | Enables the PostgreSQL mirror (`postgres://user:pass@host:5432/db`); `databaseUrl` in `trinetra.config.json` |
| `TRINETRA_STATE_IN_DB` | off | `1` keeps the server's data in PostgreSQL (`DATABASE_URL`) instead of a file; for hosts without a disk |
| `TRINETRA_SETUP_KEY` | — | Lets the first proctor account be created remotely with this key (cloud servers) |
| `TRINETRA_SHOW_OTP` | off | `1` shows students their own one-time code on screen in production (demos) |
| `JWT_SECRET` | per install | Token signing secret; set it on cloud hosts so sign-ins survive restarts |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | `"trinetra"` in package.json | Supabase project for "Continue with Google"; `supabaseUrl` / `supabaseAnonKey` in `trinetra.config.json` |
| `NODE_ENV` | `development` | `production` disables the demo master code and on-screen OTP |
| `TRINETRA_SHOW_OTP` | — | `1` shows sign-in codes on the student's screen even in production |
| `ANTHROPIC_API_KEY` | — | Enables the AI tutor in Guided help (otherwise proctor hints are used) |
| `TRINETRA_SERVER_URL` | — | Desktop app: use this central server instead of the embedded one |

## Known limits

- One server instance per deployment (in-memory session/video state).
- Live video is peer-to-peer WebRTC. It works on a LAN and across most home networks via STUN; strict corporate or campus firewalls may need a TURN server, otherwise the console falls back to snapshots.
- Earbud detection works from audio device names (Bluetooth and wired headsets), not from the camera image.
