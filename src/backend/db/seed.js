const fs = require('fs');
const path = require('path');
const config = require('../config');

const defaultCandidates = [
  {
    id: 'STU-001',
    name: 'Alex Rivera',
    email: 'alex.rivera@university.edu',
    rollNo: 'CS-2026-042',
    faceRegistered: false,
    createdAt: 1730246400000
  },
  {
    id: 'STU-002',
    name: 'Priya Sharma',
    email: 'priya.sharma@university.edu',
    rollNo: 'CS-2026-088',
    faceRegistered: false,
    createdAt: 1730246400000
  },
  {
    id: 'STU-003',
    name: 'Marcus Chen',
    email: 'marcus.chen@university.edu',
    rollNo: 'CS-2026-105',
    faceRegistered: false,
    createdAt: 1730246400000
  }
];

function loadSeedQuestions() {
  const filePath = config.SEED_QUESTIONS_FILE;
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (err) {
      console.warn(`[Seed] Warning loading ${filePath}: ${err.message}. Using built-in fallback.`);
    }
  }

  // Built-in fallback questions
  return [
    {
      id: 'q1',
      category: 'Operating Systems & Concurrency',
      difficulty: 'medium',
      prompt: 'Which IPC mechanism in modern Node.js allows multiple worker threads to read and write to the exact same memory buffer without serialization overhead?',
      text: 'Which IPC mechanism in modern Node.js allows multiple worker threads to read and write to the exact same memory buffer without serialization overhead?',
      options: [
        { id: 'opt_a', text: 'MessageChannel with structured cloning' },
        { id: 'opt_b', text: 'SharedArrayBuffer combined with Atomics' },
        { id: 'opt_c', text: 'ChildProcess standard I/O pipes' },
        { id: 'opt_d', text: 'Unix Domain Sockets' }
      ],
      correctOptionId: 'opt_b',
      explanation: 'SharedArrayBuffer combined with Atomics allows worker threads to share binary memory directly without copying.',
      marks: 2,
      negativeMarks: 0.5
    },
    {
      id: 'q2',
      category: 'Web Security & Electron Architecture',
      difficulty: 'medium',
      prompt: 'In an Electron desktop application, which security configuration prevents third-party scripts loaded in a guest window/frame from accessing Node.js runtime APIs?',
      text: 'In an Electron desktop application, which security configuration prevents third-party scripts loaded in a guest window/frame from accessing Node.js runtime APIs?',
      options: [
        { id: 'opt_a', text: 'Setting contextIsolation: true and nodeIntegration: false' },
        { id: 'opt_b', text: 'Disabling webSecurity' },
        { id: 'opt_c', text: 'Running renderer process with elevated permissions' },
        { id: 'opt_d', text: 'Enabling allowRunningInsecureContent' }
      ],
      correctOptionId: 'opt_a',
      explanation: 'Setting contextIsolation: true and nodeIntegration: false guarantees script execution in an isolated JS context.',
      marks: 2,
      negativeMarks: 0.5
    }
  ];
}

/**
 * Test fixtures only. The automated suites run against an in-memory store and expect
 * these candidates and the fixture question bank. A real (persistent) store starts
 * empty: proctors create exams with their own questions and candidates create profiles.
 */
async function seedInitialData(datastore) {
  if (!datastore || !datastore.inMemoryOnly) return;

  // Seed candidates if none exist
  const existingCandidates = datastore.getAllCandidates ? datastore.getAllCandidates() : [];
  if (existingCandidates.length === 0) {
    for (const candidate of defaultCandidates) {
      datastore.addCandidate(candidate);
    }
  }

  // Seed questions if none exist
  const existingQuestions = datastore.getAllQuestions ? datastore.getAllQuestions() : [];
  if (existingQuestions.length === 0) {
    const questions = loadSeedQuestions();
    datastore.setQuestions(questions);
  }

  if (typeof datastore.saveToDisk === 'function') {
    await datastore.saveToDisk();
  }
}

module.exports = {
  defaultCandidates,
  loadSeedQuestions,
  seedInitialData
};
