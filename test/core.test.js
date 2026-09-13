'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_COMPLETION_MARKER,
  deterministicAutomationId,
  executionWindowOpen,
  hasExactCompletionMarker,
  latestDueGuardEvent,
  migrateCompletionDefaults,
  normalizeTimeout,
  rowAfterCursor,
  validateConfigPatch,
} = require('../lib/core');

test('completion marker must be the final non-empty line', () => {
  assert.equal(hasExactCompletionMarker('尚未全部完成', '全部完成'), false);
  assert.equal(hasExactCompletionMarker('引用 [[ZTQ_TASK_DONE]] 后还有工作', DEFAULT_COMPLETION_MARKER), false);
  assert.equal(hasExactCompletionMarker('完成报告\n[[ZTQ_TASK_DONE]]\n\n', DEFAULT_COMPLETION_MARKER), true);
});

test('legacy shipped defaults migrate but custom values remain', () => {
  const migrated = migrateCompletionDefaults({
    continuePrompt: '继续，如果这项完成好了，告诉我全部完成，并给出完成报告。',
    completionMarker: '全部完成',
  });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.settings.completionMarker, DEFAULT_COMPLETION_MARKER);
  const custom = migrateCompletionDefaults({ continuePrompt: '自定义', completionMarker: 'DONE' });
  assert.equal(custom.migrated, false);
  assert.equal(custom.settings.completionMarker, 'DONE');
});

test('automation id is stable and attempt-specific', () => {
  assert.equal(deterministicAutomationId('t0000000001', 1), 'automation-ztq-v1-a62f655a31d023047d78f6469714bac0');
  assert.equal(deterministicAutomationId('t0000000001', 2), 'automation-ztq-v1-39d08c7ca0e11fce89f120f4c1b577c5');
  assert.notEqual(deterministicAutomationId('a', 1), deterministicAutomationId('b', 1));
});

test('execution window is start-inclusive and end-exclusive', () => {
  const s = { scheduleEnabled: true, scheduleStart: '23:00', scheduleEnd: '09:00' };
  assert.equal(executionWindowOpen(s, new Date(2026, 8, 12, 23, 0)), true);
  assert.equal(executionWindowOpen(s, new Date(2026, 8, 13, 8, 59)), true);
  assert.equal(executionWindowOpen(s, new Date(2026, 8, 13, 9, 0)), false);
  assert.equal(executionWindowOpen({ ...s, scheduleEnd: '23:00' }, new Date()), true);
});

test('guard catch-up applies only the latest due transition', () => {
  const settings = { autoStopEnabled: true, autoStopTime: '08:55', autoEnableEnabled: true, autoEnableTime: '23:00' };
  const atNoon = new Date(2026, 8, 12, 12, 0);
  assert.equal(latestDueGuardEvent(settings, {}, atNoon).type, 'stop');
  const atNight = new Date(2026, 8, 12, 23, 5);
  assert.equal(latestDueGuardEvent(settings, {}, atNight).type, 'enable');
});

test('message cursor prioritizes sequence over colliding timestamps', () => {
  const cursor = { sequence: 10, timeCreated: 1000, messageId: 'm10' };
  assert.equal(rowAfterCursor({ sequence: 11, time_created: 1000, id: 'm11' }, cursor), true);
  assert.equal(rowAfterCursor({ sequence: 10, time_created: 2000, id: 'm12' }, cursor), false);
  const legacyCursor = { sequence: null, timeCreated: 1000, messageId: 'legacy-a' };
  assert.equal(rowAfterCursor({ sequence: null, time_created: 1001, id: 'legacy-b' }, legacyCursor), true);
  assert.equal(rowAfterCursor({ sequence: null, time_created: 1000, id: 'legacy-a' }, legacyCursor), false);
});

test('timeout tri-state and config validation stay strict', () => {
  assert.equal(normalizeTimeout(''), null);
  assert.equal(normalizeTimeout(0), 0);
  assert.equal(normalizeTimeout('15'), 15);
  assert.throws(() => normalizeTimeout(-1));
  assert.throws(() => normalizeTimeout(10081), /10080/);
  const current = { completionMarker: 'x', continuePrompt: 'y', scheduleStart: '23:00' };
  assert.throws(() => validateConfigPatch({ completionMarker: '' }, current, { plan: {} }));
  assert.throws(() => validateConfigPatch({ scheduleStart: '25:00' }, current, { plan: {} }));
  assert.throws(() => validateConfigPatch({ continuePrompt: 'x'.repeat(20001) }, current, { plan: {} }), /20000/);
  assert.throws(() => validateConfigPatch({ model: 'x'.repeat(201) }, current, { plan: {} }), /200/);
});
