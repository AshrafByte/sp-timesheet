// Guards against losing saved data: model changes in Super Productivity,
// host glitches, other devices, newer versions of this plugin, size limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './load-core.mjs';

const C = loadCore();
const H = C.HOUR_MS;

const task = (id, timeSpentOnDay, extra = {}) => ({ id, title: id, tagIds: [], timeSpentOnDay, ...extra });
const settings = () => C.coerceSettings();
const shard = (entries) => JSON.stringify({ v: 2, entries });
const entry = (title, byDate, extra = {}) => ({
  title, projectId: null, projectTitle: null, projectColor: null, tags: [], parentId: null,
  isManual: false, isDeleted: false, byDate, ...extra,
});

// Fake host storage, as in storage.test.mjs, plus a hook to simulate another
// device writing between our load and our save.
const fakeApi = ({ keyed = true, blob = null, keys = {} } = {}) => {
  const store = { blob, keys: { ...keys } };
  const api = {
    store,
    writes: [],
    async persistDataSynced(data, key) {
      api.writes.push(keyed ? key || '' : '');
      if (keyed && key) store.keys[key] = data;
      else store.blob = data;
    },
    async loadSyncedData(key) {
      return keyed && key ? store.keys[key] ?? null : store.blob;
    },
  };
  if (keyed) api.listSyncedDataKeys = async () => Object.keys(store.keys).filter((k) => store.keys[k]).sort();
  return api;
};

// ---------- Super Productivity data ----------

test('a task without a timeSpentOnDay object keeps its logged hours', () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-10-01': H })]);
  for (const odd of [undefined, null, 'x', [1, 2]]) {
    const { changed } = C.mergeLiveTasks(log, [task('a', odd)], { complete: true });
    assert.equal(changed, false);
    assert.deepEqual(log.entries.a.byDate, { '2026-10-01': H });
    assert.equal(log.entries.a.isDeleted, false);
  }
});

test('a mass disappearance is held until confirmed; a small one is flagged at once', () => {
  const tasks = Array.from({ length: 40 }, (_, i) => task(`t${i}`, { '2026-10-01': H }));
  const log = C.emptyLog();
  C.mergeLiveTasks(log, tasks);

  // The archive "loads" empty: 30 of 40 tasks missing.
  const glitch = C.mergeLiveTasks(log, tasks.slice(0, 10), { complete: true });
  assert.equal(glitch.held.length, 30);
  assert.equal(Object.values(log.entries).filter((e) => e.isDeleted).length, 0);

  const confirmed = C.mergeLiveTasks(log, tasks.slice(0, 10), { complete: true, allowMassDelete: true });
  assert.deepEqual(confirmed.held, []);
  assert.equal(Object.values(log.entries).filter((e) => e.isDeleted).length, 30);

  const small = C.emptyLog();
  C.mergeLiveTasks(small, tasks);
  C.mergeLiveTasks(small, tasks.slice(0, 38), { complete: true });
  assert.equal(Object.values(small.entries).filter((e) => e.isDeleted).length, 2);
});

// ---------- Other devices ----------

test('mergeStoredValue keeps changes from both sides', () => {
  const base = shard({ a: entry('a', { '2026-10-01': H }), m: entry('m', { '2026-10-02': H }, { isManual: true }) });
  // This device: changed a, removed m. Other device: added r.
  const ours = shard({ a: entry('a', { '2026-10-01': 2 * H }) });
  const theirs = shard({
    a: entry('a', { '2026-10-01': H }),
    m: entry('m', { '2026-10-02': H }, { isManual: true }),
    r: entry('r', { '2026-10-03': H }, { isManual: true }),
  });
  const merged = JSON.parse(C.mergeStoredValue('log-2026-10', base, ours, theirs)).entries;
  assert.equal(merged.a.byDate['2026-10-01'], 2 * H, 'our change');
  assert.equal(merged.m, undefined, 'our removal');
  assert.ok(merged.r, 'their addition');
});

test('mergeStoredValue never drops what it never saw', () => {
  // A device that never read this month (fresh install, or sync was late)
  // writes its live-only view; the other device's manual entry survives.
  const theirs = shard({ m: entry('m', { '2026-10-02': H }, { isManual: true }), a: entry('a', { '2026-10-01': H }) });
  const ours = shard({ a: entry('a', { '2026-10-01': H }) });
  const merged = JSON.parse(C.mergeStoredValue('log-2026-10', '', ours, theirs)).entries;
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'm']);
});

test('mergeStoredValue: an entry the other side changed while we removed it is kept', () => {
  const base = shard({ m: entry('m', { '2026-10-02': H }, { isManual: true }) });
  const theirs = shard({ m: entry('m', { '2026-10-02': 3 * H }, { isManual: true }) });
  const merged = JSON.parse(C.mergeStoredValue('log-2026-10', base, shard({}), theirs)).entries;
  assert.equal(merged.m.byDate['2026-10-02'], 3 * H);
});

