# Trinetra — Smart Proctoring Browser

A locked-down exam browser with AI webcam proctoring, built for the **Where U Elevate** problem statement: MCQ tests that students can't cheat on with a second tab, ChatGPT, a phone or someone else in the room.

Students take the exam in a Windows desktop app. The proctor's laptop runs the same app as the exam server, so one laptop can run a whole exam hall over Wi-Fi, with no internet needed. Proctors watch everything from a web console: live video, violations with snapshots, searches and sites visited, and a full report per student.

---

## Features

**For students**
- Join with an exam code, name and roll number; verify with a one-time code, or sign in with Gmail once and stay signed in
- Camera check that records a face baseline for identity checks
- Full-screen, always-on-top exam window with a status bar: clock, battery and time remaining, network, camera, time left and warnings
- Tabs for looking things up, filtered so searches must relate to the question; AI chat sites are blocked
- **Guided help**: an AI tutor that explains the concept but never gives the answer
- Scheduled exams show a live "starts in" countdown

**For proctors**
- Proctor accounts with IDs like `PR-ABCDE`; the owner adds or disables other proctors
- Exam builder with JSON import, opening and closing times, strictness level and number of warnings allowed
- Live dashboard: every student, live webcam video, violations as they happen with evidence snapshots
- Resume an attempt that ended on a false alarm
- Per-student report with an integrity score, a timeline, searches and sites visited, plus export
- `/download` page that serves the installer to students over the LAN
- Optional cloud copy of all activity in PostgreSQL / Supabase, with read-only SQL access for teachers

**What gets detected**

| Area | Signals |
|---|---|
| Camera | No face, more than one face, looking away, looking down, a different person, a phone in view |
| Browser | AI sites, pasting the question into a search, searches unrelated to the question, every address visited |
| Device | Leaving full screen, minimising, focus moving to another app, a second display, screen-sharing or remote-desktop programs, DevTools, a new camera or Bluetooth earpiece appearing |
| Input | Copy and paste, blocked shortcuts, typing rate |

---

## Architecture

```
 STUDENT LAPTOP (Trinetra desktop app)                 PROCTOR LAPTOP (same app = exam server)
 ┌───────────────────────────────────────┐             ┌───────────────────────────────────────┐
 │ Electron main process                 │             │ Express API  :4100 (HTTP)             │
 │  • Window lock (kiosk, always on top) │   REST      │              :5100 (HTTPS for LAN)    │
 │  • Tab manager + search policy        │◄──────────► │ WebSocket    /ws/proctor (live events)│
 │  • Integrity monitor (displays,       │  WebSocket  │ JSON datastore (local file)           │
 │    processes, focus, DevTools)        │             │   └─► optional PostgreSQL mirror       │
 │ Renderer (sandboxed UI)               │             │        (Supabase, schema "trinetra")  │
 │  • Exam UI, timer, status bar         │  WebRTC     │ Proctor console (browser, /admin)     │
 │  • face-api.js + COCO-SSD on webcam   │◄═══════════►│  • live video grid, alerts, reports   │
 └───────────────────────────────────────┘  video P2P  └───────────────────────────────────────┘
```

- **AI runs on the student's laptop.** The server receives events and evidence snapshots, never a continuous video upload.
- **Live video is peer-to-peer** (WebRTC). The server only relays the connection setup.
- **The server owns the timer and the rules.** The student's app displays them but can't change them.
- **Works offline.** Everything runs over the local network; the cloud database is optional.

---

## Tech stack

### Desktop app
| Technology | Used for |
|---|---|
| **Electron 33** | Desktop shell. Main process for window lock, tabs, integrity checks; sandboxed renderer for the UI |
| `WebContentsView` | Browsing tabs, each one routed through the search policy |
| `contextBridge` preload | The only bridge between UI and main process (`window.proctorAPI`); context isolation and sandbox on, no Node in pages |
| `setKiosk`, `setAlwaysOnTop`, `setContentProtection` | Full-screen lock, staying above other windows, blocking screenshots and screen recording |
| `screen` events, `tasklist` / `ps` | Detecting a second display and screen-sharing or remote-desktop programs (scanned every 20 s) |
| **electron-builder 25** | Windows NSIS installer (per-user, no admin rights needed) |

