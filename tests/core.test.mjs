import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './load-core.mjs';

const C = loadCore();
const H = C.HOUR_MS;
const M = 60 * 1000;

const task = (id, timeSpentOnDay, extra = {}) => ({
  id,
  title: id,
  projectId: null,
  tagIds: [],
  subTaskIds: [],
  parentId: null,
  timeSpentOnDay,
  ...extra,
});

// ---------- dates ----------

test('startOfWeek honours the configured first day', () => {
  const wed = new Date(2026, 9, 28); // Wed 28 Oct 2026
  assert.equal(C.toDateStr(C.startOfWeek(wed, 1)), '2026-10-26');
  assert.equal(C.toDateStr(C.startOfWeek(wed, 0)), '2026-10-25');
  assert.equal(C.toDateStr(C.startOfWeek(wed, 6)), '2026-10-24');
  const mon = new Date(2026, 9, 26, 23, 59);
  assert.equal(C.toDateStr(C.startOfWeek(mon, 1)), '2026-10-26');
});

test('weekDates crosses month and year boundaries by calendar day', () => {
  const days = C.weekDates(new Date(2026, 11, 28)).map(C.toDateStr);
  assert.deepEqual(days, ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
});

// ---------- durations ----------

test('parseDuration accepts the documented formats', () => {
  assert.equal(C.parseDuration('2h35m'), 2 * H + 35 * M);
  assert.equal(C.parseDuration('2h 35m'), 2 * H + 35 * M);
  assert.equal(C.parseDuration('1h'), H);
  assert.equal(C.parseDuration('34m'), 34 * M);
  assert.equal(C.parseDuration('34min'), 34 * M);
  assert.equal(C.parseDuration('1.5h'), 1.5 * H);
  assert.equal(C.parseDuration('2.5'), 2.5 * H);
  assert.equal(C.parseDuration('1:30'), 90 * M);
  assert.equal(C.parseDuration(' 1H 5M '), 65 * M);
});

test('parseDuration rejects junk instead of guessing', () => {
  for (const bad of ['', 'abc', 'h', 'm', '2x', '1:75', '-1h', 'h2', '2h35']) {
    assert.ok(Number.isNaN(C.parseDuration(bad)), `expected NaN for ${JSON.stringify(bad)}`);
  }
});

test('formatDuration and toDurationInput', () => {
  assert.equal(C.formatDuration(0), '0h');
  assert.equal(C.formatDuration(34 * M), '34m');
  assert.equal(C.formatDuration(2 * H), '2h');
  assert.equal(C.formatDuration(2 * H + 35 * M), '2h 35m');
  assert.equal(C.formatDuration(2 * H + 15 * M, 'decimal'), '2.25h');
  assert.equal(C.toDurationInput(2 * H + 35 * M), '2h35m');
  assert.equal(C.formatClock(65 * M), '1:05');
});

// ---------- settings ----------

test('coerceSettings keeps valid values and replaces invalid ones', () => {
  const s = C.coerceSettings({
    weekStartsOn: 0,
    dailyTargetHours: [0, 8, 8, '7.5', 8, 99, -3],
    timeFormat: 'decimal',
    showSubtasks: false,
    debugLogging: 'yes',
    unknown: 1,
  });
  assert.deepEqual(s, {
    weekStartsOn: 0,
    dailyTargetHours: [0, 8, 8, 7.5, 8, 24, 0],
    timeFormat: 'decimal',
    showSubtasks: false,
    debugLogging: false,
    view: 'sheet',
    breakdownBy: 'project',
  });
  const d = C.coerceSettings({ weekStartsOn: 3, dailyTargetHours: [1, 2], timeFormat: 'x' });
  assert.equal(d.weekStartsOn, 1);
  assert.deepEqual(d.dailyTargetHours, [0, 8, 8, 8, 8, 8, 0]);
  assert.equal(d.timeFormat, 'hm');
});

// ---------- merging live tasks ----------

test('SP is authoritative for live tasks: removed days disappear from the log', () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-10-26': H, '2026-10-27': H })]);
  C.mergeLiveTasks(log, [task('a', { '2026-10-27': 2 * H })]);
  assert.deepEqual(log.entries.a.byDate, { '2026-10-27': 2 * H });
});

