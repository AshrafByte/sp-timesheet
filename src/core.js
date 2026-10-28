/*
 * Timesheet core: date math, durations, settings, the time log, CSV and
 * storage. Nothing here touches the DOM or the global PluginAPI, so the tests
 * can load this file on its own. The build inlines it ahead of app.js.
 */
const TimesheetCore = (() => {
  'use strict';

  const SCHEMA_VERSION = 2;
  const SETTINGS_KEY = 'settings';
  const LOG_KEY_PREFIX = 'log-';
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const MAX_ENTRY_MS = 24 * HOUR_MS;
  // Super Productivity's built-in "Today" list is a tag on older versions. It
  // says nothing about the work, so it's never shown or offered as a filter.
  const TODAY_TAG_ID = 'TODAY';

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- Dates ----------
  // Days are local calendar dates as 'YYYY-MM-DD', the same keys Super
  // Productivity uses in task.timeSpentOnDay.

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const pad2 = (n) => String(n).padStart(2, '0');

  const toDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;


  // Calendar arithmetic, not milliseconds, so DST changes can't shift the day.
  const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

  const startOfWeek = (date, weekStartsOn) => {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return addDays(day, -((day.getDay() - weekStartsOn + 7) % 7));
  };

  const weekDates = (weekStart) => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const formatRange = (weekStart) => {
    const end = addDays(weekStart, 6);
    const left = `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()}`;
    const right = end.getMonth() === weekStart.getMonth()
      ? String(end.getDate())
      : `${MONTH_NAMES[end.getMonth()]} ${end.getDate()}`;
    const year = end.getFullYear() !== new Date().getFullYear() || end.getFullYear() !== weekStart.getFullYear()
      ? `, ${end.getFullYear()}`
      : '';
    return `${left} – ${right}${year}`;
  };

  const formatDayHeading = (d) => `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;

  // ---------- Durations ----------

  const formatDuration = (ms, format = 'hm') => {
    const totalMin = Math.round((ms || 0) / MINUTE_MS);
    if (format === 'decimal') return `${(totalMin / 60).toFixed(2)}h`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return m === 0 ? '0h' : `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  };

  // "1:30" style, for the CSV.
  const formatClock = (ms) => {
    const totalMin = Math.round((ms || 0) / MINUTE_MS);
    return `${Math.floor(totalMin / 60)}:${pad2(totalMin % 60)}`;
  };

  // Accepts "2h35m", "2h 35m", "1h", "34m", "34min", "1.5h", "1:30" and a bare
  // number of hours ("2.5"). Returns milliseconds, or NaN for anything else.
  const parseDuration = (input) => {
    const str = String(input ?? '').trim().toLowerCase();
    if (!str) return NaN;
    if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * HOUR_MS);
    const clock = str.match(/^(\d+):([0-5]\d)$/);
    if (clock) return (Number(clock[1]) * 60 + Number(clock[2])) * MINUTE_MS;
    const hm = str.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?$/);
    if (!hm || (hm[1] === undefined && hm[2] === undefined)) return NaN;
    return Math.round((parseFloat(hm[1] || '0') * 60 + parseFloat(hm[2] || '0')) * MINUTE_MS);
  };

  // Compact form for prefilling the duration field: "2h35m" / "1h" / "34m".
  const toDurationInput = (ms) => formatDuration(ms).replace(' ', '');

  // ---------- Settings ----------

  const WEEK_START_OPTIONS = [1, 0, 6];
  const TIME_FORMAT_OPTIONS = ['hm', 'decimal'];

  const DEFAULT_SETTINGS = Object.freeze({
    weekStartsOn: 1,
    dailyTargetHours: Object.freeze([0, 8, 8, 8, 8, 8, 0]), // index 0..6 = Sun..Sat
    timeFormat: 'hm',
    showSubtasks: true,
    debugLogging: false,
  });

  const clampHours = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(24, Math.max(0, Math.round(n * 100) / 100)) : 0;
  };

  // Settings come from synced storage, so every value is checked against what
  // is allowed; anything else falls back to its default.
  const coerceSettings = (raw) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const targets = Array.isArray(src.dailyTargetHours) && src.dailyTargetHours.length === 7
      ? src.dailyTargetHours.map(clampHours)
      : [...DEFAULT_SETTINGS.dailyTargetHours];
    return {
      weekStartsOn: WEEK_START_OPTIONS.includes(src.weekStartsOn) ? src.weekStartsOn : DEFAULT_SETTINGS.weekStartsOn,
      dailyTargetHours: targets,
      timeFormat: TIME_FORMAT_OPTIONS.includes(src.timeFormat) ? src.timeFormat : DEFAULT_SETTINGS.timeFormat,
      showSubtasks: typeof src.showSubtasks === 'boolean' ? src.showSubtasks : DEFAULT_SETTINGS.showSubtasks,
      debugLogging: src.debugLogging === true,
    };
  };

  // ---------- Time log ----------
  //
  // log.entries[id] holds one task's snapshot plus its tracked time per day:
  //   { title, projectId, projectTitle, projectColor, tags: [{ id, title }],
  //     parentId, isManual, isDeleted, byDate: { 'YYYY-MM-DD': ms } }
  // Live tasks are refreshed from Super Productivity; manual entries and
  // deleted tasks exist only here.

  const emptyLog = () => ({ entries: {} });

  const cleanByDate = (raw) => {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [date, ms] of Object.entries(raw)) {
      if (DATE_RE.test(date) && Number.isFinite(ms) && ms > 0) out[date] = Math.round(ms);
    }
    return out;
  };

  // Project colors end up in a style attribute, so only plain color syntax passes.
  const SAFE_COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%deg/]+\))$/i;
  const safeColor = (c) => (typeof c === 'string' && SAFE_COLOR_RE.test(c.trim()) ? c.trim() : null);

  const strOrNull = (v) => (typeof v === 'string' && v ? v : null);

  // Canonical shape and key order, so comparing two entries as JSON is reliable.
  const normalizeEntry = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const byDate = cleanByDate(raw.byDate);
    if (!Object.keys(byDate).length) return null;
    const tags = Array.isArray(raw.tags)
      ? raw.tags
        .filter((t) => t && typeof t.id === 'string' && t.id !== TODAY_TAG_ID)
        .map((t) => ({ id: t.id, title: strOrNull(t.title) }))
      : [];
    return {
      title: typeof raw.title === 'string' && raw.title ? raw.title : 'Untitled task',
      projectId: strOrNull(raw.projectId),
      projectTitle: strOrNull(raw.projectTitle),
      projectColor: safeColor(raw.projectColor),
      tags,
      parentId: strOrNull(raw.parentId),
      isManual: raw.isManual === true,
      isDeleted: raw.isDeleted === true,
      byDate,
    };
  };

  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * Fold Super Productivity's tasks into the log. For a task SP still has, SP
   * is the source of truth: its timeSpentOnDay replaces whatever the log held.
   * Entries are never dropped for disappearing; they're flagged isDeleted so
   * their hours stay in the timesheet. That flagging only happens when
   * `complete` is set (the caller fetched active AND archived tasks), because
   * a failed or partial fetch would otherwise flag everything it missed.
   *
   * Returns { changed, missing }: missing counts live entries that weren't in
   * `tasks` (a hint that a complete refresh is due).
   */
  const mergeLiveTasks = (log, tasks, { projectsById = {}, tagsById = {}, complete = false } = {}) => {
    let changed = false;
    const seen = new Set();

    for (const task of tasks) {
      if (!task || typeof task.id !== 'string') continue;
      seen.add(task.id);
      const existing = log.entries[task.id];
      if (existing && existing.isManual) continue;

      const byDate = cleanByDate(task.timeSpentOnDay);
      if (!Object.keys(byDate).length) {
        // No tracked time left in SP, so nothing to keep.
        if (existing) {
          delete log.entries[task.id];
          changed = true;
        }
        continue;
      }

      const projectId = strOrNull(task.projectId);
      const project = projectId ? projectsById[projectId] : null;
      const keepOldProject = !project && existing && existing.projectId === projectId;
      const tagIds = Array.isArray(task.tagIds)
        ? task.tagIds.filter((id) => typeof id === 'string' && id !== TODAY_TAG_ID)
        : [];

      const next = normalizeEntry({
        title: task.title,
        projectId,
        projectTitle: project ? project.title : keepOldProject ? existing.projectTitle : null,
        projectColor: project ? project.theme && project.theme.primary : keepOldProject ? existing.projectColor : null,
        tags: tagIds.map((id) => ({
          id,
          title: tagsById[id] ? tagsById[id].title : (existing && (existing.tags.find((t) => t.id === id) || {}).title) || null,
        })),
        parentId: task.parentId,
        isManual: false,
        isDeleted: false,
        byDate,
      });

      if (!existing || !sameJson(existing, next)) {
        log.entries[task.id] = next;
        changed = true;
      }
    }

    let missing = 0;
    for (const [id, entry] of Object.entries(log.entries)) {
      if (entry.isManual || entry.isDeleted || seen.has(id)) continue;
      if (complete) {
        entry.isDeleted = true;
        changed = true;
      } else {
        missing++;
      }
    }
    return { changed, missing };
  };

  const markDeleted = (log, ids) => {
    let changed = false;
    for (const id of ids) {
      const entry = log.entries[id];
      if (entry && !entry.isManual && !entry.isDeleted) {
        entry.isDeleted = true;
        changed = true;
      }
    }
    return changed;
  };

  // Live entries mirror Super Productivity; editing them here would be undone
  // by the next refresh, so only manual entries and deleted tasks are editable.
  const isEditable = (entry) => !!entry && (entry.isManual || entry.isDeleted);

  const validEntryTime = (date, ms) => DATE_RE.test(date) && Number.isFinite(ms) && ms > 0 && ms <= MAX_ENTRY_MS;

  const addManualEntry = (log, { title, projectId = null, projectTitle = null, projectColor = null, date, ms }, makeId) => {
    if (!validEntryTime(date, ms) || !String(title || '').trim()) return null;
    const id = makeId();
    log.entries[id] = normalizeEntry({
      title: String(title).trim(),
      projectId,
      projectTitle,
      projectColor,
      tags: [],
      parentId: null,
      isManual: true,
      isDeleted: false,
      byDate: { [date]: ms },
    });
    return id;
  };

  // Changes one day of an editable entry. Moving it to another date replaces
  // that date's value. Title and project only change on manual entries.
  const updateEntry = (log, id, { fromDate, toDate, ms, title, projectId, projectTitle, projectColor }) => {
    const entry = log.entries[id];
    if (!isEditable(entry) || !validEntryTime(toDate, ms)) return false;
    if (entry.isManual && String(title || '').trim()) {
      entry.title = String(title).trim();
      entry.projectId = strOrNull(projectId);
      entry.projectTitle = entry.projectId ? strOrNull(projectTitle) : null;
      entry.projectColor = entry.projectId ? safeColor(projectColor) : null;
    }
    if (fromDate && fromDate !== toDate) delete entry.byDate[fromDate];
    entry.byDate[toDate] = Math.round(ms);
    return true;
  };

  const removeEntryDay = (log, id, date) => {
    const entry = log.entries[id];
    if (!isEditable(entry) || !(date in entry.byDate)) return false;
    delete entry.byDate[date];
    if (!Object.keys(entry.byDate).length) delete log.entries[id];
    return true;
  };

  const hasTag = (entry, tagId) => entry.tags.some((t) => t.id === tagId);

  const NO_PROJECT = '__none__';

  /**
   * Rows for one day, biggest first. Super Productivity rolls subtask time up
   * into the parent's timeSpentOnDay, so only top-level rows count toward
   * totals and subtasks hang off their parent as detail. A subtask whose parent
   * has no time that day is counted on its own, so its time isn't lost.
   *
   * A tag filter matches a row by its own tags, or by its subtasks' tags; in
   * the second case only the matching subtasks count.
   *
   * Row: { id, entry, ms, counted, children: [{ id, entry, ms }], partial }
   */
  const rowsForDay = (log, dateStr, { projectId = 'all', tagId = 'all' } = {}) => {
    const withTime = [];
    for (const [id, entry] of Object.entries(log.entries)) {
      const ms = entry.byDate[dateStr];
      if (ms > 0) withTime.push({ id, entry, ms });
    }
    const hasTimeToday = new Set(withTime.map((r) => r.id));
    const tops = [];
    const childrenOf = new Map();
    for (const item of withTime) {
      const parentId = item.entry.parentId;
      if (parentId && hasTimeToday.has(parentId)) {
        if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
        childrenOf.get(parentId).push(item);
      } else {
        tops.push(item);
      }
    }

    // Subtasks always share their parent's project, so the project filter only
    // needs to look at top-level rows.
    const matchesProject = (entry) =>
      projectId === 'all' || (projectId === NO_PROJECT ? !entry.projectId : entry.projectId === projectId);
    const byMsDesc = (a, b) => b.ms - a.ms || a.entry.title.localeCompare(b.entry.title);
    const rows = [];
    for (const top of tops) {
      if (!matchesProject(top.entry)) continue;
      const children = (childrenOf.get(top.id) || []).sort(byMsDesc);
      if (tagId === 'all' || hasTag(top.entry, tagId)) {
        rows.push({ ...top, counted: top.ms, children, partial: false });
        continue;
      }
      const matching = children.filter((c) => hasTag(c.entry, tagId));
      if (matching.length) {
        rows.push({ ...top, counted: matching.reduce((sum, c) => sum + c.ms, 0), children: matching, partial: true });
      }
    }
    return rows.sort((a, b) => b.counted - a.counted || a.entry.title.localeCompare(b.entry.title));
  };

  const sumCounted = (rows) => rows.reduce((sum, r) => sum + r.counted, 0);

  // ---------- CSV ----------

  // Cells that start with = + - @ (or tab/CR) run as formulas in spreadsheet
  // apps; a leading apostrophe makes them plain text.
  const csvCell = (value) => {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };

  const sourceLabel = (entry) => (entry.isManual ? 'Manual' : entry.isDeleted ? 'Deleted task' : 'Super Productivity');

  // One line per counted row, so the CSV totals match the timesheet. When a
  // tag filter matched only some subtasks, those subtasks are the lines.
  const buildCsv = (log, dateStrs, filter) => {
    const lines = [['Date', 'Task', 'Project', 'Tags', 'Hours', 'Duration', 'Source'].map(csvCell).join(',')];
    const line = (date, title, entry, projectEntry, ms) => [
      date,
      title,
      projectEntry.projectTitle || '',
      entry.tags.map((t) => t.title).filter(Boolean).join('; '),
      (ms / HOUR_MS).toFixed(2),
      formatClock(ms),
      sourceLabel(entry),
    ].map(csvCell).join(',');

    for (const date of dateStrs) {
      for (const row of rowsForDay(log, date, filter)) {
        if (row.partial) {
          for (const child of row.children) {
            lines.push(line(date, `${row.entry.title} › ${child.entry.title}`, child.entry, row.entry, child.ms));
          }
        } else {
          lines.push(line(date, row.entry.title, row.entry, row.entry, row.ms));
        }
      }
    }
    // BOM so Excel opens it as UTF-8.
    return `﻿${lines.join('\r\n')}\r\n`;
  };

  // ---------- Stored format ----------
  //
  // 'settings'      -> { v, ...settings }
  // 'log-YYYY-MM'   -> { v, entries: { id: entry with that month's days only } }
  //
  // Splitting the log by month means a running timer rewrites one small key
  // instead of the whole history. Output is sorted, so the same state always
  // serializes to the same strings and unchanged keys are never rewritten.

  const safeParse = (str) => {
    if (typeof str !== 'string' || !str) return null;
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  };

  const sortedObject = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));

  const encodeState = (settings, log) => {
    const months = {};
    for (const [id, entry] of Object.entries(log.entries)) {
      for (const [date, ms] of Object.entries(entry.byDate)) {
        const key = LOG_KEY_PREFIX + date.slice(0, 7);
        months[key] = months[key] || {};
        months[key][id] = months[key][id] || { ...entry, byDate: {} };
        months[key][id].byDate[date] = ms;
      }
    }
    const data = { [SETTINGS_KEY]: JSON.stringify({ v: SCHEMA_VERSION, ...coerceSettings(settings) }) };
    for (const [key, entries] of Object.entries(months)) {
      for (const entry of Object.values(entries)) entry.byDate = sortedObject(entry.byDate);
      data[key] = JSON.stringify({ v: SCHEMA_VERSION, entries: sortedObject(entries) });
    }
    return sortedObject(data);
  };

  const decodeState = (data) => {
    const settingsRaw = safeParse(data[SETTINGS_KEY]);
    const settings = coerceSettings(settingsRaw && settingsRaw.v === SCHEMA_VERSION ? settingsRaw : null);
    const log = emptyLog();
    // Oldest month first, so the newest month's copy of an entry's details wins.
    const logKeys = Object.keys(data).filter((k) => /^log-\d{4}-\d{2}$/.test(k)).sort();
    for (const key of logKeys) {
      const parsed = safeParse(data[key]);
      if (!parsed || parsed.v !== SCHEMA_VERSION || !parsed.entries || typeof parsed.entries !== 'object') continue;
      const month = key.slice(LOG_KEY_PREFIX.length);
      for (const [id, raw] of Object.entries(parsed.entries)) {
        const entry = normalizeEntry(raw);
        if (!entry) continue;
        // A month key only vouches for its own days.
        const days = Object.entries(entry.byDate).filter(([date]) => date.startsWith(month));
        if (!days.length) continue;
        const prev = log.entries[id];
        log.entries[id] = { ...entry, byDate: { ...(prev ? prev.byDate : {}), ...Object.fromEntries(days) } };
      }
    }
    return { settings, log };
  };

  // v1 (1.x) kept everything in the single unkeyed blob:
  //   { v: 1, settings, log: { entries }, autoDeleteState }
  // Auto-delete is gone, so its settings and state are dropped.
  const migrateV1 = (parsed) => {
    const log = emptyLog();
    const rawEntries = (parsed.log && parsed.log.entries) || {};
    for (const [id, raw] of Object.entries(rawEntries)) {
      if (!raw || typeof raw !== 'object') continue;
      const tagIds = Array.isArray(raw.tagIds) ? raw.tagIds : [];
      const titles = Array.isArray(raw.tagTitles) && raw.tagTitles.length === tagIds.length ? raw.tagTitles : [];
      const entry = normalizeEntry({ ...raw, tags: tagIds.map((tagId, i) => ({ id: tagId, title: titles[i] })) });
      if (entry) log.entries[id] = entry;
    }
    const oldSettings = parsed.settings || {};
    return {
      settings: coerceSettings({ weekStartsOn: oldSettings.weekStartsOn, dailyTargetHours: oldSettings.dailyTargetHours }),
      log,
    };
  };

  // The unkeyed blob holds either 1.x data or, on hosts without keyed
  // storage, this version's keys: { v: 2, keys: { key: string } }.
  const blobToData = (parsed) => {
    if (!parsed || typeof parsed !== 'object') return {};
    if (parsed.v === 1) {
      const { settings, log } = migrateV1(parsed);
      return encodeState(settings, log);
    }
    if (parsed.v === SCHEMA_VERSION && parsed.keys && typeof parsed.keys === 'object') {
      return Object.fromEntries(Object.entries(parsed.keys).filter(([, v]) => typeof v === 'string' && v));
    }
    return {};
  };

  /**
   * Key/value storage on the plugin's synced data. Hosts with keyed storage
   * (listSyncedDataKeys exists) get one synced key per stored key. Older hosts
   * only have the single unkeyed blob, so the keys live inside it. Older hosts
   * also silently ignore the key argument, which is why the check is on
   * listSyncedDataKeys and not on persistDataSynced.
   *
   * save() writes only keys whose content differs from what storage holds, so
   * re-saving data that was just loaded writes nothing. It refuses to run
   * before a load has succeeded: with nothing known about storage, it would
   * overwrite saved history with whatever is in memory. Calls are serialized,
   * so a load can't interleave with a save.
   */
  const createStore = (api) => {
    const keyed = typeof api.listSyncedDataKeys === 'function';
    let known = {}; // what storage holds, as far as we know
    let loaded = false;
    let queue = Promise.resolve();
    const serialize = (fn) => {
      const run = queue.then(fn);
      queue = run.catch(() => {});
      return run;
    };

    const load = async () => {
      if (keyed) {
        const keys = ((await api.listSyncedDataKeys()) || [])
          .filter((k) => k === SETTINGS_KEY || k.startsWith(LOG_KEY_PREFIX));
        const data = {};
        for (const key of keys) {
          const value = await api.loadSyncedData(key);
          if (value) data[key] = value;
        }
        if (Object.keys(data).length) {
          known = { ...data };
          loaded = true;
          return data;
        }
        // Nothing keyed yet: first run of this version, so pick up 1.x data from
        // the unkeyed blob. It's left in place as a backup; `known` stays empty
        // so the next save writes every key.
        const legacy = blobToData(safeParse(await api.loadSyncedData()));
        known = {};
        loaded = true;
        return legacy;
      }
      const parsed = safeParse(await api.loadSyncedData());
      const data = blobToData(parsed);
      known = parsed && parsed.v === SCHEMA_VERSION ? { ...data } : {};
      loaded = true;
      return data;
    };

    const save = async (data) => {
      if (!loaded) throw new Error('Timesheet storage: save() before a successful load()');
      const keys = new Set([...Object.keys(known), ...Object.keys(data)]);
      const changed = [...keys].filter((k) => (data[k] || '') !== (known[k] || ''));
      if (!changed.length) return 0;
      if (keyed) {
        for (const key of changed) {
          const value = data[key] || ''; // empty string removes the key
          await api.persistDataSynced(value, key);
          if (value) known[key] = value;
          else delete known[key];
        }
        return changed.length;
      }
      const next = sortedObject(Object.fromEntries(Object.entries(data).filter(([, v]) => v)));
      await api.persistDataSynced(JSON.stringify({ v: SCHEMA_VERSION, keys: next }));
      known = { ...next };
      return changed.length;
    };

    return {
      keyed,
      load: () => serialize(load),
      save: (data) => serialize(() => save(data)),
    };
  };

  return {
    HOUR_MS,
    MAX_ENTRY_MS,
    TODAY_TAG_ID,
    NO_PROJECT,
    DAY_NAMES,
    DATE_RE,
    DEFAULT_SETTINGS,
    toDateStr,
    addDays,
    startOfWeek,
    weekDates,
    formatRange,
    formatDayHeading,
    formatDuration,
    formatClock,
    parseDuration,
    toDurationInput,
    coerceSettings,
    emptyLog,
    safeColor,
    mergeLiveTasks,
    markDeleted,
    isEditable,
    addManualEntry,
    updateEntry,
    removeEntryDay,
    rowsForDay,
    sumCounted,
    buildCsv,
    encodeState,
    decodeState,
    blobToData,
    createStore,
  };
})();
