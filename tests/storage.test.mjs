import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './load-core.mjs';

const C = loadCore();
const H = C.HOUR_MS;

// Fake host storage. keyed: true behaves like current Super Productivity;
// keyed: false like older hosts, which only have the unkeyed blob and ignore
// the key argument entirely.
const fakeApi = ({ keyed, blob = null, keys = {} } = {}) => {
  const store = { blob, keys: { ...keys } };
  const writes = [];
  const api = {
    store,
    writes,
    async persistDataSynced(data, key) {
      writes.push(keyed ? key || '' : '');
      if (keyed && key) store.keys[key] = data;
      else store.blob = data;
    },
    async loadSyncedData(key) {
      return keyed && key ? store.keys[key] ?? null : store.blob;
    },
  };
  if (keyed) {
    api.listSyncedDataKeys = async () => Object.keys(store.keys).filter((k) => store.keys[k]).sort();
  }
  return api;
};

const sampleLog = () => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, [
    { id: 'a', title: 'A', tagIds: [], timeSpentOnDay: { '2026-09-30': H, '2026-10-26': H } },
  ]);
  return log;
};

test('keyed: writes one key per month and nothing when unchanged', async () => {
  const api = fakeApi({ keyed: true });
  const store = C.createStore(api);
  assert.equal(store.keyed, true);
  await store.load();

  const data = C.encodeState(C.coerceSettings(), sampleLog());
  assert.equal(await store.save(data), 3);
  assert.deepEqual(Object.keys(api.store.keys).sort(), ['log-2026-09', 'log-2026-10', 'settings']);
  assert.equal(api.store.blob, null, 'the unkeyed blob is not touched');

  assert.equal(await store.save(data), 0, 'same data → no writes');
});

test('keyed: a running timer only rewrites the current month', async () => {
  const api = fakeApi({ keyed: true });
  const store = C.createStore(api);
  await store.load();
  const log = sampleLog();
  await store.save(C.encodeState(C.coerceSettings(), log));
  api.writes.length = 0;

  C.mergeLiveTasks(log, [{ id: 'a', title: 'A', tagIds: [], timeSpentOnDay: { '2026-09-30': H, '2026-10-26': 2 * H } }]);
  await store.save(C.encodeState(C.coerceSettings(), log));
  assert.deepEqual(api.writes, ['log-2026-10']);
});

test('keyed: reloading its own data and saving it back writes nothing', async () => {
  const api = fakeApi({ keyed: true });
  const first = C.createStore(api);
  await first.load();
  await first.save(C.encodeState(C.coerceSettings({ weekStartsOn: 0 }), sampleLog()));
  api.writes.length = 0;

  // What the PERSISTED_DATA_CHANGED handler does after our own write.
  const data = await first.load();
  const { settings, log } = C.decodeState(data);
  assert.equal(await first.save(C.encodeState(settings, log)), 0);
  assert.deepEqual(api.writes, []);
});

test('keyed: a month that empties out is removed', async () => {
  const api = fakeApi({ keyed: true });
  const store = C.createStore(api);
  await store.load();
  const log = C.emptyLog();
  const id = C.addManualEntry(log, { title: 'M', date: '2026-08-01', ms: H }, () => 'manual-1');
  await store.save(C.encodeState(C.coerceSettings(), log));
  assert.ok(api.store.keys['log-2026-08']);

  C.removeEntryDay(log, id, '2026-08-01');
  await store.save(C.encodeState(C.coerceSettings(), log));
  assert.equal(api.store.keys['log-2026-08'], '');
  assert.deepEqual(await api.listSyncedDataKeys(), ['settings']);
});

