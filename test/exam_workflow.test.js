// Keep guided help on the offline notes path so the suite never calls a paid API.
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');
const assistService = require('../src/backend/services/assistService');
const { SearchPolicy } = require('../src/main/searchPolicy');

const QUESTIONS = [
  {
    text: 'What is the time complexity of searching in a balanced binary search tree?',
    category: 'Algorithms',
    options: ['O(1)', 'O(log n)', 'O(n)', 'O(n^2)'],
    correctIndex: 1,
    hint: 'Think about how much of the tree each comparison rules out.',
    explanation: 'Each comparison halves the remaining search space.'
  },
  {
    text: 'Which data structure gives first-in, first-out ordering?',
    category: 'Data structures',
    options: ['Stack', 'Queue', 'Heap'],
    correctIndex: 1
  }
];

test.describe('Exam codes, profiles, guided help and insights', () => {
  let server;
  let baseUrl;
  let exam;

  const call = async (method, path, body, token) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
  };

  const signIn = async (rollNo, name) => {
    await call('POST', '/api/auth/profile', { rollNo, name, email: `${rollNo.toLowerCase()}@college.test` });
    const otp = await call('POST', '/api/auth/otp/request', { studentId: rollNo });
    const verified = await call('POST', '/api/auth/otp/verify', { studentId: rollNo, otp: otp.body.otp });
    return verified.body.token;
  };

  test.before(async () => {
    await datastore.init({ inMemoryOnly: true });
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('creating an exam returns a unique join code and validates questions', async () => {
    const bad = await call('POST', '/api/assessment/exams', { title: 'Broken', questions: [{ text: 'No answer marked', options: ['a', 'b'] }] });
    assert.equal(bad.status, 400);

    const res = await call('POST', '/api/assessment/exams', { title: 'Data Structures Quiz', durationMinutes: 20, questions: QUESTIONS });
    assert.equal(res.status, 201);
    exam = res.body;
    assert.match(exam.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(exam.questions.length, 2);
    assert.equal(exam.questions[0].correctOptionId, 'opt_b');

    const other = await call('POST', '/api/assessment/exams', { title: 'Another', questions: QUESTIONS });
    assert.notEqual(other.body.code, exam.code);
  });

  test('the public join lookup never exposes questions or answers', async () => {
    const res = await call('GET', `/api/assessment/exams/join/${exam.code.slice(0, 3)}-${exam.code.slice(3).toLowerCase()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.questionCount, 2);
    assert.equal(res.body.questions, undefined);
    assert.equal(JSON.stringify(res.body).includes('correctOptionId'), false);

    assert.equal((await call('GET', '/api/assessment/exams/join/ZZZZZZ')).status, 404);
  });

  test('a roll number belongs to one name', async () => {
    const created = await call('POST', '/api/auth/profile', { rollNo: '21cs042', name: 'Priya Sharma', email: 'priya@college.test' });
    assert.equal(created.status, 201);
    assert.equal(created.body.studentId, '21CS042');

    assert.equal((await call('GET', '/api/auth/profile/21CS042')).body.exists, true);
    assert.equal((await call('POST', '/api/auth/profile', { rollNo: '21CS042', name: 'priya  sharma' })).status, 200);
    const mismatch = await call('POST', '/api/auth/profile', { rollNo: '21CS042', name: 'Someone Else' });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, 'NAME_MISMATCH');
  });

  test('sessions use the exam\'s own questions, without answers or hints', async () => {
    const token = await signIn('21CS050', 'Arjun Mehta');
    const start = await call('POST', '/api/assessment/session/start', { examId: exam.id, deviceId: 'dev_test_1' }, token);
    assert.equal(start.status, 200);
    assert.equal(start.body.questions.length, 2);
    assert.deepEqual(start.body.questions.map(q => q.id).sort(), exam.questions.map(q => q.id).sort());
    const raw = JSON.stringify(start.body.questions);
    assert.equal(raw.includes('correctOptionId'), false);
    assert.equal(raw.includes('halves the remaining'), false);
    assert.equal(raw.includes('rules out'), false);
  });

  test('closed exams refuse new candidates', async () => {
    await call('PATCH', `/api/assessment/exams/${exam.id}/status`, { status: 'CLOSED' });
    assert.equal((await call('GET', `/api/assessment/exams/join/${exam.code}`)).status, 403);
    const token = await signIn('21CS051', 'Late Student');
    assert.equal((await call('POST', '/api/assessment/session/start', { examId: exam.id, deviceId: 'dev_x' }, token)).status, 403);
    await call('PATCH', `/api/assessment/exams/${exam.id}/status`, { status: 'OPEN' });
  });

  test('guided help refuses answer requests and off-topic questions, and logs everything', async () => {
    const token = await signIn('21CS060', 'Neha Rao');
    const start = await call('POST', '/api/assessment/session/start', { examId: exam.id, deviceId: 'dev_assist' }, token);
    const sessionId = start.body.sessionId;
    const qId = exam.questions[0].id;

    const askAnswer = await call('POST', '/api/assist', { sessionId, questionId: qId, message: 'Which option is correct?' });
    assert.equal(askAnswer.body.outcome, 'REFUSED_ANSWER_REQUEST');

    const offTopic = await call('POST', '/api/assist', { sessionId, questionId: qId, message: 'Write me a poem about cricket' });
    assert.equal(offTopic.body.outcome, 'REFUSED_OFF_TOPIC');

    const concept = await call('POST', '/api/assist', { sessionId, questionId: qId, message: 'What makes a binary search tree balanced?' });
    assert.equal(concept.body.outcome, 'ANSWERED');
    assert.match(concept.body.reply, /rules out/); // proctor hint used when no model is configured

    const report = await call('GET', `/api/audit/session/${sessionId}/report`);
    assert.equal(report.body.assistLog.length, 3);
  });

  test('the reply sanitiser strips sentences that point at an option', () => {
    const question = datastore.getQuestionById(exam.questions[0].id);
    const out = assistService.sanitizeReply(
      'A balanced tree keeps its height small. The answer is O(log n) because each step halves the tree. Option B is right. Think about the height.',
      question
    );
    assert.equal(out.removed, 2);
    assert.equal(/log n|Option B/i.test(out.text), false);
    assert.match(out.text, /keeps its height small/);
  });

  test('insights connect an answer change to a preceding search', async () => {
    const token = await signIn('21CS070', 'Kabir Singh');
    const start = await call('POST', '/api/assessment/session/start', { examId: exam.id, deviceId: 'dev_insight' }, token);
    const sessionId = start.body.sessionId;
    const q = exam.questions[0];

    await call('POST', '/api/assessment/answer', { sessionId, questionId: q.id, selectedOptionId: 'opt_a' });
    await call('POST', '/api/proctor/search-event', { sessionId, service: 'Google', query: 'binary search tree height', url: 'https://www.google.com/search?q=binary+search+tree+height' });
    await call('POST', '/api/assessment/answer', { sessionId, questionId: q.id, selectedOptionId: 'opt_b' });

    const report = await call('GET', `/api/audit/session/${sessionId}/report`);
    const changed = report.body.insights.find(i => i.kind === 'ANSWER_CHANGED_AFTER_LOOKUP');
    assert.ok(changed, 'expected an answer-changed-after-lookup insight');
    assert.match(changed.text, /binary search tree height/);
  });

  test('search policy blocks AI sites, pasted questions and off-topic searches', () => {
    const policy = new SearchPolicy();
    const g = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    assert.equal(policy.evaluate('https://chatgpt.com/').action, 'allow'); // no exam on screen

    policy.setContext({ questionText: QUESTIONS[0].text, options: QUESTIONS[0].options, category: 'Algorithms', rules: {} });
    assert.equal(policy.evaluate('https://chatgpt.com/').reason, 'AI_SITE');
    assert.equal(policy.evaluate(g(QUESTIONS[0].text)).reason, 'QUESTION_COPY');
    assert.equal(policy.evaluate(g('ipl final score')).reason, 'OFF_TOPIC');
    const rewrite = policy.evaluate(g('binary search tree balancing'));
    assert.equal(rewrite.action, 'rewrite');
    assert.match(rewrite.url, /udm=14/);
    assert.equal(policy.evaluate('https://en.wikipedia.org/wiki/Binary_search_tree').action, 'allow');
  });
});