### Frontend
| Technology | Used for |
|---|---|
| HTML, CSS, vanilla JavaScript | Student app and proctor console, no framework |
| Inter, IBM Plex Mono | Typography, styled to Where U Elevate's brand (blue `#006FDB`, amber `#FFBD59`) |
| Battery Status API, Network Information API | Status bar battery, time remaining and connection quality |
| `navigator.mediaDevices` | Webcam, and watching for new cameras or Bluetooth earpieces |
| WebRTC (`RTCPeerConnection`) | Live webcam video from student to proctor |

### AI and computer vision (on the device)
| Technology | Used for |
|---|---|
| **TensorFlow.js 4.22** | Runs every model in the app, WebGL-accelerated where available |
| **face-api.js** (`@vladmandic/face-api` 1.7) | TinyFaceDetector for face count, 68-point landmarks for head pose and gaze, FaceRecognitionNet for identity |
| **COCO-SSD** (SSDLite MobileNet v2) | Phone detection ("cell phone" and "remote" classes) |
| Custom heuristics | Head yaw and pitch, eye position, smoothing and timing rules so glances don't count (see below) |

### AI assistant
| Technology | Used for |
|---|---|
| **Claude API** (`@anthropic-ai/sdk`, model `claude-opus-5-5`) | Guided help that explains concepts and is instructed never to reveal the answer |
| Offline fallback | The proctor's hint for each question, used with no internet or API key |
| Wikipedia API | "Look it up" panel for safe reference reading |

### Backend
| Technology | Used for |
|---|---|
| **Node.js 20+**, **Express 4** | REST API, student web app, proctor console |
| **ws 8** | WebSocket for live events and WebRTC signalling |
| `selfsigned` | Self-signed HTTPS certificate so browsers on other laptops allow the camera |
| `node:crypto` | One-time codes (`randomInt`), password hashing (`scrypt`), token signing (HMAC-SHA256), timing-safe comparisons |
| Timer service | Server-side timer: checks every second, 2 s network grace, clock-tampering check |

### Data
| Technology | Used for |
|---|---|
| JSON datastore | Primary store on the exam server, saved to disk about once a second; works fully offline |
| **PostgreSQL** (`pg` 8) on **Supabase** | Optional live copy of all activity: 11 tables in schema `trinetra`, report views, row-level security, read-only `trinetra_reader` role for teachers |
| MongoDB driver | Optional legacy store; skipped when no MongoDB is running |

### Authentication and security
| Technology | Used for |
|---|---|
| JWT (HS256) | Session tokens, signed with a secret generated per install |
| scrypt + timing-safe compare | Proctor passwords |
| Role-based middleware | Every proctor route and the proctor WebSocket require a proctor login; a student token gets 403 |
| **Supabase Auth** | Student sign-in by emailed code (Gmail), refresh tokens to stay signed in; Google sign-in when switched on |
| Loopback-only owner setup | The first proctor account can only be created on the host laptop itself |

### Testing, tooling and deployment
| Technology | Used for |
|---|---|
| `node:test` | 166 unit and integration tests |
| Custom end-to-end harness | 141 end-to-end tests across four tiers (features, edge cases, interactions, scenarios) |
| `pg-mem` | In-memory PostgreSQL for the database tests |
| Docker, Docker Compose, Caddy | Central server deployment with HTTPS and PostgreSQL (`deploy/`) |

---

## How the proctoring works

**Camera pipeline (in `src/renderer/js/proctorClient.js`)**
1. Faces and landmarks are detected on webcam frames. Head turn and tilt are estimated from the landmarks and smoothed over recent frames.
2. A condition becomes a warning only if it **lasts** long enough and appears in most frames in that time:

   | Strictness | No face | Two faces | Looking away | Looking down | Phone |
   |---|---|---|---|---|---|
   | Relaxed | 4 s | 2 s | 6 s | 7 s | 2.5 s |
   | Standard | 3 s | 1.5 s | 3.5 s | 4.5 s | 2 s |
   | Strict | 2 s | 1 s | 2.5 s | 3 s | 1.5 s |

