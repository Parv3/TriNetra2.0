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

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4100` | HTTP port of the server |
| `HTTPS_PORT` | `PORT + 1000` | Self-signed HTTPS listener for LAN browser candidates |
| `TRINETRA_DISABLE_HTTPS` | — | `1` turns the self-signed listener off (when a proxy provides TLS) |
| `TRINETRA_DATA_DIR` | `./data` | Local data store and certificates |
| `DATABASE_URL` | — | Enables the PostgreSQL mirror (`postgres://user:pass@host:5432/db`) |
| `NODE_ENV` | `development` | `production` disables the demo master code and on-screen OTP |
| `TRINETRA_SHOW_OTP` | — | `1` shows sign-in codes on the student's screen even in production |
| `ANTHROPIC_API_KEY` | — | Enables the AI tutor in Guided help (otherwise proctor hints are used) |
| `TRINETRA_SERVER_URL` | — | Desktop app: use this central server instead of the embedded one |

## Known limits

- One server instance per deployment (in-memory session/video state).
- Live video is peer-to-peer WebRTC. It works on a LAN and across most home networks via STUN; strict corporate or campus firewalls may need a TURN server, otherwise the console falls back to snapshots.
- Earbud detection works from audio device names (Bluetooth and wired headsets), not from the camera image.