test('store: another device writing between load and save is merged, not overwritten', async () => {
  const api = fakeApi();
  const store = C.createStore(api);
  await store.load();
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-10-01': H })]);
  await store.save(C.encodeState(settings(), log));

  // Another device adds a manual entry to the same month.
  const remote = JSON.parse(api.store.keys['log-2026-10']);
  remote.entries.m = entry('From laptop', { '2026-10-05': H }, { isManual: true });
  api.store.keys['log-2026-10'] = JSON.stringify(remote);

  // This device saves its own change to that month without having seen it.
  C.mergeLiveTasks(log, [task('a', { '2026-10-01': 2 * H })]);
  await store.save(C.encodeState(settings(), log));
  const saved = JSON.parse(api.store.keys['log-2026-10']).entries;
  assert.equal(saved.a.byDate['2026-10-01'], 2 * H);
  assert.equal(saved.m.title, 'From laptop');
  assert.equal(store.mergedSinceLoad, true, 'the caller is told to reload');
});

test('store: a first run merges with data that arrived without being listed', async () => {
  const api = fakeApi();
  const store = C.createStore(api);
  await store.load(); // empty: first run
  api.store.keys['log-2026-10'] = shard({ m: entry('m', { '2026-10-02': H }, { isManual: true }) });
  api.store.keys.settings = JSON.stringify({ v: 2, ...C.coerceSettings({ weekStartsOn: 0 }) });

  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-10-01': H })]);
  await store.save(C.encodeState(settings(), log));
  assert.ok(JSON.parse(api.store.keys['log-2026-10']).entries.m, 'the unseen manual entry is kept');
  assert.equal(JSON.parse(api.store.keys.settings).weekStartsOn, 0, 'unchanged default settings do not overwrite theirs');
});

test('store: an empty key listing while settings exist fails the load', async () => {
  const api = fakeApi({ keys: { settings: JSON.stringify({ v: 2 }), 'log-2026-10': shard({}) } });
  api.listSyncedDataKeys = async () => [];
  const store = C.createStore(api);
  await assert.rejects(store.load(), /listing came back empty/);
  await assert.rejects(store.save({ settings: '{}' }), /before a successful load/);
});

// ---------- Newer versions of this plugin ----------

test('keys from a newer version are reported and never overwritten', async () => {
  const future = JSON.stringify({ v: 3, entries: { x: { whatever: true } } });
  const api = fakeApi({ keys: { 'log-2026-10': future, settings: JSON.stringify({ v: 3, weekStartsOn: 'x' }) } });
  const store = C.createStore(api);
  const data = await store.load();
  const { unreadable, log } = C.decodeState(data);
  assert.deepEqual(unreadable.sort(), ['log-2026-10', 'settings']);
  assert.deepEqual(log.entries, {});
  store.protect(unreadable);

  const mine = C.emptyLog();
  C.mergeLiveTasks(mine, [task('a', { '2026-10-01': H, '2026-11-01': H })]);
  await store.save(C.encodeState(settings(), mine));
  assert.equal(api.store.keys['log-2026-10'], future, 'newer month untouched');
  assert.equal(JSON.parse(api.store.keys.settings).v, 3, 'newer settings untouched');
  assert.ok(api.store.keys['log-2026-11'], 'other months still saved');
});

test('a blob this version cannot read makes the store read-only', async () => {
  for (const blob of [JSON.stringify({ v: 9, keys: {} }), '{not json', JSON.stringify([1, 2])]) {
    const api = fakeApi({ keyed: false, blob });
    const store = C.createStore(api);
    await store.load();
    assert.equal(store.readOnly, true);
    assert.equal(await store.save(C.encodeState(settings(), C.emptyLog())), 0);
    assert.equal(api.store.blob, blob);
  }
});

test('blob: another device writing between load and save is merged', async () => {
  const api = fakeApi({ keyed: false });
  const store = C.createStore(api);
  await store.load();
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-10-01': H })]);
  await store.save(C.encodeState(settings(), log));

  const blob = JSON.parse(api.store.blob);
  blob.keys['log-2026-09'] = shard({ m: entry('m', { '2026-09-02': H }, { isManual: true }) });
  api.store.blob = JSON.stringify(blob);

  C.mergeLiveTasks(log, [task('a', { '2026-10-01': 2 * H })]);
  await store.save(C.encodeState(settings(), log));
  const keys = JSON.parse(api.store.blob).keys;
  assert.ok(keys['log-2026-09'], 'their month kept');
  assert.equal(JSON.parse(keys['log-2026-10']).entries.a.byDate['2026-10-01'], 2 * H);
});

// ---------- Size limits ----------