3. **Identity:** every 5 seconds the face is compared with the baseline from the camera check. Two mismatches in a row are reported.
4. **Phone:** COCO-SSD checks the full frame and one zoomed crop each time, rotating between the hands and lap, the left side and the right side, because a phone in a hand is tiny at the model's 300 px input. It must be seen in 2 of the last 5 checks.
5. Each warning saves a snapshot with the detected face or phone outlined.

**Warnings and the timer**
- Each confirmed violation is one warning. On the last one (3 by default), answers are submitted automatically and the attempt is marked for review. The proctor can resume it.
- The server decides when an attempt starts and ends. Changing the laptop clock doesn't help, and scheduled exams refuse early or late starts on the server.

**Browser policy (in `src/main/searchPolicy.js`)**
- AI chat sites are blocked.
- Google searches are forced to web-only results (`udm=14`), which removes AI Overviews and answer boxes.
- A search that pastes the question, or has nothing to do with it, is refused. Every address and search is logged.

---

## Project structure

```
src/
  main/        Electron main process: window, tabs, search policy, integrity monitor, IPC
  preload/     contextBridge API exposed to the UI
  renderer/    Student app (index.html) and proctor console (admin.html), styles, vendored TF.js
  backend/     Express server: routes, services, datastore, Postgres mirror, auth middleware
  worker/      Vision web worker
assets/models/ face-api and COCO-SSD weights (bundled for offline use)
supabase/      schema.sql for the cloud database
samples/       Example question set (data-structures-mcqs.json)
deploy/        Docker Compose and config example
docs/          DEPLOYMENT.md, TEACHER_SQL.md
test/, e2e/    Unit/integration tests and end-to-end suite
```

---

## Getting started

Requires **Node.js 20+** and Windows 10/11 (macOS and Linux builds are possible but untested).

```bash
npm install
npm run fetch-models   # vendors the phone-detection model for offline use
npm start              # runs the desktop app with its embedded exam server
```

- **Proctor console:** press **Ctrl+Shift+P** on the app's start screen, or open `http://localhost:4100/admin`. The first visit on the host laptop creates the owner account and shows its proctor ID.
- **Other laptops:** in the app, next to "Exam hosted on", click **Change** and enter the address shown at the top of the console.
- **Try it:** create an exam and import `samples/data-structures-mcqs.json`.

```bash
npm test               # unit and integration tests
npm run test:e2e       # end-to-end suite
npm run dist           # builds release/Trinetra Secure Browser Setup <version>.exe
```

---

## Configuration

Settings come from environment variables, or from a `trinetra.config.json` next to the app or in `%APPDATA%\Trinetra Secure Browser` (see `deploy/trinetra.config.example.json`).

| Setting | Purpose |
|---|---|
| `serverUrl` / `TRINETRA_SERVER_URL` | Point students' apps at a central exam server instead of the embedded one |
| `databaseUrl` / `DATABASE_URL` | PostgreSQL / Supabase connection string for the cloud copy |
| `supabaseUrl`, `supabaseAnonKey` | Supabase project for email and Google sign-in (defaults in `"trinetra"` in `package.json`) |
| `ANTHROPIC_API_KEY` | Enables Claude for Guided help |
| `PORT`, `MAX_STRIKES`, `ENFORCE_AUTH` | Server port, default warnings, strict auth outside production |
| `TRINETRA_STATE_IN_DB`, `TRINETRA_SETUP_KEY`, `TRINETRA_SHOW_OTP` | Cloud server: data in PostgreSQL, remote owner setup, codes on screen for demos |

**Online server:** deploy free on Render with the included `render.yaml`. Full setup, including Supabase, email sign-in and the Docker server: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. Teacher SQL access: **[docs/TEACHER_SQL.md](docs/TEACHER_SQL.md)**.

---

## Known limits

- The installer isn't code-signed yet, so Windows shows "Windows protected your PC" (More info → Run anyway).
- Email sign-in needs your own email sender in Supabase; the built-in one only emails the project's team.
- Some campus networks block database ports and stop laptops from reaching each other. A phone hotspot avoids both.
- The installed app runs in development mode, which shows the one-time code on the student's screen. Turn on production mode before real exams.
