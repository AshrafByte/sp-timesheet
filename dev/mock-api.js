/*
 * Development stand-in for the PluginAPI that Super Productivity injects into
 * plugin iframes. Only dist/dev.html includes it. Query options:
 *   ?theme=light   light theme variables (default dark)
 *   ?host=old      a host without keyed storage (single blob)
 *   ?seed=v1       start from 1.x saved data
 *   ?reset=1       forget the mock's saved data
 *   ?timer=0       no running timer
 *   ?firstDay=0..6 Super Productivity's first day of week (default: System default)
 *   ?dayStart=HH:MM when Super Productivity starts a new day (default 00:00)
 * window.__mock exposes helpers for poking at it from the console.
 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const keyed = params.get('host') !== 'old';
  const STORAGE_KEY = `sp-timesheet-mock:${keyed ? 'keyed' : 'blob'}`;
  const H = 3600000;
  const M = 60000;

  // ---------- Theme ----------
  const themes = {
    dark: {
      '--bg': '#131418', '--bg-darker': 'rgba(255,255,255,0.05)', '--card-bg': '#1d1f25',
      '--text-color': '#e8e8ea', '--text-color-muted': '#9a9ba3', '--divider-color': 'rgba(255,255,255,0.1)',
      '--c-primary': '#6495ed', '--c-warn': '#ef5350',
    },
    light: {
      '--bg': '#f5f6f8', '--bg-darker': 'rgba(0,0,0,0.04)', '--card-bg': '#ffffff',
      '--text-color': '#1f2329', '--text-color-muted': '#6b7280', '--divider-color': 'rgba(0,0,0,0.1)',
      '--c-primary': '#3f6fd8', '--c-warn': '#d32f2f',
    },
  };
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  for (const [k, v] of Object.entries(themes[theme])) document.documentElement.style.setProperty(k, v);

  // ---------- Sample data ----------
  const dayStr = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const days = (pairs) => Object.fromEntries(pairs.map(([offset, ms]) => [dayStr(offset), ms]));

  const projects = [
    { id: 'p-client', title: 'Client Portal', theme: { primary: '#e91e63' } },
    { id: 'p-internal', title: 'Internal', theme: { primary: '#43a047' } },
    { id: 'p-learning', title: 'Learning', theme: { primary: '#fb8c00' } },
    { id: 'p-ops', title: 'Operations', theme: { primary: '#8e24aa' } },
    { id: 'p-design', title: 'Design System', theme: { primary: '#00897b' } },
  ];
  const tags = [
    { id: 'TODAY', title: 'Today' },
    { id: 't-urgent', title: 'Urgent' },
    { id: 't-meeting', title: 'Meeting' },
    { id: 't-deep', title: 'Deep work' },
  ];
  const task = (id, title, timeSpentOnDay, extra = {}) => ({
    id, title, projectId: null, tagIds: [], subTaskIds: [], parentId: null, isDone: false, timeSpentOnDay, ...extra,
  });

  const subTests = task('sub-tests', 'Write integration tests', days([[0, 50 * M], [-1, 2 * H], [-3, 90 * M], [-8, H]]), { parentId: 'billing', projectId: 'p-client', tagIds: ['t-deep'] });
  const subDocs = task('sub-docs', 'Update API docs', days([[0, 25 * M], [-2, 45 * M], [-8, 30 * M]]), { parentId: 'billing', projectId: 'p-client' });
  const sumDays = (...subs) => {
    const out = {};
    for (const s of subs) for (const [d, ms] of Object.entries(s.timeSpentOnDay)) out[d] = (out[d] || 0) + ms;
    return out;
  };

  let active = [
    task('billing', 'Refactor billing API', sumDays(subTests, subDocs), { projectId: 'p-client', tagIds: ['t-urgent'], subTaskIds: ['sub-tests', 'sub-docs'] }),
    subTests,
    subDocs,
    task('standup', 'Daily standup', days([[0, 15 * M], [-1, 15 * M], [-2, 20 * M], [-3, 15 * M], [-4, 15 * M], [-7, 15 * M], [-8, 15 * M]]), { projectId: 'p-internal', tagIds: ['t-meeting'] }),
    task('report', 'Write weekly report', days([[0, 40 * M]]), { projectId: 'p-internal', tagIds: ['TODAY', 't-urgent'] }),
    task('course', 'Angular signals course', days([[-1, 75 * M], [-4, 2 * H], [-9, H]]), { projectId: 'p-learning', tagIds: ['t-deep'] }),
    task('email', 'Reply to <b>emails</b> & "quotes"', days([[0, 20 * M], [-2, 35 * M]])),
    task('incident', 'Fix flaky deploy pipeline', days([[-1, 50 * M], [-2, 95 * M]]), { projectId: 'p-ops', tagIds: ['t-urgent'] }),
    task('tokens', 'Color tokens review', days([[0, 35 * M], [-2, 40 * M]]), { projectId: 'p-design', tagIds: ['t-meeting', 't-deep'] }),
    task('idea', 'Untracked idea', {}),
  ];
  let archived = [
    task('onboarding', 'Onboard new teammate', days([[-7, 3 * H], [-9, 2 * H]]), { projectId: 'p-internal', isDone: true }),
  ];

  // Twelve weeks of finished work, so the trend chart has something to show.
  // A small seeded generator keeps it the same on every load.
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const historyProjects = ['p-client', 'p-internal', 'p-ops', 'p-design', 'p-learning', null];
  for (let offset = -84; offset <= -3; offset++) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    if (d.getDay() === 0 || (d.getDay() === 6 && rand() < 0.7)) continue;
    const count = 1 + Math.floor(rand() * 3);
    for (let n = 0; n < count; n++) {
      const project = historyProjects[Math.floor(rand() * historyProjects.length)];
      const minutes = 20 + Math.floor(rand() * 200);
      archived.push(task(`hist${offset}-${n}`, `Archived work ${-offset}.${n}`, days([[offset, minutes * M]]), { projectId: project, isDone: true }));
    }
  }

  // ---------- Storage (persisted in localStorage so reloads keep it) ----------
  if (params.get('reset')) localStorage.removeItem(STORAGE_KEY);
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || { blob: null, keys: {} };
  if (params.get('seed') === 'v1' && !saved.blob && !Object.keys(saved.keys).length) {
    saved.blob = JSON.stringify({
      v: 1,
      settings: { weekStartsOn: 0, dailyTargetHours: [0, 7, 7, 7, 7, 7, 0], autoDelete: { enabled: true, atTime: '00:00' } },
      log: {
        entries: {
          'gone-task': { title: 'Old task deleted in 1.x', projectId: 'p-client', projectTitle: 'Client Portal', projectColor: '#e91e63', tagIds: [], tagTitles: [], byDate: days([[-2, 2 * H]]), isDeleted: true, lastSeen: 1 },
          'manual-legacy': { title: 'Manual from 1.x', projectId: null, projectTitle: null, projectColor: null, tagIds: [], tagTitles: [], byDate: days([[-1, 30 * M]]), isDeleted: false, isManual: true, lastSeen: 1 },
        },
      },
      autoDeleteState: { lastRunDate: dayStr(-1) },
    });
  }
  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  const stats = { writes: [], loads: 0, lists: 0, getTasks: 0, getArchivedTasks: 0 };

  // ---------- Hooks ----------
  const Hooks = {
    TASK_CREATED: 'taskCreated', TASK_COMPLETE: 'taskComplete', TASK_UPDATE: 'taskUpdate', TASK_DELETE: 'taskDelete',
    CURRENT_TASK_CHANGE: 'currentTaskChange', FINISH_DAY: 'finishDay', LANGUAGE_CHANGE: 'languageChange',
    PERSISTED_DATA_CHANGED: 'persistedDataChanged', ACTION: 'action', ANY_TASK_UPDATE: 'anyTaskUpdate',
    PROJECT_LIST_UPDATE: 'projectListUpdate', WORK_CONTEXT_CHANGE: 'workContextChange',
  };
  const handlers = {};
  const fire = (hook, payload) => setTimeout(() => (handlers[hook] || []).forEach((fn) => fn(payload)), 5);

  // ---------- API ----------
  const later = (value, ms = 15) => new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));
  let archivedFails = false;

  const api = {
    cfg: { theme, appVersion: '18.0.0-dev', platform: 'web' },
    Hooks,
    getTasks: () => { stats.getTasks++; return later(active); },
    getArchivedTasks: () => {
      stats.getArchivedTasks++;
      return archivedFails ? Promise.reject(new Error('archive unavailable (mock)')) : later(archived, 60);
    },
    getAllProjects: () => later(projects),
    // ?firstDay=0..6 sets Super Productivity's "First day of week"; otherwise
    // it's on "System default" and Timesheet uses the locale.
    getAppState: () => later({
      tasks: {},
      globalConfig: {
        localization: { firstDayOfWeek: params.has('firstDay') ? Number(params.get('firstDay')) : null },
        misc: { startOfNextDayTime: params.get('dayStart') || '00:00' }, // ?dayStart=04:00
      },
    }, 120),
    getAllTags: () => later(tags),
    registerHook: (hook, fn) => {
      (handlers[hook] = handlers[hook] || []).push(fn);
      return later(undefined, 1);
    },
    persistDataSynced: (data, key) => {
      stats.writes.push({ key: keyed ? key || '(blob)' : '(blob)', bytes: data.length, at: new Date().toLocaleTimeString() });
      if (keyed && key) saved.keys[key] = data;
      else saved.blob = data;
      persist();
      fire(Hooks.PERSISTED_DATA_CHANGED); // the real host fires this for the plugin's own writes too
      return later(undefined, 10);
    },
    loadSyncedData: (key) => {
      stats.loads++;
      return later(keyed && key ? saved.keys[key] ?? null : saved.blob);
    },
    showSnack: ({ msg, type }) => {
      const el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText = `position:fixed;left:50%;bottom:24px;transform:translateX(-50%);padding:10px 16px;border-radius:8px;
        font:14px system-ui;color:#fff;background:${type === 'ERROR' ? '#c62828' : '#2e7d32'};z-index:99;box-shadow:0 4px 16px #0006`;
      document.body.append(el);
      setTimeout(() => el.remove(), 3000);
      return later(undefined, 1);
    },
  };
  if (keyed) {
    api.listSyncedDataKeys = () => {
      stats.lists++;
      return later(Object.keys(saved.keys).filter((k) => saved.keys[k]).sort());
    };
  }

  // ---------- Running timer ----------
  let timer = null;
  const startTimer = () => {
    timer = setInterval(() => {
      const t = active.find((x) => x.id === 'report');
      if (!t) return;
      const today = dayStr(0);
      t.timeSpentOnDay[today] = (t.timeSpentOnDay[today] || 0) + 1000;
      fire(Hooks.ACTION, { action: { type: '[TimeTracking] Add time spent' } });
    }, 1000);
  };
  if (params.get('timer') !== '0') startTimer();

  // ---------- Download bridge when opened on its own (no plugin.js host) ----------
  if (window.parent === window) {
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || msg.type !== 'SP_TIMESHEET_DOWNLOAD') return;
      const url = URL.createObjectURL(new Blob([msg.data], { type: 'text/csv' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: msg.filename });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      window.__mock.lastDownload = msg;
      window.postMessage({ type: 'SP_TIMESHEET_DOWNLOAD_RESULT', requestId: msg.requestId, ok: true }, '*');
    });
  }

  window.__mock = {
    stats,
    saved,
    get active() { return active; },
    get archived() { return archived; },
    stopTimer: () => clearInterval(timer),
    deleteTask(id) {
      const ids = [id, ...(active.find((t) => t.id === id)?.subTaskIds || [])];
      active = active.filter((t) => !ids.includes(t.id));
      fire(Hooks.TASK_DELETE, { taskId: id });
      fire(Hooks.ACTION, { action: { type: '[Task Shared] deleteTask' } });
    },
    archiveDone() {
      fire(Hooks.FINISH_DAY, { date: dayStr(0) });
      const done = active.filter((t) => t.isDone);
      active = active.filter((t) => !t.isDone);
      archived = [...archived, ...done];
      fire(Hooks.ACTION, { action: { type: '[Task Shared] moveToArchive' } });
    },
    setDone(id) { const t = active.find((x) => x.id === id); if (t) t.isDone = true; },
    failArchived(on = true) { archivedFails = on; },
    // Another device adds a manual entry and sync delivers it.
    remoteAddEntry(title = 'Added on another device') {
      const key = `log-${dayStr(0).slice(0, 7)}`;
      const current = keyed ? saved.keys[key] : JSON.parse(saved.blob || '{"v":2,"keys":{}}').keys[key];
      const shard = JSON.parse(current || '{"v":2,"entries":{}}');
      shard.entries[`manual-remote-${Date.now()}`] = {
        title, projectId: null, projectTitle: null, projectColor: null, tags: [], parentId: null,
        isManual: true, isDeleted: false, byDate: { [dayStr(0)]: 45 * M },
      };
      if (keyed) saved.keys[key] = JSON.stringify(shard);
      else {
        const blob = JSON.parse(saved.blob);
        blob.keys[key] = JSON.stringify(shard);
        saved.blob = JSON.stringify(blob);
      }
      persist();
      fire(Hooks.PERSISTED_DATA_CHANGED);
    },
  };

  // The real host can inject the API after the plugin's script starts.
  setTimeout(() => { window.PluginAPI = api; }, 150);
})();
