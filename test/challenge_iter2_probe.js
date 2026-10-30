/**
 * Milestone 1 Iteration 2 Challenger 2 Empirical Probing Harness
 * 
 * Target probes:
 * 1. Tab navigation activity counting (TAB_NAVIGATE vs TAB_SWITCH, eventType/type, aliases, aiToolVisits)
 * 2. In-progress audit response sanitization (no correctOptionId, explanation, score, marks, accuracy)
 * 3. DataStore disk persistence (write-through queue, reload from raw disk JSON, concurrent writes, cleanup)
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');
const { DataStore } = require('../src/backend/db/datastore');
const proctorService = require('../src/backend/services/proctorService');
const assessmentService = require('../src/backend/services/assessmentService');

async function run() {
  console.log('================================================================');
  console.log('  CHALLENGER 2 EMPIRICAL PROBING SUITE (M1 ITERATION 2)');
  console.log('================================================================\n');

  let server;
  let baseUrl;

  try {
    // -------------------------------------------------------------
    // Setup in-memory server for API-level telemetry & audit probes
    // -------------------------------------------------------------
    await datastore.init({ inMemoryOnly: true });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    console.log(`[Setup] Ephemeral test server active on ${baseUrl}`);

    // =============================================================
    // PROBE 1: Tab Navigation Activity Counting (TAB_NAVIGATE)
    // =============================================================
    console.log('\n--- PROBE 1: Tab Navigation Activity Counting ---');

    // Seed test candidate and session
    const candidate1 = {
      id: 'CAND_TAB_1',
      name: 'Tab Probe Candidate',
      email: 'tab.probe@test.org',
      rollNo: 'TAB-001'
    };
    datastore.addCandidate(candidate1);

    const sessionTabId = 'sess_tab_probe_1';
    datastore.createSession({
      id: sessionTabId,
      candidateId: candidate1.id,
      status: 'IN_PROGRESS',
      startedAt: Date.now(),
      durationMinutes: 15,
      strikeCount: 0,
      questionIds: ['q1', 'q2'],
      answers: {}
    });

    // 1.1: Single TAB_NAVIGATE event via POST /api/proctor/tab-event using `type: 'TAB_NAVIGATE'`
    const res1 = await fetch(`${baseUrl}/api/proctor/tab-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionTabId,
        type: 'TAB_NAVIGATE',
        url: 'https://nodejs.org/docs',
        title: 'Node.js Docs'
      })
    });
    assert.strictEqual(res1.status, 200, 'POST /api/proctor/tab-event must return 200');
    const body1 = await res1.json();
    assert.strictEqual(body1.success, true, 'Response success must be true');

    let audit1 = await (await fetch(`${baseUrl}/api/audit/session/${sessionTabId}/report`)).json();
    assert.strictEqual(audit1.summary.totalTabSwitches, 1, 'summary.totalTabSwitches must equal 1 after 1 TAB_NAVIGATE');
    assert.strictEqual(audit1.tabActivitySummary.totalTabSwitches, 1, 'tabActivitySummary.totalTabSwitches must equal 1');
    assert.strictEqual(audit1.tabActivitySummary.totalUrlsVisited, 1, 'tabActivitySummary.totalUrlsVisited must equal 1');
    console.log('  ✔ 1.1: Single TAB_NAVIGATE using type="TAB_NAVIGATE" increments totalTabSwitches (1 === 1)');

    // 1.2: Single TAB_NAVIGATE event using `eventType: 'TAB_NAVIGATE'`
    const res2 = await fetch(`${baseUrl}/api/proctor/tab-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionTabId,
        eventType: 'TAB_NAVIGATE',
        url: 'https://developer.mozilla.org',
        title: 'MDN Web Docs'
      })
    });
    assert.strictEqual(res2.status, 200);

    let audit2 = await (await fetch(`${baseUrl}/api/audit/session/${sessionTabId}/report`)).json();
    assert.strictEqual(audit2.summary.totalTabSwitches, 2, 'summary.totalTabSwitches must equal 2 after second TAB_NAVIGATE');
    console.log('  ✔ 1.2: TAB_NAVIGATE using eventType="TAB_NAVIGATE" increments totalTabSwitches (2 === 2)');

    // 1.3: Single TAB_SWITCH event using `type: 'TAB_SWITCH'`
    const res3 = await fetch(`${baseUrl}/api/proctor/tab-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionTabId,
        type: 'TAB_SWITCH',
        url: 'https://github.com',
        title: 'GitHub'
      })
    });
    assert.strictEqual(res3.status, 200);

    let audit3 = await (await fetch(`${baseUrl}/api/audit/session/${sessionTabId}/report`)).json();
    assert.strictEqual(audit3.summary.totalTabSwitches, 3, 'summary.totalTabSwitches must equal 3 after TAB_SWITCH');
    console.log('  ✔ 1.3: Standard TAB_SWITCH event increments totalTabSwitches (3 === 3)');

    // 1.4: Non-switching tab events (e.g. TAB_OPEN, WINDOW_FOCUS, TAB_CLOSE)
    await fetch(`${baseUrl}/api/proctor/tab-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionTabId,
        type: 'TAB_OPEN',
        url: 'https://example.com'
      })
    });
    await fetch(`${baseUrl}/api/proctor/tab-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionTabId,
        type: 'TAB_CLOSE',
        url: 'https://example.com'
      })
    });

    let audit4 = await (await fetch(`${baseUrl}/api/audit/session/${sessionTabId}/report`)).json();
    assert.strictEqual(audit4.summary.totalTabSwitches, 3, 'summary.totalTabSwitches must remain 3 for non-switching events');
    assert.strictEqual(audit4.tabActivitySummary.totalUrlsVisited, 5, 'totalUrlsVisited must be 5');
    console.log('  ✔ 1.4: Non-switching events (TAB_OPEN, TAB_CLOSE) do not increment totalTabSwitches');

    // 1.5: Alias route POST /api/proctor/tab-activity with TAB_NAVIGATE
    const resAlias = await fetch(`${baseUrl}/api/proctor/tab-activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionTabId,
        type: 'TAB_NAVIGATE',
        url: 'https://wikipedia.org'
      })
    });
    assert.strictEqual(resAlias.status, 200, 'Alias route /tab-activity must return 200');

    let audit5 = await (await fetch(`${baseUrl}/api/audit/session/${sessionTabId}/report`)).json();
    assert.strictEqual(audit5.summary.totalTabSwitches, 4, 'Alias route TAB_NAVIGATE must increment totalTabSwitches to 4');
    console.log('  ✔ 1.5: Alias endpoint /api/proctor/tab-activity accurately increments totalTabSwitches');

    // 1.6: Flagged AI tool navigation with TAB_NAVIGATE
    const resAi = await fetch(`${baseUrl}/api/proctor/tab-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionTabId,
        type: 'TAB_NAVIGATE',
        url: 'https://chatgpt.com/c/12345',
        title: 'ChatGPT'
      })
    });
    const bodyAi = await resAi.json();
    assert.strictEqual(bodyAi.isFlaggedAiTool, true, 'ChatGPT domain must be flagged as AI tool');

    let audit6 = await (await fetch(`${baseUrl}/api/audit/session/${sessionTabId}/report`)).json();
    assert.strictEqual(audit6.summary.totalTabSwitches, 5, 'totalTabSwitches must be 5');
    assert.strictEqual(audit6.tabActivitySummary.aiToolVisits, 1, 'aiToolVisits must be 1');
    console.log('  ✔ 1.6: TAB_NAVIGATE to AI domain flags AI tool and increments both totalTabSwitches and aiToolVisits');

    // 1.7: Mixed high-volume burst and integrity score penalty
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/api/proctor/tab-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionTabId,
          type: i % 2 === 0 ? 'TAB_NAVIGATE' : 'TAB_SWITCH',
          url: `https://test-site-${i}.org`
        })
      });
    }
    let audit7 = await (await fetch(`${baseUrl}/api/audit/session/${sessionTabId}/report`)).json();
    assert.strictEqual(audit7.summary.totalTabSwitches, 10, 'totalTabSwitches must equal 10');
    assert.ok(audit7.integrityScore.flags.some(f => f.includes('High tab switching frequency')), 'Flag must be raised');
    console.log('  ✔ 1.7: High-volume mixed burst (10 total switches) triggers integrity penalty flag');


    // =============================================================
    // PROBE 2: In-Progress Audit Response Sanitization
    // =============================================================
    console.log('\n--- PROBE 2: In-Progress Audit Response Sanitization ---');

    // Setup candidate and active session
    const candidate2 = {
      id: 'CAND_SAN_1',
      name: 'Sanitization Candidate',
      email: 'sanitization@test.org',
      rollNo: 'SAN-001'
    };
    datastore.addCandidate(candidate2);

    const questions = [
      {
        id: 'q_probe_1',
        prompt: 'What is the primary event loop model in Node.js?',
        options: [
          { id: 'opt_1', text: 'libuv event loop' },
          { id: 'opt_2', text: 'POSIX threads' }
        ],
        correctOptionId: 'opt_1',
        explanation: 'Node.js event loop is built on libuv.',
        marks: 2,
        negativeMarks: 1
      },
      {
        id: 'q_probe_2',
        prompt: 'Which protocol is used for secure web traffic?',
        options: [
          { id: 'opt_a', text: 'HTTPS' },
          { id: 'opt_b', text: 'FTP' }
        ],
        correctOptionId: 'opt_a',
        explanation: 'HTTPS provides encrypted transport over TLS.',
        marks: 2,
        negativeMarks: 1
      },
      {
        id: 'q_probe_3',
        prompt: 'What is 2 + 2?',
        options: [
          { id: 'opt_x', text: '4' },
          { id: 'opt_y', text: '5' }
        ],
        correctOptionId: 'opt_x',
        explanation: 'Basic arithmetic.',
        marks: 2,
        negativeMarks: 0
      }
    ];
    datastore.setQuestions(questions);

    const sessionSanId = 'sess_san_probe_1';
    datastore.createSession({
      id: sessionSanId,
      candidateId: candidate2.id,
      status: 'IN_PROGRESS',
      startedAt: Date.now(),
      durationMinutes: 20,
      strikeCount: 0,
      questionIds: ['q_probe_1', 'q_probe_2', 'q_probe_3'],
      answers: {}
    });

    // Save partial answers (q_probe_1 attempted, q_probe_2 attempted, q_probe_3 unattempted)
    datastore.saveAnswer(sessionSanId, 'q_probe_1', 'opt_1');
    datastore.saveAnswer(sessionSanId, 'q_probe_2', 'opt_b'); // intentionally incorrect

    // 2.1: Query GET /api/audit/session/:id/report while IN_PROGRESS
    const repRes = await fetch(`${baseUrl}/api/audit/session/${sessionSanId}/report`);
    assert.strictEqual(repRes.status, 200, 'GET /api/audit/session/:id/report must return 200');
    const reportData = await repRes.json();

    // Verify session status & score sanitization
    assert.strictEqual(reportData.session.status, 'IN_PROGRESS', 'Session status must be IN_PROGRESS');
    assert.strictEqual(reportData.session.score, null, 'session.score must be null during active exam');
    assert.strictEqual(reportData.session.accuracy, null, 'session.accuracy must be null during active exam');
    assert.strictEqual(reportData.session.correctCount, null, 'session.correctCount must be null during active exam');
    assert.strictEqual(reportData.session.incorrectCount, null, 'session.incorrectCount must be null during active exam');
    console.log('  ✔ 2.1: Session summary scores strictly null during active exam (score=null, accuracy=null)');

    // 2.2: Verify questionResults leakage check
    assert.ok(Array.isArray(reportData.questionResults), 'questionResults must be an array');
    assert.strictEqual(reportData.questionResults.length, 3, 'Must have 3 question results');

    for (const qRes of reportData.questionResults) {
      assert.strictEqual(qRes.correctOptionId, undefined, `Leaked correctOptionId on question ${qRes.questionId}`);
      assert.strictEqual(qRes.explanation, undefined, `Leaked explanation on question ${qRes.questionId}`);
      assert.strictEqual(qRes.marksAwarded, undefined, `Leaked marksAwarded on question ${qRes.questionId}`);
      assert.strictEqual(qRes.isCorrect, undefined, `isCorrect must be omitted during IN_PROGRESS on question ${qRes.questionId}`);
    }
    console.log('  ✔ 2.2: Zero leak of correctOptionId, explanation, and marksAwarded in reportData.questionResults');

    // 2.3: Verify reportData.results matches questionResults and is also sanitized
    assert.ok(Array.isArray(reportData.results), 'reportData.results must be an array');
    for (const rItem of reportData.results) {
      assert.strictEqual(rItem.correctOptionId, undefined, `Leaked correctOptionId in results on question ${rItem.questionId}`);
      assert.strictEqual(rItem.explanation, undefined, `Leaked explanation in results on question ${rItem.questionId}`);
      assert.strictEqual(rItem.marksAwarded, undefined, `Leaked marksAwarded in results on question ${rItem.questionId}`);
    }
    console.log('  ✔ 2.3: Zero leak in top-level reportData.results');

    // 2.4: Attempted vs unattempted metadata accuracy
    const q1Res = reportData.questionResults.find(q => q.questionId === 'q_probe_1');
    const q2Res = reportData.questionResults.find(q => q.questionId === 'q_probe_2');
    const q3Res = reportData.questionResults.find(q => q.questionId === 'q_probe_3');

    assert.strictEqual(q1Res.isAttempted, true);
    assert.strictEqual(q1Res.selectedOptionId, 'opt_1');
    assert.strictEqual(q2Res.isAttempted, true);
    assert.strictEqual(q2Res.selectedOptionId, 'opt_b');
    assert.strictEqual(q3Res.isAttempted, false);
    assert.strictEqual(q3Res.selectedOptionId, null);
    console.log('  ✔ 2.4: Attempted / unattempted state preserved without exposing answer correctness');

    // 2.5: Printable HTML report sanitization during IN_PROGRESS
    const htmlRes = await fetch(`${baseUrl}/api/audit/session/${sessionSanId}/report?format=html`);
    assert.strictEqual(htmlRes.status, 200);
    const htmlText = await htmlRes.text();

    assert.ok(!htmlText.includes('<th>Correct Key</th>'), 'HTML must not have Correct Key table header during IN_PROGRESS');
    assert.ok(!htmlText.includes('<th>Marks</th>'), 'HTML must not have Marks table header during IN_PROGRESS');
    assert.ok(!htmlText.includes('libuv event loop is built on libuv'), 'HTML must not contain question explanation');
    assert.ok(!htmlText.includes('HTTPS provides encrypted transport'), 'HTML must not contain question explanation');
    assert.ok(htmlText.includes('RECORDED'), 'HTML displays RECORDED status for attempted questions');
    assert.ok(htmlText.includes('PENDING'), 'HTML displays PENDING status for unattempted questions');
    console.log('  ✔ 2.5: HTML audit report sanitizes headers, keys, and explanations during IN_PROGRESS');

    // 2.6: Verify post-submission desanitization
    const subRes = await fetch(`${baseUrl}/api/assessment/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionSanId })
    });
    assert.strictEqual(subRes.status, 200, 'POST /api/assessment/submit must succeed');

    const postSubRep = await (await fetch(`${baseUrl}/api/audit/session/${sessionSanId}/report`)).json();
    assert.strictEqual(postSubRep.session.status, 'SUBMITTED');
    assert.ok(typeof postSubRep.session.score === 'number', 'Score must be revealed post-submission');
    const postQ1 = postSubRep.questionResults.find(q => q.questionId === 'q_probe_1');
    assert.strictEqual(postQ1.correctOptionId, 'opt_1', 'correctOptionId must be revealed post-submission');
    assert.strictEqual(postQ1.explanation, 'Node.js event loop is built on libuv.', 'explanation must be revealed post-submission');
    assert.strictEqual(postQ1.isCorrect, true);
    assert.strictEqual(postQ1.marksAwarded, 2);

    const postHtml = await (await fetch(`${baseUrl}/api/audit/session/${sessionSanId}/report?format=html`)).text();
    assert.ok(postHtml.includes('<th>Correct Key</th>'), 'HTML displays Correct Key header post-submission');
    assert.ok(postHtml.includes('CORRECT'), 'HTML displays CORRECT badge post-submission');
    console.log('  ✔ 2.6: Post-submission audit report desanitizes and reveals full answers and explanations');


    // =============================================================
    // PROBE 3: DataStore Disk Persistence
    // =============================================================
    console.log('\n--- PROBE 3: DataStore Disk Persistence ---');

    const tmpDir = path.join(__dirname, 'tmp_probe_store_' + crypto.randomBytes(4).toString('hex'));
    const diskPath = path.join(tmpDir, 'data', 'persistence_test.json');

    try {
      // 3.1: Instantiate standalone disk-backed DataStore instance
      const diskStore = new DataStore();
      await diskStore.init({
        filePath: diskPath,
        inMemoryOnly: false
      });

      assert.ok(fs.existsSync(path.dirname(diskPath)), 'Target data directory must be created automatically');
      console.log('  ✔ 3.1: DataStore successfully created target directory hierarchy on disk');

      // 3.2: Write mutations across all supported entities
      const candidateDisk = {
        id: 'CAND_DISK_100',
        name: 'Persistence Candidate',
        email: 'persistence@student.edu',
        rollNo: 'DSK-100'
      };
      diskStore.addCandidate(candidateDisk);
      diskStore.updateCandidate('CAND_DISK_100', { name: 'Persistence Candidate Updated' });
      diskStore.setOtp('CAND_DISK_100', { otp: '654321', expiresAt: Date.now() + 180000 });

      const sessionDiskId = 'sess_persistence_100';
      diskStore.createSession({
        id: sessionDiskId,
        candidateId: 'CAND_DISK_100',
        status: 'IN_PROGRESS',
        startedAt: 1700000000000,
        durationMinutes: 30,
        strikeCount: 1,
        questionIds: ['q1', 'q2']
      });

      diskStore.updateSession(sessionDiskId, { strikeCount: 2 });
      diskStore.saveAnswer(sessionDiskId, 'q1', 'opt_persisted_a');
      diskStore.saveAnswer(sessionDiskId, 'q2', 'opt_persisted_b');

      diskStore.addViolation({
        id: 'viol_persisted_1',
        sessionId: sessionDiskId,
        candidateId: 'CAND_DISK_100',
        type: 'MULTIPLE_FACES',
        severity: 'WARNING',
        strikeNumber: 1,
        timestamp: 1700000005000
      });

      diskStore.addTabActivity({
        id: 'tab_persisted_1',
        sessionId: sessionDiskId,
        candidateId: 'CAND_DISK_100',
        eventType: 'TAB_NAVIGATE',
        type: 'TAB_NAVIGATE',
        url: 'https://docs.docker.com',
        domain: 'docs.docker.com',
        timestamp: 1700000010000
      });

      diskStore.addInputActivity({
        id: 'input_persisted_1',
        sessionId: sessionDiskId,
        candidateId: 'CAND_DISK_100',
        eventType: 'KEYSTROKE',
        type: 'KEYSTROKE',
        timestamp: 1700000015000
      });

      // 3.3: Flush and read directly from raw file system
      await diskStore.flush();

      assert.ok(fs.existsSync(diskPath), 'DataStore JSON file must exist on disk');
      const rawDiskContent = fs.readFileSync(diskPath, 'utf8');
      const parsedDiskJson = JSON.parse(rawDiskContent);

      assert.strictEqual(parsedDiskJson.candidates['CAND_DISK_100'].name, 'Persistence Candidate Updated');
      assert.strictEqual(parsedDiskJson.otps['cand_disk_100'].otp, '654321');
      assert.strictEqual(parsedDiskJson.sessions[sessionDiskId].strikeCount, 2);
      assert.strictEqual(parsedDiskJson.sessions[sessionDiskId].answers['q1'].selectedOptionId, 'opt_persisted_a');
      assert.strictEqual(parsedDiskJson.sessions[sessionDiskId].answers['q2'].selectedOptionId, 'opt_persisted_b');
      assert.strictEqual(parsedDiskJson.violations.length, 1);
      assert.strictEqual(parsedDiskJson.violations[0].type, 'MULTIPLE_FACES');
      assert.strictEqual(parsedDiskJson.tabActivities.length, 1);
      assert.strictEqual(parsedDiskJson.tabActivities[0].type, 'TAB_NAVIGATE');
      assert.strictEqual(parsedDiskJson.inputActivities.length, 1);
      console.log('  ✔ 3.2: Raw disk JSON file contains all written mutations across 7 datastore entities');

      // 3.4: Restart / fresh instance hydration simulation
      const newHydratedStore = new DataStore();
      await newHydratedStore.init({
        filePath: diskPath,
        inMemoryOnly: false
      });

      assert.strictEqual(newHydratedStore.getCandidateById('CAND_DISK_100').name, 'Persistence Candidate Updated');
      assert.strictEqual(newHydratedStore.getOtp('CAND_DISK_100').otp, '654321');
      assert.strictEqual(newHydratedStore.getSession(sessionDiskId).strikeCount, 2);
      assert.strictEqual(newHydratedStore.getSession(sessionDiskId).answers['q1'].selectedOptionId, 'opt_persisted_a');
      assert.strictEqual(newHydratedStore.getViolationsBySession(sessionDiskId).length, 1);
      assert.strictEqual(newHydratedStore.getTabActivitiesBySession(sessionDiskId)[0].type, 'TAB_NAVIGATE');
      assert.strictEqual(newHydratedStore.getInputActivitiesBySession(sessionDiskId)[0].type, 'KEYSTROKE');
      console.log('  ✔ 3.3: Second independent DataStore instance successfully hydrates all state from disk');

      // 3.5: Concurrent write burst stress on disk queue
      const writePromises = [];
      for (let i = 0; i < 40; i++) {
        writePromises.push(newHydratedStore.saveAnswer(sessionDiskId, `burst_q_${i}`, `burst_opt_${i}`));
        writePromises.push(newHydratedStore.addTabActivity({
          id: `burst_tab_${i}`,
          sessionId: sessionDiskId,
          type: 'TAB_NAVIGATE',
          url: `https://burst-${i}.example.com`
        }));
      }
      await Promise.all(writePromises);
      await newHydratedStore.flush();

      const rawBurstContent = fs.readFileSync(diskPath, 'utf8');
      const parsedBurstJson = JSON.parse(rawBurstContent); // Will throw if corrupted/truncated
      assert.strictEqual(Object.keys(parsedBurstJson.sessions[sessionDiskId].answers).length, 42); // 2 previous + 40 burst
      assert.strictEqual(parsedBurstJson.tabActivities.length, 41); // 1 previous + 40 burst

      // Check no leftover .tmp files
      const dirFiles = fs.readdirSync(path.dirname(diskPath));
      const tmpFiles = dirFiles.filter(f => f.endsWith('.tmp'));
      assert.strictEqual(tmpFiles.length, 0, 'No .tmp files must remain lingering on disk');
      // 3.6: Resilience against corrupted disk JSON
      const corruptFile = path.join(tmpDir, 'corrupt.json');
      fs.writeFileSync(corruptFile, '{"broken_json: [invalid', 'utf8');
      const corruptStore = new DataStore();
      await corruptStore.init({ filePath: corruptFile, inMemoryOnly: false });
      assert.strictEqual(typeof corruptStore.data.candidates, 'object', 'Store must recover to fresh state after corrupted file');
      console.log('  ✔ 3.5: Corrupted disk JSON handled gracefully with fallback to fresh state without crash');

    } finally {
      // 3.7: Cleanup tmpDir
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log('  ✔ 3.6: Temporary probe directory cleaned up');
      }
    }

    // =============================================================
    // PROBE 4: Adversarial Stress & Anti-Tamper Edge Cases
    // =============================================================
    console.log('\n--- PROBE 4: Adversarial Stress & Anti-Tamper Edge Cases ---');

    // 4.1: Anti-Spoofing: Client attempts to suppress AI tool detection by passing isFlaggedAiTool: false
    const spoofRes = await fetch(`${baseUrl}/api/proctor/tab-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionTabId,
        type: 'TAB_NAVIGATE',
        url: 'https://claude.ai/chat/abc',
        isFlaggedAiTool: false // Malicious attempt to spoof server
      })
    });
    const spoofBody = await spoofRes.json();
    assert.strictEqual(spoofBody.isFlaggedAiTool, true, 'Server must enforce AI detection regardless of spoofed payload');
    console.log('  ✔ 4.1: Server-enforced AI domain detection blocks client-side isFlaggedAiTool spoofing');

    // 4.2: Historical timestamp filtering via ?since=<timestamp>
    const cutOffTime = Date.now() + 5000;
    await new Promise(r => setTimeout(r, 10));
    await fetch(`${baseUrl}/api/proctor/tab-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionTabId,
        type: 'TAB_NAVIGATE',
        url: 'https://future-page.org',
        timestamp: cutOffTime + 100
      })
    });
    const sinceReport = await (await fetch(`${baseUrl}/api/audit/session/${sessionTabId}/report?since=${cutOffTime}`)).json();
    assert.strictEqual(sinceReport.summary.totalTabSwitches, 1, 'Only tab switches >= since timestamp must be aggregated');
    console.log('  ✔ 4.2: Audit report ?since=<timestamp> query accurately excludes historical tab events');

    // 4.3: /api/assessment/questions endpoint sanitization with Bearer token
    // Issue OTP and verify to obtain auth token
    datastore.setOtp(candidate2.id, { otp: '123456', expiresAt: Date.now() + 600000, attempts: 0 });
    const authVerifyRes = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: candidate2.id, otp: '123456' })
    });
    const authData = await authVerifyRes.json();
    const token = authData.token;

    const questionsRes = await fetch(`${baseUrl}/api/assessment/questions`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(questionsRes.status, 200);
    const questionsBody = await questionsRes.json();
    assert.ok(Array.isArray(questionsBody) && questionsBody.length > 0);
    for (const q of questionsBody) {
      assert.strictEqual(q.correctOptionId, undefined, `Endpoint /questions leaked correctOptionId for ${q.id}`);
      assert.strictEqual(q.explanation, undefined, `Endpoint /questions leaked explanation for ${q.id}`);
    }
    console.log('  ✔ 4.3: Active assessment question delivery API strictly strips correctOptionId and explanation');

    console.log('\n================================================================');
    console.log('  ALL EMPIRICAL CHALLENGER PROBES & STRESS TESTS PASSED (100%)  ');
    console.log('================================================================\n');

  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log('[Cleanup] Test server stopped.');
    }
  }
}

run().catch((err) => {
  console.error('\nPROBE EXECUTION FAILURE:', err);
  process.exit(1);
});
