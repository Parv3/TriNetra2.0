const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { startServer, stopServer } = require('../src/backend/server');
const datastore = require('../src/backend/db/datastore');
const cloudState = require('../src/backend/db/cloudState');

// Render's free plan has no disk: the server must come back with its exams after a restart.
test.describe('Server state kept in PostgreSQL (hosts without a disk)', () => {
  const db = newDb();
  const newPool = () => new (db.adapters.createPg().Pool)();

  const createExam = async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/assessment/exams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Survives a restart', questions: [{ text: '2 + 2?', options: ['3', '4'], correctIndex: 1 }] })
    });
    assert.equal(res.status, 201);
    return res.json();
  };

  test('exams created before a restart are there after it', async () => {
    const first = await startServer({ port: 0, inMemoryOnly: true, databaseUrl: '', stateDatabaseUrl: newPool() });
    assert.equal(cloudState.status.enabled, true);
    const exam = await createExam(first.port);
    await stopServer(); // flushes the pending save

    datastore.reset();
    assert.equal(datastore.getExam(exam.id), null, 'memory is empty, as after a restart');

    const second = await startServer({ port: 0, inMemoryOnly: true, databaseUrl: '', stateDatabaseUrl: newPool() });
    const restored = datastore.getExam(exam.id);
    assert.ok(restored, 'the exam was loaded back from PostgreSQL');
    assert.equal(restored.title, 'Survives a restart');
    assert.equal(restored.code, exam.code);
    assert.ok(second.port);
    await stopServer();
  });

  test('a database that cannot be reached leaves saving off', async () => {
    const broken = { query: async () => { throw new Error('connection refused'); } };
    await startServer({ port: 0, inMemoryOnly: true, databaseUrl: '', stateDatabaseUrl: broken });
    assert.equal(datastore.cloudState, null);
    assert.match(cloudState.status.lastError, /connection refused/);
    await stopServer();
  });
});