test('a live task with no tracked time left is dropped', () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-10-26': H })]);
  const { changed } = C.mergeLiveTasks(log, [task('a', {})]);
  assert.equal(changed, true);
  assert.equal(log.entries.a, undefined);
});

test('merging identical data reports no change', () => {
  const log = C.emptyLog();
  const tasks = [task('a', { '2026-10-26': H }, { tagIds: ['t1'] })];
  const opts = { tagsById: { t1: { title: 'Work' } } };
  assert.equal(C.mergeLiveTasks(log, tasks, opts).changed, true);
  assert.equal(C.mergeLiveTasks(log, tasks, opts).changed, false);
});

test('missing tasks are only flagged deleted after a complete fetch', () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-10-26': H }), task('b', { '2026-10-26': H })]);

  const partial = C.mergeLiveTasks(log, [task('a', { '2026-10-26': H })]);
  assert.equal(partial.missing, 1);
  assert.equal(log.entries.b.isDeleted, false);

  C.mergeLiveTasks(log, [task('a', { '2026-10-26': H })], { complete: true });
  assert.equal(log.entries.b.isDeleted, true);
  assert.equal(log.entries.b.byDate['2026-10-26'], H, 'hours are kept');

  C.mergeLiveTasks(log, [task('b', { '2026-10-26': H })], { complete: true });
  assert.equal(log.entries.b.isDeleted, false, 'a restored task is live again');
});

test('merge never touches manual entries and ignores the Today tag', () => {
  const log = C.emptyLog();
  const id = C.addManualEntry(log, { title: 'Call', date: '2026-10-26', ms: H }, () => 'manual-1');
  C.mergeLiveTasks(log, [task('x', { '2026-10-26': H }, { tagIds: ['TODAY', 't1'] })], { complete: true });
  assert.equal(log.entries[id].isManual, true);
  assert.equal(log.entries[id].isDeleted, false);
  assert.deepEqual(log.entries.x.tags.map((t) => t.id), ['t1']);
});

test('project and tag titles survive a failed project/tag fetch', () => {
  const log = C.emptyLog();
  const t = task('a', { '2026-10-26': H }, { projectId: 'p1', tagIds: ['t1'] });
  C.mergeLiveTasks(log, [t], { projectsById: { p1: { title: 'Client', theme: { primary: '#ff0000' } } }, tagsById: { t1: { title: 'Work' } } });
  C.mergeLiveTasks(log, [t], {});
  assert.equal(log.entries.a.projectTitle, 'Client');
  assert.equal(log.entries.a.projectColor, '#ff0000');
  assert.equal(log.entries.a.tags[0].title, 'Work');
});

test('unsafe project colors are dropped', () => {
  assert.equal(C.safeColor('#12abef'), '#12abef');
  assert.equal(C.safeColor('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
  assert.equal(C.safeColor('red;background:url(x)'), null);
  assert.equal(C.safeColor('url(javascript:alert(1))'), null);
});

test('markDeleted handles single and bulk ids', () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-10-26': H }), task('b', { '2026-10-26': H })]);
  assert.equal(C.markDeleted(log, ['a', 'b', 'nope']), true);
  assert.equal(C.markDeleted(log, ['a']), false);
});

// ---------- rows and totals ----------

const DAY = '2026-10-26';

const logWithSubtasks = () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [
    task('parent', { [DAY]: 3 * H }, { subTaskIds: ['s1', 's2'], projectId: 'p1', tagIds: ['t-parent'] }),
    task('s1', { [DAY]: 2 * H }, { parentId: 'parent', projectId: 'p1', tagIds: ['t-sub'] }),
    task('s2', { [DAY]: 1 * H }, { parentId: 'parent', projectId: 'p1' }),
    task('solo', { [DAY]: 30 * M }, { projectId: 'p2' }),
  ]);
  return log;
};

test('subtask time is not counted twice', () => {
  const rows = C.rowsForDay(logWithSubtasks(), DAY);
  assert.deepEqual(rows.map((r) => r.id), ['parent', 'solo']);
  assert.equal(C.sumCounted(rows), 3.5 * H);
  assert.deepEqual(rows[0].children.map((c) => c.id), ['s1', 's2']);
});