test('a month too big for one write is split across keys and reads back whole', () => {
  const log = C.emptyLog();
  const tasks = Array.from({ length: 1500 }, (_, i) => task(`task-${String(i).padStart(4, '0')}`, { '2026-10-01': H, '2026-10-02': H }, { title: `A fairly long task title number ${i} for size` }));
  C.mergeLiveTasks(log, tasks);
  const data = C.encodeState(settings(), log);
  const monthKeys = Object.keys(data).filter((k) => k.startsWith('log-2026-10'));
  assert.ok(monthKeys.length > 1, `split into ${monthKeys.length} keys`);
  for (const key of monthKeys) assert.ok(data[key].length <= 180 * 1024, `${key} is ${data[key].length} chars`);
  const back = C.decodeState(data).log;
  assert.equal(Object.keys(back.entries).length, 1500);
  assert.deepEqual(C.encodeState(settings(), back), data, 'stable round trip');
});

// ---------- Backup ----------

test('backup round-trips and restore only adds', () => {
  const log = C.emptyLog();
  C.addManualEntry(log, { title: 'Call', date: '2026-10-01', ms: H }, () => 'manual-1');
  C.mergeLiveTasks(log, [task('a', { '2026-10-01': H })]);
  C.markDeleted(log, ['a']);
  const text = C.buildBackup(C.coerceSettings({ weekStartsOn: 6 }), log, new Date('2026-10-28T10:00:00Z'));
  const restored = C.parseBackup(text);
  assert.equal(restored.settings.weekStartsOn, 6);
  assert.equal(restored.hasSettings, true);
  assert.equal(restored.exportedAt, '2026-10-28T10:00:00.000Z');

  const current = C.emptyLog();
  C.mergeLiveTasks(current, [task('a', { '2026-10-02': 2 * H })]);
  const added = C.mergeLogs(current, restored.log);
  assert.deepEqual(added, { entries: 1, days: 1 });
  assert.equal(current.entries['manual-1'].title, 'Call');
  assert.deepEqual(current.entries.a.byDate, { '2026-10-01': H, '2026-10-02': 2 * H }, 'existing day kept, missing day added');
  assert.equal(current.entries.a.isDeleted, false, 'existing entry not changed');
});

test('parseBackup rejects other files with a readable message', () => {
  assert.throws(() => C.parseBackup('{"hello":1}'), /not a Timesheet backup/);
  assert.throws(() => C.parseBackup('not json'), /not a Timesheet backup/);
  assert.throws(() => C.parseBackup(JSON.stringify({ app: 'sp-timesheet', schema: 3, data: {} })), /newer version/);
});

// ---------- Settings ----------

test('week start: any weekday, or follow Super Productivity', () => {
  assert.equal(C.coerceSettings({ weekStartsOn: 3 }).weekStartsOn, 3);
  assert.equal(C.coerceSettings({ weekStartsOn: 'app' }).weekStartsOn, 'app');
  assert.equal(C.coerceSettings({}).weekStartsOn, 'app');
  assert.equal(C.resolveWeekStart('app', 0), 0);
  assert.equal(C.resolveWeekStart('app', 6), 6);
  assert.equal(C.resolveWeekStart('app', null), 1);
  assert.equal(C.resolveWeekStart('app', 9), 1);
  assert.equal(C.resolveWeekStart(5, 0), 5);
});

test('default view: last used, or always one view', () => {
  assert.equal(C.coerceSettings({}).defaultView, 'last');
  assert.equal(C.coerceSettings({ defaultView: 'chart' }).defaultView, 'chart');
  assert.equal(C.coerceSettings({ defaultView: 'pie' }).defaultView, 'last');
});

// ---------- Regressions from review ----------

test('a save queued behind a reload still merges with what the reload brought in', async () => {
  const api = fakeApi();
  const store = C.createStore(api);
  await store.load();
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-10-01': H })]);
  await store.save(C.encodeState(settings(), log));

  // Another device adds an entry; a reload is in flight when this device's save is asked for.
  const remote = JSON.parse(api.store.keys['log-2026-10']);
  remote.entries.b = entry('From laptop', { '2026-10-05': H }, { isManual: true });
  api.store.keys['log-2026-10'] = JSON.stringify(remote);
  const reload = store.load();
  C.mergeLiveTasks(log, [task('a', { '2026-10-01': 2 * H })]);
  const saving = store.save(C.encodeState(settings(), log)); // built before the reload landed
  await Promise.all([reload, saving]);
  const saved = JSON.parse(api.store.keys['log-2026-10']).entries;
  assert.ok(saved.b, "the other device's entry survives");
  assert.equal(saved.a.byDate['2026-10-01'], 2 * H);
});

