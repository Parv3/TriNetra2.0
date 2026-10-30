# Project: Smart Proctoring Browser Desktop Application

## Architecture

The Smart Proctoring Browser is a self-contained, competition-grade desktop application for secure MCQ assessments. It combines an Electron desktop shell, an embedded local Node/Express backend service, an offline AI vision proctoring pipeline running in a dedicated Web Worker, and an opaque-box multi-tab browser with intelligent AI/search query tracking.

```
+--------------------------------------------------------------------------------------------------+
|                                  ELECTRON MAIN PROCESS                                           |
|  - App lifecycle, BrowserWindow host, native window management                                  |
|  - Embedded Express backend lifecycle controller (127.0.0.1:4100 with dynamic fallback)          |
|  - Secure session partitions ('persist:guest-session') & web navigation interceptors            |
|  - IPC Router (window controls, audit bridge, backend port exposure)                            |
+------------------------------------+-------------------------------------------------------------+
                                     |
                 +-------------------+--------------------+
                 |                                        |
+----------------v--------------------+  +----------------v----------------------------------------+
|       PRELOAD BRIDGE SCRIPTS        |  |               LOCAL BACKEND SERVICE                    |
| - Host Preload: contextBridge       |  | - Express REST API on 127.0.0.1:4100                   |
|   (proctorAPI for renderer)         |  | - Atomic JSON / In-Memory DataStore (zero native C++)  |
| - Guest Preload: Injected in guest  |  | - OTP & Facial verification auth engine                |
|   tabs (ChatGPT/Claude prompt hooks,|  | - MCQ Question Bank & sanitized question delivery      |
|   DOM listeners, keystroke loggers) |  | - Server-authoritative countdown timer & sweeper       |
+----------------+--------------------+  | - Real-time proctoring & tab/search/input log store    |
                 |                       | - Automated test suite (node:test)                     |
+----------------v--------------------+  +--------------------------------------------------------+
|        RENDERER PROCESS (Host UI)   |
|  - Slate/Zinc responsive design     |
|  - [View 1] Student Auth & Preflight|
|  - [View 2] Active MCQ Exam & Timer |
|  - [View 3] Auditor Review & History|
|  - Docked live webcam self-view     |
|  - Tab strip & Omnibox navigation   |
+----------------+--------------------+
                 | 10 FPS frames (OffscreenCanvas)
+----------------v--------------------+
|   AI PROCTORING WEB WORKER          |
| - @vladmandic/human (offline)       |
| - BlazeFace, FaceMesh 468, Iris     |
| - 3D Head Pose (Euler Yaw/Pitch/Roll)|
| - Eye Gaze Diversion & EAR Blinks   |
| - Temporal Hysteresis & Strikes     |
| - Disqualification trigger          |
+-------------------------------------+
```

---

## Feature Inventory

Every feature identified during the comprehensive technical survey is cataloged and assigned to a specific milestone.