test('a subtask whose parent has no time that day counts on its own', () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [
    task('parent', { '2026-10-27': H }, { subTaskIds: ['s1'] }),
    task('s1', { [DAY]: H }, { parentId: 'parent' }),
  ]);
  const rows = C.rowsForDay(log, DAY);
  assert.deepEqual(rows.map((r) => r.id), ['s1']);
  assert.equal(C.sumCounted(rows), H);
});

test('project filter, including "no project"', () => {
  const log = logWithSubtasks();
  C.addManualEntry(log, { title: 'Loose', date: DAY, ms: M * 10 }, () => 'manual-1');
  assert.deepEqual(C.rowsForDay(log, DAY, { projectId: 'p2' }).map((r) => r.id), ['solo']);
  assert.deepEqual(C.rowsForDay(log, DAY, { projectId: C.NO_PROJECT }).map((r) => r.id), ['manual-1']);
});

test('tag filter can match through subtasks and then counts only those', () => {
  const log = logWithSubtasks();
  const viaParent = C.rowsForDay(log, DAY, { tagId: 't-parent' });
  assert.equal(C.sumCounted(viaParent), 3 * H);
  const viaChild = C.rowsForDay(log, DAY, { tagId: 't-sub' });
  assert.equal(viaChild.length, 1);
  assert.equal(viaChild[0].partial, true);
  assert.equal(C.sumCounted(viaChild), 2 * H);
  assert.deepEqual(viaChild[0].children.map((c) => c.id), ['s1']);
});

// ---------- manual and deleted entries ----------

test('manual entries: add, move to another date, delete', () => {
  const log = C.emptyLog();
  const id = C.addManualEntry(log, { title: ' Client call ', date: DAY, ms: H }, () => 'manual-1');
  assert.equal(log.entries[id].title, 'Client call');

  assert.equal(C.updateEntry(log, id, { fromDate: DAY, toDate: '2026-10-27', ms: 2 * H, title: 'Call' }), true);
  assert.deepEqual(log.entries[id].byDate, { '2026-10-27': 2 * H }, 'the old date is not left behind');
  assert.equal(log.entries[id].title, 'Call');

  assert.equal(C.removeEntryDay(log, id, '2026-10-27'), true);
  assert.equal(log.entries[id], undefined);
});

test('invalid manual entries are refused', () => {
  const log = C.emptyLog();
  const make = () => 'm';
  assert.equal(C.addManualEntry(log, { title: '', date: DAY, ms: H }, make), null);
  assert.equal(C.addManualEntry(log, { title: 'x', date: 'nope', ms: H }, make), null);
  assert.equal(C.addManualEntry(log, { title: 'x', date: DAY, ms: 0 }, make), null);
  assert.equal(C.addManualEntry(log, { title: 'x', date: DAY, ms: 25 * H }, make), null);
});

test('live entries are read-only; deleted ones keep their title', () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { [DAY]: H })]);
  assert.equal(C.isEditable(log.entries.a), false);
  assert.equal(C.updateEntry(log, 'a', { fromDate: DAY, toDate: DAY, ms: 2 * H }), false);
  assert.equal(C.removeEntryDay(log, 'a', DAY), false);

  C.markDeleted(log, ['a']);
  assert.equal(C.updateEntry(log, 'a', { fromDate: DAY, toDate: DAY, ms: 2 * H, title: 'Renamed' }), true);
  assert.equal(log.entries.a.title, 'a');
  assert.equal(log.entries.a.byDate[DAY], 2 * H);
});

// ---------- CSV ----------

test('CSV has one line per counted row and neutralizes formulas', () => {
  const log = logWithSubtasks();
  C.addManualEntry(log, { title: '=HYPERLINK("x")', date: DAY, ms: 15 * M }, () => 'manual-1');
  const csv = C.buildCsv(log, [DAY], { projectId: 'all', tagId: 'all' });
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 4); // header + parent + solo + manual
  assert.equal(lines[0], '"Date","Task","Project","Tags","Hours","Duration","Source"');
  assert.ok(lines.some((l) => l.includes('"\'=HYPERLINK(""x"")"')));
  assert.ok(lines.some((l) => l.startsWith('"2026-10-26","parent"') && l.includes('"3.00","3:00"')));
});