test('mergeStoredValue: a removal on the other device sticks', () => {
  const m = entry('m', { '2026-10-02': H }, { isManual: true });
  const a = entry('a', { '2026-10-01': H });
  const base = shard({ a, m });
  const ours = shard({ a: entry('a', { '2026-10-01': 2 * H }), m }); // we changed a, left m alone
  const theirs = shard({ a }); // they deleted m
  const merged = JSON.parse(C.mergeStoredValue('log-2026-10', base, ours, theirs)).entries;
  assert.equal(merged.m, undefined);
  assert.equal(merged.a.byDate['2026-10-01'], 2 * H);
});

test('mergeStoredValue merges settings field by field', () => {
  const s = (o) => JSON.stringify({ v: 2, ...C.coerceSettings(o) });
  const base = s({ timeFormat: 'hm', weekStartsOn: 1 });
  const ours = s({ timeFormat: 'decimal', weekStartsOn: 1 });
  const theirs = s({ timeFormat: 'hm', weekStartsOn: 0 });
  const merged = JSON.parse(C.mergeStoredValue('settings', base, ours, theirs));
  assert.equal(merged.timeFormat, 'decimal');
  assert.equal(merged.weekStartsOn, 0);
});

test('a newer version writing while this device runs is protected, not merged into', async () => {
  const api = fakeApi();
  const store = C.createStore(api);
  await store.load();
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [task('a', { '2026-09-01': H })]);
  await store.save(C.encodeState(settings(), log));

  const future = JSON.stringify({ v: 3, entries: { x: { new: 'format' } } });
  api.store.keys['log-2026-09'] = future;
  C.mergeLiveTasks(log, [task('a', { '2026-09-01': 2 * H })]);
  await store.save(C.encodeState(settings(), log));
  assert.equal(api.store.keys['log-2026-09'], future);
  assert.ok(store.protectedKeys.includes('log-2026-09'));
});

test('the view used last is not synced', () => {
  const data = C.encodeState(C.coerceSettings({ view: 'chart', defaultView: 'sheet' }), C.emptyLog());
  const stored = JSON.parse(data.settings);
  assert.equal('view' in stored, false);
  assert.equal(stored.defaultView, 'sheet');
});

test('a deleted subtask keeps counting after the parent is recomputed', () => {
  const D = '2026-10-01';
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [
    task('p', { [D]: 3 * H }, { subTaskIds: ['s1', 's2'] }),
    task('s1', { [D]: H }, { parentId: 'p' }),
    task('s2', { [D]: 2 * H }, { parentId: 'p' }),
  ]);
  // s2 deleted; SP recomputes p from s1 alone.
  C.mergeLiveTasks(log, [task('p', { [D]: H }, { subTaskIds: ['s1'] }), task('s1', { [D]: H }, { parentId: 'p' })], { complete: true });
  const rows = C.rowsForDay(log, D);
  assert.equal(C.sumCounted(rows), 3 * H);
  assert.ok(C.buildCsv(log, [D], { projectId: 'all', tagId: 'all' }).includes('"3.00"'));
});

test('moving an entry onto a day it already has adds the times', () => {
  const log = C.emptyLog();
  const id = C.addManualEntry(log, { title: 'M', date: '2026-10-01', ms: H }, () => 'manual-1');
  C.updateEntry(log, id, { fromDate: '2026-10-01', toDate: '2026-10-01', ms: 2 * H });
  assert.deepEqual(log.entries[id].byDate, { '2026-10-01': 2 * H }, 'same day: replaced');
  log.entries[id].byDate['2026-10-02'] = H;
  C.updateEntry(log, id, { fromDate: '2026-10-01', toDate: '2026-10-02', ms: 2 * H });
  assert.deepEqual(log.entries[id].byDate, { '2026-10-02': 3 * H }, 'moved: added');
});

test('hourScale keeps to its tick budget for huge values', () => {
  for (const hours of [7000, 1e6, Infinity, NaN, -5]) {
    const scale = C.hourScale(hours * H);
    assert.ok(scale.ticks.length <= 5, `${hours}h gave ${scale.ticks.length} ticks`);
  }
});

test("Super Productivity's start of the next day", () => {
  assert.equal(C.dayStartOffset({ startOfNextDayTime: '04:30' }), 270);
  assert.equal(C.dayStartOffset({ startOfNextDay: 3 }), 180);
  assert.equal(C.dayStartOffset({ startOfNextDayTime: '00:00', startOfNextDay: 0 }), 0);
  assert.equal(C.dayStartOffset(undefined), 0);
  assert.equal(C.dayStartOffset({ startOfNextDayTime: 'nope', startOfNextDay: 40 }), 0);
  // 02:00 with a 04:00 boundary still belongs to the day before.
  const twoAm = new Date(2026, 9, 28, 2, 0);
  assert.equal(C.toDateStr(C.shiftedNow(240, twoAm)), '2026-10-27');
  assert.equal(C.toDateStr(C.shiftedNow(0, twoAm)), '2026-10-28');
});