| # | Feature ID | Feature Name | Description | Milestone | Source |
|---|---|---|---|---|---|
| 1 | F-BE-01 | Local HTTP Server & Port Discovery | Embedded Express server bound to 127.0.0.1:4100 with dynamic fallback | M1 | survey_3 |
| 2 | F-BE-02 | Atomic JSON DataStore Engine | Crash-safe atomic JSON persistence with in-memory caching (zero native C++) | M1 | survey_3 |
| 3 | F-BE-03 | Student OTP Authentication | Secure 6-digit OTP generation, validation, and bearer session tokens | M1 | survey_3 |
| 4 | F-BE-04 | Facial Baseline Registration | API endpoint to store candidate reference photo and mark biometric verification | M1 | survey_3 |
| 5 | F-BE-05 | MCQ Question Bank & Sanitized Delivery | Serves randomized MCQs with answer keys stripped during active testing | M1 | survey_3 |
| 6 | F-BE-06 | Incremental Answer Saving & State | State-persisted answer selections per question with review flag | M1 | survey_3 |
| 7 | F-BE-07 | Server-Authoritative Timer & Heartbeat | Server-anchored start/expiry time calculation and client heartbeat sync | M1 | survey_3 |
| 8 | F-BE-08 | Auto-Submission on Timeout Sweeper | Active 1s background sweeper that auto-submits expired tests and blocks late answers | M1 | survey_3 |
| 9 | F-BE-09 | Automated Scoring & Result Evaluation | Automatic scoring engine revealing score and explanations post-submission | M1 | survey_3 |
| 10 | F-BE-10 | Proctoring Violation Ingestion API | Ingests vision violations, updates strike counter, and enforces disqualification | M1 | survey_3 |
| 11 | F-BE-11 | Tab & AI Search Query Logging API | Records visited URLs, tab switches, and extracted search/AI prompts | M1 | survey_3 |
| 12 | F-BE-12 | Keystroke & Mouse Tracking API | Logs hotkey events, copy/paste occurrences, and mouse movement bursts | M1 | survey_3 |
| 13 | F-BE-13 | Comprehensive Audit Report API | Serves full audit trails with export capability (JSON/HTML) for proctor view | M1 | survey_3 |
| 14 | F-BE-14 | Offline Test Cache & Sync | Local caching allowing disconnected test-taking with sync upon reconnection | M1 | survey_3 |
| 15 | F-BE-15 | Automated Backend Test Suite | Native node:test suite verifying all endpoints with 100% zero failures | M1 | survey_3 |
| 16 | F-UI-01 | Electron Shell & App Lifecycle | Main process configuration, BrowserWindow lifecycle, single command `npm start` | M2 | survey_1 |
| 17 | F-UI-02 | Secure Preload Bridge & IPC | Context-isolated bridge exposing `window.proctorAPI` securely | M2 | survey_1 |
| 18 | F-UI-03 | Multi-Tab Browser Manager | Tab strip UI, add/close tab, pinned assessment tab, zero-flicker switching | M2 | survey_1 |
| 19 | F-UI-04 | Guest Web Container & Isolation | Sandboxed guest webview/partition with strict URL protocol whitelisting | M2 | survey_1 |
| 20 | F-UI-05 | Search Engine URL Query Extractor | URL parameter extractor for Google, Bing, DuckDuckGo, Yahoo | M2 | survey_1 |
| 21 | F-UI-06 | AI Service (ChatGPT/Claude) Interception | Injected guest script capturing chat prompts via DOM listeners and fetch hooks | M2 | survey_1 |
| 22 | F-UI-07 | Keystroke & Clipboard Tracking Engine | Intercepts shortcut keys (Alt+Tab, F12, devtools), copy/paste clipboard logging | M2 | survey_1 |
| 23 | F-UI-08 | Mouse Activity Throttled Tracker | Throttled 500ms mouse activity summaries, window blur/focus detection | M2 | survey_1 |
| 24 | R2-F01 | Webcam Video Capture & Decoupling | 30 FPS self-view `<video>` element with 10 FPS canvas extraction | M3 | survey_2 |
| 25 | R2-F02 | Offline AI Model Bundling | Bundled `@vladmandic/human-models` in `assets/models/` for 100% offline inference | M3 | survey_2 |
| 26 | R2-F03 | Face Presence & Multi-Face Detection | BlazeFace detection: absence alert (>3s), multiple faces alert (>1.2s) | M3 | survey_2 |
| 27 | R2-F04 | 3D Head Pose Orientation Estimation | FaceMesh 468 landmarks computing Euler angles (Yaw ±25°, Pitch -20°/+25°, Roll ±25°) | M3 | survey_2 |
| 28 | R2-F05 | Iris Gaze Diversion & EAR Tracking | Iris center landmark ratios (HGR <0.35, >0.65) and EAR blink filtering | M3 | survey_2 |
| 29 | R2-F06 | Hysteresis Debounce State Machine | Multi-tier temporal debouncing preventing false alerts from blinks or glances | M3 | survey_2 |
| 30 | R2-F07 | Real-Time Visual & Auditory Warnings | Warning banner/toast, audio synthesized alert chime, strike counter display | M3 | survey_2 |
| 31 | R2-F08 | Auto-Disqualification Rule Engine | Immediate test lockdown and disqualification API call upon reaching max strikes | M3 | survey_2 |
| 32 | R2-F09 | Violation Snapshot Capture | 320x240 WebP base64 image capture attached to violation audit telemetry | M3 | survey_2 |
| 33 | R2-F10 | Biometric Identity Verification | Live facial embedding Euclidean distance comparison against baseline ID photo | M3 | survey_2 |
| 34 | R2-F11 | Headless CI Mock Vision Pipeline | Synthetic video & landmark mock stream for automated test suite execution | M3 | survey_2 |
| 35 | F-UI-09 | Student Authentication & Preflight View | Clean UI for OTP entry, webcam permission, facial baseline capture | M4 | survey_1 |
| 36 | F-UI-10 | Active MCQ Exam Workspace UI | Responsive question view, option hotkeys, palette grid, countdown badge | M4 | survey_1 |
| 37 | F-UI-11 | Auditor / Proctor Review View UI | Audit log timeline, violation snapshot gallery, search intelligence table | M4 | survey_1 |
| 38 | F-UI-12 | Unified Integration & State Orchestration | End-to-end integration connecting backend, desktop shell, vision worker, and UI | M4 | survey_1 |
| 39 | F-E2E-01 | Opaque-Box E2E Test Runner & Suite | Comprehensive 4-tier requirement-driven E2E test suite (`npm test`) | M5 | original_req |
| 40 | F-E2E-02 | Adversarial Coverage Hardening | Tier 5 white-box gap audit, boundary stress tests, error injection verification | M5 | original_req |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| M1 | Local Backend Service & Assessment Engine | Features 1–15 (F-BE-01 through F-BE-15): Express server, DataStore, OTP/Face auth, Question Bank, Timer Sweeper, Scoring, Proctoring APIs, unit/integration tests | none | DONE (65/65 unit tests, 141/141 E2E tests pass) |
| M2 | Electron Desktop Shell & Tab/Search Tracking | Features 16–23 (F-UI-01 through F-UI-08): Electron app lifecycle, secure preload bridge, multi-tab manager, guest webview container, search & AI prompt interception, keystroke/mouse tracking | none (uses M1 contract) | DONE (Main shell, TabManager, SearchTracker, Preload) |
| M3 | AI Proctoring Engine & Vision Pipeline | Features 24–34 (R2-F01 through R2-F11): Offline model bundling, Web Worker inference, face presence, 3D head pose, iris gaze diversion, hysteresis state machine, warning banners, snapshot capture | none (uses M1 contract) | DONE (heuristics.js, visionWorker.js, 16/16 vision tests pass) |
| M4 | Unified UI Views & System Integration | Features 35–38 (F-UI-09 through F-UI-12): Student Auth/Preflight view, Active MCQ Exam workspace, Auditor Review view, end-to-end event and UI integration | M1, M2, M3 | DONE (HTML shell, CSS design system, 7 JS modules) |
| M5 | Final Milestone: 100% E2E Test Pass & Adversarial Hardening | Features 39–40 (F-E2E-01, F-E2E-02): Phase 1: Pass 100% of E2E test suite (Tiers 1-4). Phase 2: Adversarial coverage hardening (Tier 5) | M4, E2E Test Suite | DONE (141/141 E2E, 133/133 Unit tests pass) |