test('CSV lists matching subtasks when a tag matched only through them', () => {
  const csv = C.buildCsv(logWithSubtasks(), [DAY], { projectId: 'all', tagId: 't-sub' });
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"parent › s1"'));
  assert.ok(lines[1].includes('"2.00"'));
});

// ---------- stored format ----------

test('encode/decode round-trips and is stable', () => {
  const log = logWithSubtasks();
  C.mergeLiveTasks(log, [task('old', { '2026-09-30': H, '2026-10-01': H })]);
  C.addManualEntry(log, { title: 'Manual', date: '2026-08-15', ms: H }, () => 'manual-1');
  const settings = C.coerceSettings({ weekStartsOn: 0 });

  const data = C.encodeState(settings, log);
  assert.deepEqual(Object.keys(data), ['log-2026-08', 'log-2026-09', 'log-2026-10', 'settings']);

  const decoded = C.decodeState(data);
  assert.deepEqual(decoded.settings, settings);
  assert.equal(JSON.stringify(decoded.log.entries.old.byDate), JSON.stringify({ '2026-09-30': H, '2026-10-01': H }));
  assert.deepEqual(C.encodeState(decoded.settings, decoded.log), data, 'decode → encode reproduces the same strings');
});

test('the newest month wins for task details', () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-09-30': H, '2026-10-01': H })]);
  const data = C.encodeState(C.coerceSettings(), log);
  const oct = JSON.parse(data['log-2026-10']);
  oct.entries.a.title = 'Renamed';
  data['log-2026-10'] = JSON.stringify(oct);
  assert.equal(C.decodeState(data).log.entries.a.title, 'Renamed');
});

test('a month key cannot inject days from other months', () => {
  const data = {
    'log-2026-10': JSON.stringify({ v: 2, entries: { a: { title: 'a', byDate: { '2026-10-01': H, '2025-01-01': 99 * H } } } }),
  };
  assert.deepEqual(C.decodeState(data).log.entries.a.byDate, { '2026-10-01': H });
});

test('1.x data migrates: settings kept, auto-delete dropped, tags paired up', () => {
  const v1 = {
    v: 1,
    settings: { weekStartsOn: 0, dailyTargetHours: [0, 7, 7, 7, 7, 7, 0], autoDelete: { enabled: true, atTime: '00:00' } },
    log: {
      entries: {
        t1: { title: 'Task', projectId: 'p', projectTitle: 'P', projectColor: '#abc', tagIds: ['x', 'y'], tagTitles: ['X', 'Y'], byDate: { [DAY]: H }, isDeleted: true, lastSeen: 1 },
        'manual-1': { title: 'M', projectId: null, tagIds: [], tagTitles: [], byDate: { [DAY]: H }, isManual: true },
        empty: { title: 'E', byDate: {} },
      },
    },
    autoDeleteState: { lastRunDate: '2026-10-01' },
  };
  const { settings, log } = C.decodeState(C.blobToData(v1));
  assert.equal(settings.weekStartsOn, 0);
  assert.deepEqual(settings.dailyTargetHours, [0, 7, 7, 7, 7, 7, 0]);
  assert.equal('autoDelete' in settings, false);
  assert.deepEqual(Object.keys(log.entries).sort(), ['manual-1', 't1']);
  assert.deepEqual(log.entries.t1.tags, [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }]);
  assert.equal(log.entries.t1.isDeleted, true);
  assert.equal(log.entries['manual-1'].isManual, true);
});

test('corrupt or unknown stored data falls back to defaults', () => {
  const { settings, log } = C.decodeState({ settings: '{nope', 'log-2026-10': '[]', other: 'x' });
  assert.deepEqual(settings, C.coerceSettings());
  assert.deepEqual(log, C.emptyLog());
  assert.deepEqual(C.blobToData({ v: 99 }), {});
  assert.deepEqual(C.blobToData(null), {});
});
