#!/usr/bin/env node
/**
 * Smart Proctoring Browser — Opaque-Box E2E Test Runner
 *
 * Standalone test runner for the 4-tier requirement-driven E2E test suite.
 * Validates the complete desktop application and backend assessment engine
 * according to user-facing specifications in ORIGINAL_REQUEST.md and PROJECT.md.
 *
 * Tiers:
 * - Tier 1: Feature Coverage (60 tests across 12 features)
 * - Tier 2: Boundary & Corner Cases (60 tests across 12 features)
 * - Tier 3: Cross-Feature Interactions (14 pairwise tests)
 * - Tier 4: Real-World Workload Scenarios (7 realistic student journeys)
 *
 * Usage:
 *   node e2e/runner.js              # Run all 4 tiers (141 tests)
 *   node e2e/runner.js --tier=1     # Run Tier 1 only
 *   node e2e/runner.js --tier=2     # Run Tier 2 only
 *   node e2e/runner.js --tier=3     # Run Tier 3 only
 *   node e2e/runner.js --tier=4     # Run Tier 4 only
 *   node e2e/runner.js --verbose    # Show detailed test case progress
 *   node e2e/runner.js --json       # Output machine-readable JSON summary
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// ANSI Terminal Colors
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';

const TIERS = [
  {
    tier: 1,
    name: 'Tier 1: Feature Coverage',
    file: 'tier1_features.test.js',
    description: 'Happy paths across all 12 core features (Launch, Auth, Questions, Timer, Vision, Tab/Search Tracking, Audit)',
    targetMin: 60
  },
  {
    tier: 2,
    name: 'Tier 2: Boundary & Corner Cases',
    file: 'tier2_boundaries.test.js',
    description: 'Limits, zero inputs, rapid fire submissions, expired sessions, angle limits, EAR blinks, strike thresholds',
    targetMin: 60
  },
  {
    tier: 3,
    name: 'Tier 3: Cross-Feature Interactions',
    file: 'tier3_interactions.test.js',
    description: 'Pairwise combinations (Auth + Timer, Strikes + Disqualification, Queries + Answering, Offline Sync)',
    targetMin: 12
  },
  {
    tier: 4,
    name: 'Tier 4: Real-World Scenarios',
    file: 'tier4_scenarios.test.js',
    description: 'End-to-end multi-step student assessment journeys (Normal Exam, Cheating Disqualification, Timeout Sweeper)',
    targetMin: 6
  }
];

function printBanner() {
  console.log(`\n${BOLD}${CYAN}================================================================================${RESET}`);
  console.log(`${BOLD}${CYAN}   SMART PROCTORING BROWSER — OPAQUE-BOX E2E TEST SUITE RUNNER${RESET}`);
  console.log(`${DIM}   Self-contained requirement-driven test verification (Node.js ${process.version})${RESET}`);
  console.log(`${BOLD}${CYAN}================================================================================${RESET}\n`);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    selectedTier: null,
    verbose: false,
    json: false,
    help: false
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('--tier=')) {
      options.selectedTier = parseInt(arg.split('=')[1], 10);
    } else if (/^-[1-4]$/.test(arg)) {
      options.selectedTier = parseInt(arg.replace('-', ''), 10);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Usage: node e2e/runner.js [options]

Options:
  --tier=<1|2|3|4>    Execute only the specified test tier
  -1, -2, -3, -4      Shorthand for tier selection
  --verbose, -v       Stream raw test case output during execution
  --json              Emit structured JSON report on completion
  --help, -h          Display this help message
`);
}

function runTier(tierConfig, options) {
  const testFilePath = path.join(__dirname, tierConfig.file);
  const startTime = Date.now();

  if (!options.json) {
    process.stdout.write(`  ${BOLD}${BLUE}RUNNING${RESET} ${tierConfig.name}... `);
  }

  const child = spawnSync(process.execPath, ['--test', testFilePath], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });

  const durationMs = Date.now() - startTime;
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';

  // Parse node:test output
  const testsMatch = stdout.match(/ℹ tests (\d+)/);
  const passMatch = stdout.match(/ℹ pass (\d+)/);
  const failMatch = stdout.match(/ℹ fail (\d+)/);
  const durationMatch = stdout.match(/ℹ duration_ms ([\d\.]+)/);

  const total = testsMatch ? parseInt(testsMatch[1], 10) : 0;
  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const testDuration = durationMatch ? parseFloat(durationMatch[1]) : durationMs;

  const isSuccess = child.status === 0 && failed === 0 && total >= tierConfig.targetMin;

  if (!options.json) {
    if (isSuccess) {
      console.log(`${BOLD}${GREEN}PASS${RESET} ${DIM}(${passed}/${total} passed in ${testDuration.toFixed(1)}ms)${RESET}`);
    } else {
      console.log(`${BOLD}${RED}FAIL${RESET} ${DIM}(${failed} failed, ${passed} passed in ${testDuration.toFixed(1)}ms)${RESET}`);
    }

    if (options.verbose || !isSuccess) {
      if (stdout) console.log(`\n${stdout}`);
      if (stderr) console.error(`\n${RED}${stderr}${RESET}`);
    }
  }

  return {
    tier: tierConfig.tier,
    name: tierConfig.name,
    targetMin: tierConfig.targetMin,
    total,
    passed,
    failed,
    durationMs: testDuration,
    success: isSuccess,
    stdout,
    stderr
  };
}

function main() {
  const options = parseCliArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!options.json) {
    printBanner();
  }

  const tiersToRun = options.selectedTier
    ? TIERS.filter(t => t.tier === options.selectedTier)
    : TIERS;

  if (tiersToRun.length === 0) {
    console.error(`${RED}Error: Unknown tier selected (${options.selectedTier}). Valid tiers are 1, 2, 3, 4.${RESET}`);
    process.exit(1);
  }

  const results = [];
  const overallStart = Date.now();

  for (const t of tiersToRun) {
    const res = runTier(t, options);
    results.push(res);
  }

  const overallDuration = Date.now() - overallStart;

  const totalTests = results.reduce((sum, r) => sum + r.total, 0);
  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const allPassed = results.every(r => r.success);

  if (options.json) {
    const jsonOutput = {
      timestamp: new Date().toISOString(),
      allPassed,
      overallDurationMs: overallDuration,
      summary: {
        totalTests,
        totalPassed,
        totalFailed
      },
      tiers: results.map(r => ({
        tier: r.tier,
        name: r.name,
        targetMin: r.targetMin,
        total: r.total,
        passed: r.passed,
        failed: r.failed,
        durationMs: r.durationMs,
        success: r.success
      }))
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    process.exit(allPassed ? 0 : 1);
  }

  // Executive Summary Table
  console.log(`\n${BOLD}================================================================================${RESET}`);
  console.log(`${BOLD}   EXECUTIVE TEST EXECUTION SUMMARY${RESET}`);
  console.log(`${BOLD}================================================================================${RESET}`);
  console.log(`${'Tier Name'.padEnd(35)} | ${'Target'.padEnd(8)} | ${'Actual'.padEnd(8)} | ${'Passed'.padEnd(8)} | ${'Failed'.padEnd(8)} | ${'Status'.padEnd(8)}`);
  console.log('--------------------------------------------------------------------------------');

  for (const r of results) {
    const statusStr = r.success ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`${r.name.padEnd(35)} | ${String(r.targetMin).padEnd(8)} | ${String(r.total).padEnd(8)} | ${String(r.passed).padEnd(8)} | ${String(r.failed).padEnd(8)} | ${statusStr}`);
  }

  console.log('--------------------------------------------------------------------------------');
  console.log(`${BOLD}TOTAL TESTS:${RESET} ${totalTests.toString().padEnd(23)} | ${'138'.padEnd(8)} | ${totalTests.toString().padEnd(8)} | ${GREEN}${totalPassed.toString().padEnd(8)}${RESET} | ${totalFailed > 0 ? RED : ''}${totalFailed.toString().padEnd(8)}${RESET} | ${allPassed ? `${BOLD}${GREEN}PASS${RESET}` : `${BOLD}${RED}FAIL${RESET}`}`);
  console.log(`${BOLD}EXECUTION DURATION:${RESET} ${(overallDuration / 1000).toFixed(2)}s\n`);

  if (allPassed) {
    console.log(`${BOLD}${GREEN}✔ ALL E2E REQUIREMENTS VERIFIED SUCCESSFULLY WITH ZERO TEST FAILURES.${RESET}`);
    console.log(`${DIM}Test suite is ready for Milestone 5 automated gates and continuous verification.${RESET}\n`);
    process.exit(0);
  } else {
    console.error(`${BOLD}${RED}✖ TEST SUITE RUN FAILED: Encountered ${totalFailed} test failure(s).${RESET}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runTier, TIERS };