---

## Interface Contracts

### 1. Electron Preload Bridge (`window.proctorAPI`)
```typescript
interface ProctorAPI {
  // Backend & System
  getBackendPort: () => Promise<number>;
  getAppVersion: () => Promise<string>;
  
  // Tab Management & Navigation
  createTab: (url?: string) => Promise<string>;
  switchTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  navigateTab: (tabId: string, url: string) => Promise<void>;
  onTabUpdated: (callback: (tab: TabInfo) => void) => () => void;
  
  // Audit & Telemetry IPC
  logActivity: (event: ActivityEvent) => Promise<void>;
  onProctorWarning: (callback: (warning: WarningPayload) => void) => () => void;
  onDisqualify: (callback: (reason: string) => void) => () => void;
  
  // Window controls
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
}
```

### 2. Local Backend REST API
- `POST /api/auth/otp/request`: `{ studentId: string }` -> `{ message: string, otp: string }`
- `POST /api/auth/otp/verify`: `{ studentId: string, otp: string }` -> `{ token: string, session: SessionInfo }`
- `POST /api/auth/face/verify`: `{ studentId: string, imageBase64: string, descriptor?: number[] }` -> `{ verified: boolean, similarity: number }`
- `GET /api/assessment/questions`: Header: `Authorization: Bearer <token>` -> `Question[]` (sanitized without `correctOptionId` or `explanation`)
- `POST /api/assessment/session/start`: `{ durationMinutes?: number }` -> `{ sessionId: string, startedAt: number, expiresAt: number }`
- `GET /api/assessment/session/:id/timer`: -> `{ remainingSeconds: number, status: string, serverTime: number }`
- `POST /api/assessment/answer`: `{ sessionId: string, questionId: string, selectedOptionId: string }` -> `{ saved: boolean }`
- `POST /api/assessment/submit`: `{ sessionId: string }` -> `{ status: 'SUBMITTED', score: number, total: number, results: ResultDetail[] }`
- `POST /api/proctor/violation`: `{ sessionId: string, type: string, details: object, snapshotBase64?: string }` -> `{ strikeCount: number, action: 'WARN' | 'DISQUALIFY' }`
- `POST /api/proctor/tab-event`: `{ sessionId: string, type: 'TAB_SWITCH' | 'TAB_NAVIGATE', url: string, title?: string }` -> `{ recorded: boolean }`
- `POST /api/proctor/search-event`: `{ sessionId: string, service: string, query: string, url: string }` -> `{ recorded: boolean }`
- `POST /api/proctor/input-activity`: `{ sessionId: string, type: 'KEYSTROKE' | 'MOUSE_BURST' | 'CLIPBOARD', data: object }` -> `{ recorded: boolean }`
- `GET /api/audit/session/:id/report`: -> Full session audit trail, violations, snapshots, queries, and score breakdown.