test('keyed: migrates 1.x data from the unkeyed blob and keeps the blob', async () => {
  const v1 = JSON.stringify({
    v: 1,
    settings: { weekStartsOn: 0, dailyTargetHours: [0, 6, 6, 6, 6, 6, 0] },
    log: { entries: { t: { title: 'Old', tagIds: [], tagTitles: [], byDate: { '2026-10-01': H }, isDeleted: true } } },
  });
  const api = fakeApi({ keyed: true, blob: v1 });
  const store = C.createStore(api);
  const { settings, log } = C.decodeState(await store.load());
  assert.equal(settings.weekStartsOn, 0);
  assert.equal(log.entries.t.isDeleted, true);

  await store.save(C.encodeState(settings, log));
  assert.ok(api.store.keys.settings && api.store.keys['log-2026-10']);
  assert.equal(api.store.blob, v1, 'the 1.x blob stays as a backup');

  // Second start: keyed data exists, so the blob is not read again.
  const again = C.createStore(api);
  const data = await again.load();
  assert.equal(await again.save(data), 0);
});

test('blob: keys live inside the single entry and survive a reload', async () => {
  const api = fakeApi({ keyed: false });
  const store = C.createStore(api);
  assert.equal(store.keyed, false);
  await store.load();
  const data = C.encodeState(C.coerceSettings({ timeFormat: 'decimal' }), sampleLog());
  assert.equal(await store.save(data), 3);
  assert.equal(api.writes.length, 1, 'one blob write per save');
  assert.equal(JSON.parse(api.store.blob).v, 2);

  const reloaded = C.createStore(api);
  const back = await reloaded.load();
  assert.deepEqual(back, data);
  assert.equal(await reloaded.save(back), 0);
  assert.equal(C.decodeState(back).settings.timeFormat, 'decimal');
});

test('blob: 1.x data is upgraded in place on first save', async () => {
  const v1 = JSON.stringify({ v: 1, settings: { weekStartsOn: 0 }, log: { entries: { t: { title: 'T', byDate: { '2026-10-01': H } } } } });
  const api = fakeApi({ keyed: false, blob: v1 });
  const store = C.createStore(api);
  const data = await store.load();
  assert.ok(await store.save(data) > 0);
  const stored = JSON.parse(api.store.blob);
  assert.equal(stored.v, 2);
  assert.equal(C.decodeState(stored.keys).log.entries.t.byDate['2026-10-01'], H);
});

test('save is refused until a load has succeeded', async () => {
  const api = fakeApi({ keyed: true, keys: { 'log-2026-10': JSON.stringify({ v: 2, entries: { m: { title: 'kept', isManual: true, byDate: { '2026-10-01': H } } } }) } });
  const realList = api.listSyncedDataKeys;
  api.listSyncedDataKeys = async () => { throw new Error('API call timeout'); };
  const store = C.createStore(api);
  await assert.rejects(store.load(), /timeout/);
  await assert.rejects(store.save(C.encodeState(C.coerceSettings(), C.emptyLog())), /before a successful load/);
  assert.ok(api.store.keys['log-2026-10'].includes('kept'), 'saved history untouched');

  api.listSyncedDataKeys = realList;
  const { log } = C.decodeState(await store.load());
  assert.equal(log.entries.m.title, 'kept');
});

test('a failed write is retried by the next save', async () => {
  const api = fakeApi({ keyed: true });
  const store = C.createStore(api);
  await store.load();
  const real = api.persistDataSynced;
  api.persistDataSynced = async () => { throw new Error('offline'); };
  const data = C.encodeState(C.coerceSettings(), sampleLog());
  await assert.rejects(store.save(data), /offline/);
  api.persistDataSynced = real;
  assert.equal(await store.save(data), 3);
});

test('loads and saves run one at a time', async () => {
  const api = fakeApi({ keyed: true });
  const order = [];
  const realPersist = api.persistDataSynced;
  api.persistDataSynced = async (...args) => {
    order.push('write-start');
    await new Promise((r) => setTimeout(r, 5));
    await realPersist(...args);
    order.push('write-end');
  };
  const realList = api.listSyncedDataKeys;
  api.listSyncedDataKeys = async () => {
    order.push('load');
    return realList();
  };
  const store = C.createStore(api);
  await store.load();
  order.length = 0;
  const saving = store.save({ settings: '{"v":2}' });
  const loading = store.load();
  await Promise.all([saving, loading]);
  assert.deepEqual(order, ['write-start', 'write-end', 'load']);
});
