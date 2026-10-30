# E2E Test Infra: Smart Proctoring Browser

## Test Philosophy
- Opaque-box, requirement-driven testing. No dependency on internal implementation details.
- Validates the desktop application as an end-user / proctor administrator would interact with it.
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinatorial + Real-World Workload Testing.

## Feature Inventory Mapping
| # | Feature Area | Source Requirement | Tier 1 Target | Tier 2 Target | Tier 3 Target |
|---|---|---|:---:|:---:|:---:|
| 1 | Desktop Application Launch & Multi-tab Navigation | R1, AC Lines 26-29 | 5 | 5 | ✓ |
| 2 | Student Authentication (OTP & Face Baseline) | R4, AC Lines 30-31 | 5 | 5 | ✓ |
| 3 | MCQ Assessment Delivery & Response Submission | R4, AC Line 32 | 5 | 5 | ✓ |
| 4 | Server-Authoritative Timer & Timeout Submission | R4, AC Line 33 | 5 | 5 | ✓ |
| 5 | AI Proctoring: Face Absence & Multi-Face Detection | R2, AC Lines 36-37 | 5 | 5 | ✓ |
| 6 | AI Proctoring: Gaze Diversion & Head Pose | R2, AC Line 37 | 5 | 5 | ✓ |
| 7 | Warning Display & Violation Accumulation | R2, AC Line 38 | 5 | 5 | ✓ |
| 8 | Disqualification upon Strike Threshold | R2, AC Line 39 | 5 | 5 | ✓ |
| 9 | In-Browser Tab Switches & URL Tracking | R3, AC Line 42 | 5 | 5 | ✓ |
| 10 | AI Service (ChatGPT/Claude) Query Interception | R3, AC Line 43 | 5 | 5 | ✓ |
| 11 | Keystroke & Mouse Activity Logging | R3, AC Line 44 | 5 | 5 | ✓ |
| 12 | Auditor Review View & Session Reporting | R1, AC Line 47 | 5 | 5 | ✓ |

## Test Architecture
- **E2E Test Runner**: `e2e/runner.js` (Standalone Node.js test runner executing with `node e2e/runner.js` or through `npm test`)
- **Test Case Format**: Each tier contains modular test suites testing HTTP endpoints, IPC protocols, and mock user flows.
- **Directory Layout**:
  - `e2e/tier1_features.test.js`: Feature isolation checks (≥60 tests: 12 features × 5).
  - `e2e/tier2_boundaries.test.js`: Boundary, edge cases, rapid fire, and timeout limits (≥60 tests: 12 features × 5).
  - `e2e/tier3_interactions.test.js`: Cross-feature combinations (pairwise combinations of auth, timer, proctor strikes, and tab switches).
  - `e2e/tier4_scenarios.test.js`: Realistic end-to-end student exam sessions (Happy path, Cheating attempt disqualification, Timeout auto-submit).

## Coverage Thresholds
- Tier 1: ≥5 tests per feature (Minimum 60 tests)
- Tier 2: ≥5 boundary/corner tests per feature (Minimum 60 tests)
- Tier 3: ≥12 pairwise cross-feature interaction scenarios
- Tier 4: ≥6 realistic end-to-end workload application scenarios
- **Total Minimum**: ≥138 automated test cases
