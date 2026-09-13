'use strict';

const crypto = require('crypto');

const LEGACY_CONTINUE_PROMPT = '继续，如果这项完成好了，告诉我全部完成，并给出完成报告。';
const LEGACY_COMPLETION_MARKER = '全部完成';
const DEFAULT_COMPLETION_MARKER = '[[ZTQ_TASK_DONE]]';
const MAX_TIMEOUT_MIN = 10080;
const DEFAULT_CONTINUE_PROMPT = [
  '继续完成当前任务。',
  `只有在所有要求都已完成、验证通过且无需后续工作时，才在最终回复的最后一个非空行单独输出 ${DEFAULT_COMPLETION_MARKER}。`,
  '否则不要输出该标记，并明确说明剩余工作。',
].join('');

const ACTIVE_STATUSES = new Set(['waiting', 'running']);
const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped', 'timeout']);

function lastNonEmptyLine(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.length ? lines[lines.length - 1].trim() : '';
}

function hasExactCompletionMarker(text, marker) {
  const expected = String(marker || '').trim();
  return Boolean(expected) && !expected.includes('\n') && lastNonEmptyLine(text) === expected;
}

function deterministicAutomationId(taskId, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt 必须是正整数');
  const digest = crypto.createHash('sha256').update(String(taskId)).update('\0').update(String(attempt)).digest('hex');
  return `automation-ztq-v1-${digest.slice(0, 32)}`;
}

function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function executionWindowOpen(settings, at = new Date()) {
  if (!settings.scheduleEnabled) return true;
  const start = parseClock(settings.scheduleStart);
  const end = parseClock(settings.scheduleEnd);
  if (start == null || end == null || start === end) return true;
  const minute = at.getHours() * 60 + at.getMinutes();
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function localDayKey(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

function scheduledAtForDay(day, clock) {
  const minute = parseClock(clock);
  if (minute == null) return null;
  const d = new Date(day);
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return d.getTime();
}

/** Return only the latest due stop/enable transition; older opposite events are superseded. */
function latestDueGuardEvent(settings, guardState, at = new Date()) {
  const candidates = [];
  const today = new Date(at); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  for (const day of [yesterday, today]) {
    if (settings.autoStopEnabled) {
      const time = scheduledAtForDay(day, settings.autoStopTime);
      if (time != null && time <= at.getTime() && time > Number(guardState.stopLastAt || 0)) candidates.push({ type: 'stop', time });
    }
    if (settings.autoEnableEnabled) {
      const time = scheduledAtForDay(day, settings.autoEnableTime);
      if (time != null && time <= at.getTime() && time > Number(guardState.enableLastAt || 0)) candidates.push({ type: 'enable', time });
    }
  }
  candidates.sort((a, b) => b.time - a.time);
  const event = candidates[0] || null;
  if (!event) return null;
  const lastAppliedAt = Number(guardState.lastAppliedAt || 0);
  return event.time > lastAppliedAt ? event : null;
}

function normalizeTimeout(value, { allowUndefined = true, max = MAX_TIMEOUT_MIN } = {}) {
  if (value === undefined || value === null || value === '') return allowUndefined ? null : 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`超时必须为空或 0–${max} 分钟`);
  return n;
}

function migrateCompletionDefaults(settings) {
  const out = { ...settings };
  if (out.continuePrompt === LEGACY_CONTINUE_PROMPT && out.completionMarker === LEGACY_COMPLETION_MARKER) {
    out.continuePrompt = DEFAULT_CONTINUE_PROMPT;
    out.completionMarker = DEFAULT_COMPLETION_MARKER;
    return { settings: out, migrated: true };
  }
  return { settings: out, migrated: false };
}

function validateTime(value, field) {
  if (parseClock(value) == null) throw new Error(`${field} 必须是有效的 HH:MM 时间`);
  return String(value);
}

function validateConfigPatch(body, current, plans) {
  const next = { ...current };
  const number = (key, min, max) => {
    if (body[key] == null) return;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} 必须在 ${min}–${max} 之间`);
    next[key] = n;
  };
  number('intervalSec', 0, 86400);
  number('defaultTimeoutMin', 0, 10080);
  number('maxRounds', 1, 200);
  number('stallMin', 3, 180);
  for (const key of ['stopOnFail', 'autoStopEnabled', 'autoEnableEnabled', 'focusOnDispatch', 'scheduleEnabled']) {
    if (body[key] != null) {
      if (typeof body[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
      next[key] = body[key];
    }
  }
  if (body.plan != null) {
    if (!plans[body.plan]) throw new Error('未知模型套餐');
    next.plan = body.plan;
  }
  if (body.model != null) {
    const model = String(body.model).trim();
    if (!model || model.length > 200) throw new Error('模型必须是 1–200 个字符');
    next.model = model;
  }
  if (body.continuePrompt != null) {
    const prompt = String(body.continuePrompt).trim();
    if (!prompt || prompt.length > 20000) throw new Error('续跑话术必须是 1–20000 个字符');
    next.continuePrompt = prompt;
  }
  if (body.completionMarker != null) {
    const marker = String(body.completionMarker).trim();
    if (!marker || marker.includes('\n') || marker.length > 100) throw new Error('完成标记必须是 1–100 个字符的单行文本');
    next.completionMarker = marker;
  }
  for (const key of ['autoStopTime', 'autoEnableTime', 'scheduleStart', 'scheduleEnd']) {
    if (body[key] != null) next[key] = validateTime(body[key], key);
  }
  return next;
}

function rowAfterCursor(row, cursor) {
  if (!cursor) return true;
  const rowHasSequence = row.sequence !== null && row.sequence !== undefined && row.sequence !== '';
  const cursorHasSequence = cursor.sequence !== null && cursor.sequence !== undefined && cursor.sequence !== '';
  const seq = Number(row.sequence);
  const baseSeq = Number(cursor.sequence);
  if (rowHasSequence && cursorHasSequence && Number.isFinite(seq) && Number.isFinite(baseSeq)) return seq > baseSeq;
  const time = Number(row.time_created || row.timeCreated || 0);
  const baseTime = Number(cursor.timeCreated || 0);
  if (time !== baseTime) return time > baseTime;
  return String(row.id || '') > String(cursor.messageId || '');
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  LEGACY_CONTINUE_PROMPT,
  LEGACY_COMPLETION_MARKER,
  MAX_TIMEOUT_MIN,
  DEFAULT_CONTINUE_PROMPT,
  DEFAULT_COMPLETION_MARKER,
  deterministicAutomationId,
  executionWindowOpen,
  hasExactCompletionMarker,
  lastNonEmptyLine,
  latestDueGuardEvent,
  localDayKey,
  migrateCompletionDefaults,
  normalizeTimeout,
  parseClock,
  rowAfterCursor,
  validateConfigPatch,
};