### 3. Vision Worker Message Protocol
- Main -> Worker: `{ type: 'INIT', modelBasePath: string, config: HumanConfig }`
- Main -> Worker: `{ type: 'PROCESS_FRAME', imageBitmap: ImageBitmap, timestamp: number }`
- Worker -> Main: `{ type: 'DETECTION_RESULT', faceCount: number, euler: { yaw, pitch, roll }, gaze: { hgr, ear }, violation: ViolationPayload | null }`

---

## Code Layout

```
c:\Users\Parv Mishra\Desktop\Projects\TRI\
├── package.json                   # Dependencies, npm start, npm test scripts
├── assets/
│   ├── models/                    # Offline @vladmandic/human model weights (BlazeFace, FaceMesh, Iris)
│   ├── icons/                     # Application icons
│   └── seed_questions.json        # Pre-seeded 10+ technical MCQ question bank
├── src/
│   ├── main/
│   │   ├── index.js               # Electron main process entry point
│   │   ├── windowManager.js       # BrowserWindow creation, partition & view controllers
│   │   ├── tabManager.js          # Multi-tab lifecycle & omnibox navigation
│   │   ├── ipcHandlers.js         # Preload IPC communication handlers
│   │   └── searchTracker.js       # URL & AI prompt extraction interceptor
│   ├── preload/
│   │   ├── index.js               # Host preload bridge (contextBridge.exposeInMainWorld)
│   │   └── guest-preload.js       # Injected into external search/AI tabs for prompt capture
│   ├── renderer/
│   │   ├── index.html             # Single-page desktop app shell
│   │   ├── styles/
│   │   │   └── main.css           # Slate/Zinc dark & light responsive design system
│   │   └── js/
│   │       ├── app.js             # View switcher & client state orchestrator
│   │       ├── authView.js        # Student OTP & Facial pre-flight check
│   │       ├── examView.js        # MCQ questions, palette, hotkeys, server timer sync
│   │       ├── auditView.js       # Timeline stream, violation snapshots, search intel
│   │       ├── tabsUI.js          # Tab strip, omnibox controls, and webview binding
│   │       ├── proctorClient.js   # Webcam capture, worker bridge, audio alerts, banners
│   │       └── inputTracker.js    # Keystroke shortcuts & throttled mouse logger
│   ├── worker/
│   │   ├── visionWorker.js        # Web Worker running @vladmandic/human offline
│   │   └── heuristics.js          # Euler angles, iris gaze ratio, EAR, hysteresis logic
│   └── backend/
│       ├── app.js                 # Express application & middleware
│       ├── server.js              # HTTP server starter & dynamic port binding
│       ├── config.js              # Server constants, grace periods, strike thresholds
│       ├── db/
│       │   ├── datastore.js       # Atomic JSON & in-memory DataStore
│       │   └── seed.js            # Default question bank & test candidate seeding
│       ├── services/
│       │   ├── authService.js     # OTP & Facial verification logic
│       │   ├── assessmentService.js # Question delivery, answer saving, scoring
│       │   ├── timerService.js    # Server-authoritative timer & timeout sweeper
│       │   └── proctorService.js  # Telemetry ingestion, strikes, audit exporter
│       ├── routes/
│       │   ├── authRoutes.js      # /api/auth/*
│       │   ├── assessmentRoutes.js# /api/assessment/*
│       │   ├── proctorRoutes.js   # /api/proctor/*
│       │   └── auditRoutes.js     # /api/audit/*
│       └── middleware/
│           ├── authMiddleware.js  # Bearer token verification
│           └── errorHandler.js    # Global safe error handling
├── test/                          # Backend unit & integration test suite (npm test)
│   ├── health.test.js
│   ├── auth.test.js
│   ├── assessment.test.js
│   ├── timer.test.js
│   ├── proctor.test.js
│   └── audit.test.js
├── e2e/                           # Parallel E2E Testing Track test suite
│   ├── runner.js                  # Opaque-box E2E test runner
│   ├── tier1_features.test.js     # Tier 1: Feature coverage (>=5 per feature)
│   ├── tier2_boundaries.test.js   # Tier 2: Boundary & corner cases (>=5 per feature)
│   ├── tier3_interactions.test.js # Tier 3: Cross-feature combinations
│   └── tier4_scenarios.test.js    # Tier 4: Real-world assessment workflows
└── .agents/teamwork/              # Agent coordination metadata only
```
