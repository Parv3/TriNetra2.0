const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/renderer/js/voiceAnalysis');
const F = require('./helpers/voiceFixtures');

// Real recorded speech: "David" (male, ~90 Hz) is the student, "Zira" (female, ~175 Hz) is
// someone else in the room. Each scenario also says what the camera reports about the
// student's lips: moving, still, or unknown (null, e.g. face turned away).
const david = F.readWav('david_speech.wav').samples;
const zira = F.readWav('zira_speech.wav').samples;
const baselineOf = (name) => V.buildBaseline([...F.frames(F.withRoomNoise(F.readWav(name).samples))].map(f => V.analyzeFrame(f.data, F.RATE)));
const davidBaseline = baselineOf('david_enroll.wav');
const ziraBaseline = baselineOf('zira_enroll.wav');

/** Runs audio through the detector. lips(tSeconds) → true | false | null. Returns events with times. */
function run(samples, { baseline = davidBaseline, lips = () => null, strictness = 'standard', faceCount = 1 } = {}) {
  const detector = new V.VoiceDetector({ strictness, baseline });
  const events = [];
  for (const frame of F.frames(F.withRoomNoise(samples))) {
    const event = detector.push(V.analyzeFrame(frame.data, F.RATE), { t: frame.t, faceCount, lipsMoving: lips(frame.t / 1000) });
    if (event) events.push({ ...event, at: frame.t / 1000 });
  }
  return events;
}
const types = (events) => events.map(e => e.type);

describe('Voice analysis on real speech', () => {
  test('the voice sample gives each speaker the right pitch', () => {
    assert.ok(davidBaseline.ok && ziraBaseline.ok);
    assert.ok(davidBaseline.pitchHz >= 75 && davidBaseline.pitchHz <= 120, `David ${davidBaseline.pitchHz} Hz`);
    assert.ok(ziraBaseline.pitchHz >= 150 && ziraBaseline.pitchHz <= 230, `Zira ${ziraBaseline.pitchHz} Hz`);
  });

  test('a voice sample with no speech is refused', () => {
    const quiet = [...F.frames(F.withRoomNoise(F.silence(5)))].map(f => V.analyzeFrame(f.data, F.RATE));
    assert.equal(V.buildBaseline(quiet).ok, false);
  });

  test('a quiet room raises nothing', () => {
    assert.deepEqual(run(F.silence(12), { lips: () => false }), []);
  });

  test('the student reading aloud, lips moving, raises nothing', () => {
    assert.deepEqual(run(F.concat(F.silence(1.5), david), { lips: () => true }), []);
  });

  test('a female student reading aloud raises nothing either', () => {
    assert.deepEqual(run(F.concat(F.silence(1.5), zira), { baseline: ziraBaseline, lips: () => true }), []);
  });

  test('someone else speaking while the student sits silent is caught within seconds', () => {
    const events = run(F.concat(F.silence(1.5), zira), { lips: () => false });
    assert.ok(events.length >= 1, 'flagged');
    assert.equal(events[0].type, 'OTHER_VOICE');
    assert.equal(events[0].details.reason, 'lips-still');
    assert.ok(events[0].at < 1.5 + 6, `flagged after ${events[0].at - 1.5}s of speech`);
  });

  test('another man speaking (same pitch range as the student) is still caught by the lip check', () => {
    const events = run(F.concat(F.silence(1.5), david), { lips: () => false });
    assert.equal(types(events)[0], 'OTHER_VOICE');
  });

  test('a conversation between the student and someone else is caught', () => {
    // David (the student, lips moving) and Zira take turns every few seconds
    const parts = [F.slice(david, 0, 4), F.slice(zira, 0, 4), F.slice(david, 4, 8), F.slice(zira, 4, 8), F.slice(david, 8, 12)];
    const audio = F.concat(F.silence(1.5), ...parts);
    const studentTalking = (t) => (t >= 1.5 && t < 5.5) || (t >= 9.5 && t < 13.5) || (t >= 17.5);
    const events = run(audio, { lips: (t) => studentTalking(t) });
    assert.ok(events.length >= 1, 'flagged');
    assert.ok(types(events).some(t => t === 'MULTIPLE_VOICES' || t === 'OTHER_VOICE'));
  });

  test('with the face out of view, two voices are still told apart by pitch', () => {
    const parts = [F.slice(david, 0, 3), F.slice(zira, 0, 3), F.slice(david, 3, 6), F.slice(zira, 3, 6), F.slice(david, 6, 9), F.slice(zira, 6, 9)];
    const events = run(F.concat(F.silence(1.5), ...parts), { lips: () => null });
    const multi = events.find(e => e.type === 'MULTIPLE_VOICES');
    assert.ok(multi, `events: ${JSON.stringify(types(events))}`);
    const [low, high] = multi.details.voicesHz;
    assert.ok(low < 120 && high > 140, `voices ${low} Hz and ${high} Hz`);
  });

  test("with the face out of view, a voice that isn't the student's is caught", () => {
    const events = run(F.concat(F.silence(1.5), zira), { lips: () => null });
    assert.equal(types(events)[0], 'OTHER_VOICE');
    assert.equal(events[0].details.reason, 'voice-mismatch');
  });

  test("with the face out of view, the student's own voice raises nothing", () => {
    assert.deepEqual(run(F.concat(F.silence(1.5), david), { lips: () => null }), []);
  });

  test('strict exams flag sooner than relaxed ones', () => {
    const audio = F.concat(F.silence(1.5), zira);
    const strict = run(audio, { lips: () => false, strictness: 'strict' })[0];
    const relaxed = run(audio, { lips: () => false, strictness: 'relaxed' })[0];
    assert.ok(strict && relaxed);
    assert.ok(strict.at < relaxed.at, `strict ${strict.at}s, relaxed ${relaxed.at}s`);
  });

  test('the same warning is not repeated within the cooldown', () => {
    const long = F.concat(F.silence(1.5), zira, zira.slice(0, 16000 * 4));
    const events = run(long, { lips: () => false }).filter(e => e.type === 'OTHER_VOICE');
    for (let i = 1; i < events.length; i++) assert.ok(events[i].at - events[i - 1].at >= 10);
  });
});
