import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeUsageToReading, codexLimitsToReading, suggest } from '../src/usage/parse.ts';

const now = new Date('2026-10-22T12:00:00Z');
const W = (kind, label, leftPct, resetsAt = null) => ({ kind, label, leftPct, resetsAt });
const R = (provider, status, windows) => ({ provider, status, windows, readAt: now.toISOString() });

test('claude: maps windows', () => {
  const r = claudeUsageToReading({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 28, resets_at: '2026-10-22T14:40:00Z' },
      seven_day: { utilization: 42, resets_at: '2026-10-23T09:00:00Z' },
      seven_day_opus: { utilization: 66, resets_at: null },
      other: { utilization: 1, resets_at: null },
    },
  }, now);
  assert.equal(r.provider, 'claude');
  assert.equal(r.status, 'ok');
  assert.equal(r.readAt, now.toISOString());
  assert.deepEqual(r.windows, [
    W('five_hour', '5-hour', 72, '2026-10-22T14:40:00Z'),
    W('weekly', 'Weekly', 58, '2026-10-23T09:00:00Z'),
    W('model', 'Opus · weekly', 34),
  ]);
});
test('claude: unavailable', () => {
  const r = claudeUsageToReading({ rate_limits_available: false, rate_limits: null }, now);
  assert.equal(r.status, 'unavailable');
  assert.deepEqual(r.windows, []);
});
const snap = {
  limitId: 'codex', limitName: null,
  primary: { usedPercent: 69, windowDurationMins: 300, resetsAt: 1792680600 },
  secondary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: 1792944000 },
};
test('codex: primary/secondary', () => {
  const r = codexLimitsToReading({ rateLimits: snap }, now);
  assert.equal(r.provider, 'codex');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.windows, [
    W('five_hour', '5-hour', 31, new Date(1792680600 * 1000).toISOString()),
    W('weekly', 'Weekly', 18, new Date(1792944000 * 1000).toISOString()),
  ]);
});
test('codex: extra snapshots become model windows', () => {
  const r = codexLimitsToReading({
    rateLimits: snap,
    rateLimitsByLimitId: {
      codex: snap,
      codex_mini: { limitId: 'codex_mini', limitName: 'Codex Mini', primary: null, secondary: { usedPercent: 36, windowDurationMins: 10080, resetsAt: null } },
    },
  }, now);
  assert.equal(r.windows.length, 3);
  assert.deepEqual(r.windows[2], W('model', 'Codex Mini', 64));
});
test('codex: null windows and odd durations ignored', () => {
  const r = codexLimitsToReading({ rateLimits: { limitId: 'codex', limitName: null, primary: null, secondary: { usedPercent: 10, windowDurationMins: 1000, resetsAt: null } } }, now);
  assert.deepEqual(r.windows, []);
});
const t = (h) => `2026-10-22T${h}:00:00Z`;
test('suggest: best score wins', () => {
  const rs = [
    R('claude', 'ok', [W('five_hour', '5-hour', 72), W('weekly', 'Weekly', 58)]),
    R('codex', 'ok', [W('five_hour', '5-hour', 31), W('weekly', 'Weekly', 18)]),
    R('antigravity', 'ok', [W('five_hour', '5-hour', 88), W('weekly', 'Weekly', 74)]),
  ];
  assert.equal(suggest(rs, ['claude', 'codex', 'antigravity']), 'antigravity');
  assert.equal(suggest(rs, ['claude', 'codex']), 'claude');
  rs[2] = R('antigravity', 'unavailable', []);
  assert.equal(suggest(rs, ['claude', 'codex', 'antigravity']), 'claude');
});
test('suggest: tie goes to earlier 5-hour reset', () => {
  const rs = [
    R('claude', 'ok', [W('five_hour', '5-hour', 50, t('15')), W('weekly', 'Weekly', 50)]),
    R('codex', 'ok', [W('five_hour', '5-hour', 50, t('14')), W('weekly', 'Weekly', 50)]),
  ];
  assert.equal(suggest(rs, ['claude', 'codex']), 'codex');
});
test('suggest: empty → null', () => assert.equal(suggest([], ['claude']), null));
