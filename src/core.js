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

  // Super Productivity can start a new day after midnight (Settings › Misc ›
  // Start of next day), and books time to dates by that boundary. Minutes
  // after midnight, from its misc config.
  const dayStartOffset = (misc) => {
    if (!misc || typeof misc !== 'object') return 0;
    const time = typeof misc.startOfNextDayTime === 'string' && misc.startOfNextDayTime.match(/^(\d{1,2}):(\d{2})$/);
    const minutes = time ? Number(time[1]) * 60 + Number(time[2]) : Number(misc.startOfNextDay) * 60;
    return Number.isFinite(minutes) && minutes > 0 && minutes < 24 * 60 ? minutes : 0;
  };

  // "Now", moved back by the day boundary, so its calendar date is the day
  // Super Productivity is booking time to.
  const shiftedNow = (offsetMinutes, now = new Date()) => new Date(now.getTime() - (offsetMinutes || 0) * MINUTE_MS);

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

  // 'app' follows Super Productivity's own "First day of week" setting.
  const WEEK_START_OPTIONS = ['app', 0, 1, 2, 3, 4, 5, 6];
  const TIME_FORMAT_OPTIONS = ['hm', 'decimal'];
  const VIEW_OPTIONS = ['sheet', 'chart'];
  // 'last' reopens whichever view was used last.
  const DEFAULT_VIEW_OPTIONS = ['last', 'sheet', 'chart'];
  const BREAKDOWN_OPTIONS = ['project', 'tag', 'task'];

  const DEFAULT_SETTINGS = Object.freeze({
    weekStartsOn: 'app',
    dailyTargetHours: Object.freeze([0, 8, 8, 8, 8, 8, 0]), // index 0..6 = Sun..Sat
    timeFormat: 'hm',
    showSubtasks: true,
    debugLogging: false,
    view: 'sheet', // the view used last
    defaultView: 'last',
    breakdownBy: 'project',
  });

  // The weekday (0 = Sunday) a week starts on, given the setting and the day
  // Super Productivity uses.
  const resolveWeekStart = (setting, appFirstDay) => {
    if (setting !== 'app') return setting;
    return Number.isInteger(appFirstDay) && appFirstDay >= 0 && appFirstDay <= 6 ? appFirstDay : 1;
  };

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
      view: VIEW_OPTIONS.includes(src.view) ? src.view : DEFAULT_SETTINGS.view,
      defaultView: DEFAULT_VIEW_OPTIONS.includes(src.defaultView) ? src.defaultView : DEFAULT_SETTINGS.defaultView,
      breakdownBy: BREAKDOWN_OPTIONS.includes(src.breakdownBy) ? src.breakdownBy : DEFAULT_SETTINGS.breakdownBy,
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
    // A task can't have more than a day of time on one day.
    for (const [date, ms] of Object.entries(raw)) {
      if (DATE_RE.test(date) && Number.isFinite(ms) && ms > 0) out[date] = Math.min(MAX_ENTRY_MS, Math.round(ms));
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
   * Two guards keep a change in Super Productivity's data model, or a host
   * glitch, from wiping history:
   * - A task without a timeSpentOnDay object is left alone, never read as
   *   "no time".
   * - If a complete fetch is missing a large share of the logged tasks at once
   *   (getArchivedTasks returns [] when the archive fails to load), nothing is
   *   flagged; the ids come back as `held` for the caller to confirm later
   *   with `allowMassDelete`.
   *
   * Returns { changed, missing, held }: missing counts live entries that
   * weren't in `tasks` (a hint that a complete refresh is due).
   */
  const MASS_MISSING_MIN = 20;
  const MASS_MISSING_SHARE = 0.25;

  const mergeLiveTasks = (log, tasks, { projectsById = {}, tagsById = {}, complete = false, allowMassDelete = false } = {}) => {
    let changed = false;
    const seen = new Set();

    for (const task of tasks) {
      if (!task || typeof task.id !== 'string') continue;
      seen.add(task.id);
      const existing = log.entries[task.id];
      if (existing && existing.isManual) continue;

      const raw = task.timeSpentOnDay;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue; // unknown shape: keep what we have
      const byDate = cleanByDate(raw);
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

    const live = Object.entries(log.entries).filter(([, e]) => !e.isManual && !e.isDeleted);
    const missingIds = live.filter(([id]) => !seen.has(id)).map(([id]) => id);
    if (!complete) return { changed, missing: missingIds.length, held: [] };

    const mass = missingIds.length >= MASS_MISSING_MIN && missingIds.length > live.length * MASS_MISSING_SHARE;
    if (mass && !allowMassDelete) return { changed, missing: missingIds.length, held: missingIds };
    for (const id of missingIds) log.entries[id].isDeleted = true;
    return { changed: changed || missingIds.length > 0, missing: 0, held: [] };
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

  // Changes one day of an editable entry. Moving it onto another date the
  // entry already has time on adds the two. Title and project only change on
  // manual entries.
  const updateEntry = (log, id, { fromDate, toDate, ms, title, projectId, projectTitle, projectColor }) => {
    const entry = log.entries[id];
    if (!isEditable(entry) || !validEntryTime(toDate, ms)) return false;
    if (entry.isManual && String(title || '').trim()) {
      entry.title = String(title).trim();
      entry.projectId = strOrNull(projectId);
      entry.projectTitle = entry.projectId ? strOrNull(projectTitle) : null;
      entry.projectColor = entry.projectId ? safeColor(projectColor) : null;
    }
    const moving = fromDate && fromDate !== toDate;
    const already = moving ? entry.byDate[toDate] || 0 : 0;
    if (moving) delete entry.byDate[fromDate];
    entry.byDate[toDate] = Math.min(MAX_ENTRY_MS, Math.round(ms) + already);
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
        // When a subtask is deleted, Super Productivity recomputes the parent
        // from the remaining subtasks, but the log keeps the deleted one's
        // hours; the larger sum is the time actually tracked.
        const childSum = children.reduce((sum, c) => sum + c.ms, 0);
        rows.push({ ...top, counted: Math.max(top.ms, childSum), children, partial: false });
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

  // ---------- Chart data ----------

  const PALETTE_SIZE = 8;
  const OTHER = '__other__';
  const NO_TAG = '__notag__';

  const projectKey = (entry) => entry.projectId || NO_PROJECT;

  /**
   * Project key → color slot. Slots go to the projects with the most tracked
   * time overall, computed from the whole log and not from the filtered week on
   * screen, so a project keeps its color while you browse and filter. With
   * more projects than colors, the top seven keep theirs and the rest share
   * "Other" (a key missing from the map).
   */
  const assignProjectSlots = (log) => {
    const totals = new Map();
    const titles = new Map();
    for (const entry of Object.values(log.entries)) {
      if (entry.parentId && log.entries[entry.parentId]) continue; // already in the parent's time
      const key = projectKey(entry);
      const sum = Object.values(entry.byDate).reduce((a, b) => a + b, 0);
      totals.set(key, (totals.get(key) || 0) + sum);
      if (entry.projectTitle) titles.set(key, entry.projectTitle);
    }
    const ranked = [...totals]
      .sort((a, b) => b[1] - a[1] || String(titles.get(a[0]) || '').localeCompare(String(titles.get(b[0]) || '')))
      .map(([key]) => key);
    const named = ranked.length <= PALETTE_SIZE ? ranked : ranked.slice(0, PALETTE_SIZE - 1);
    return new Map(named.map((key, i) => [key, i]));
  };

  // One day's counted time per project color, bottom of the stack first
  // ("Other" on top).
  const daySegments = (rows, slots) => {
    const byKey = new Map();
    for (const row of rows) {
      const key = slots.has(projectKey(row.entry)) ? projectKey(row.entry) : OTHER;
      byKey.set(key, (byKey.get(key) || 0) + row.counted);
    }
    const order = (key) => (key === OTHER ? Infinity : slots.get(key));
    return [...byKey].map(([key, ms]) => ({ key, ms })).sort((a, b) => order(a.key) - order(b.key));
  };

  const weekChart = (log, weekStart, filter, slots) => weekDates(weekStart).map((date) => {
    const dateStr = toDateStr(date);
    const rows = rowsForDay(log, dateStr, filter);
    return { date, dateStr, total: sumCounted(rows), segments: daySegments(rows, slots) };
  });

  const dayTotal = (log, date, filter) => sumCounted(rowsForDay(log, toDateStr(date), filter));

  // Totals for `count` weeks, oldest first, the last one starting at lastWeekStart.
  const weekTotals = (log, lastWeekStart, count, filter) => Array.from({ length: count }, (_, i) => {
    const weekStart = addDays(lastWeekStart, (i - count + 1) * 7);
    return { weekStart, total: weekDates(weekStart).reduce((sum, d) => sum + dayTotal(log, d, filter), 0) };
  });

  /**
   * The week on screen against the week before, over the same days. For the
   * current week that's only the days so far, so a week in progress isn't
   * measured against a whole one. Null for a week that hasn't started.
   */
  const compareWithPreviousWeek = (log, weekStart, filter, today = new Date()) => {
    const todayStr = toDateStr(today);
    const days = weekDates(weekStart).filter((d) => toDateStr(d) <= todayStr).length;
    if (!days) return null;
    const total = (start) => weekDates(start).slice(0, days).reduce((sum, d) => sum + dayTotal(log, d, filter), 0);
    return { current: total(weekStart), previous: total(addDays(weekStart, -7)), days };
  };

  /**
   * Progress toward the week's target. `pace` is the target of the days up to
   * and including today: where you'd be if every day so far had met its
   * target. For a week that's over, pace is the whole target. Days on target
   * only count days so far that have a target, so a 0h weekend never counts
   * against you. dailyTargetHours: index 0..6 = Sun..Sat.
   */
  const weekProgress = (log, weekStart, filter, dailyTargetHours, today = new Date()) => {
    const todayStr = toDateStr(today);
    const result = { total: 0, target: 0, pace: 0, activeDays: 0, average: 0, daysWithTarget: 0, daysOnTarget: 0 };
    for (const date of weekDates(weekStart)) {
      const ms = dayTotal(log, date, filter);
      const dayTarget = (Number(dailyTargetHours[date.getDay()]) || 0) * HOUR_MS;
      result.total += ms;
      result.target += dayTarget;
      if (ms > 0) result.activeDays++;
      if (toDateStr(date) > todayStr) continue;
      result.pace += dayTarget;
      if (dayTarget > 0) {
        result.daysWithTarget++;
        if (ms >= dayTarget) result.daysOnTarget++;
      }
    }
    result.average = result.activeDays ? result.total / result.activeDays : 0;
    return result;
  };

  // Where a row's counted time was tracked, with the tags that apply there:
  // subtask time carries the subtask's tags plus the parent's, and time on the
  // parent itself carries the parent's.
  const tagShares = (row) => {
    const withParentTags = (tags) => [...new Map([...tags, ...row.entry.tags].map((t) => [t.id, t])).values()];
    const shares = row.children.map((child) => ({ ms: child.ms, tags: withParentTags(child.entry.tags) }));
    const rest = row.counted - shares.reduce((sum, s) => sum + s.ms, 0);
    if (rest > 0) shares.push({ ms: rest, tags: row.entry.tags });
    return shares;
  };

  /**
   * Time per project, tag or task over the given days, biggest first:
   * { total, overlapping, items: [{ key, label, ms, projectKey }] }.
   * Tags overlap: a task with two tags counts toward both, so tag items can
   * add up to more than the total (`overlapping` says when that happened). A
   * tag label is null when the log never learned the tag's name.
   */
  const breakdown = (log, dateStrs, filter, by) => {
    const items = new Map();
    let total = 0;
    let overlapping = false;
    const add = (key, label, ms, project) => {
      const item = items.get(key) || { key, label, ms: 0, projectKey: project };
      item.ms += ms;
      items.set(key, item);
    };
    for (const dateStr of dateStrs) {
      for (const row of rowsForDay(log, dateStr, filter)) {
        total += row.counted;
        const project = projectKey(row.entry);
        if (by === 'project') {
          add(project, row.entry.projectTitle || 'No project', row.counted, project);
        } else if (by === 'task') {
          add(row.id, row.entry.title, row.counted, project);
        } else {
          for (const share of tagShares(row)) {
            if (share.tags.length > 1) overlapping = true;
            if (!share.tags.length) add(NO_TAG, 'No tag', share.ms, null);
            for (const tag of share.tags) add(tag.id, tag.title, share.ms, null);
          }
        }
      }
    }
    const sorted = [...items.values()].sort((a, b) => b.ms - a.ms || String(a.label || '').localeCompare(String(b.label || '')));
    return { total, overlapping, items: sorted };
  };

  // Axis maximum and ticks on readable hour steps (0, 2h, 4h, 6h...), with at
  // most `maxSteps` steps and at least 1h of range.
  const HOUR_STEPS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 24, 48, 96];
  const hourScale = (maxMs, maxSteps = 4) => {
    const maxH = Math.min(Math.max(Number(maxMs) / HOUR_MS || 0, 1), 1e6);
    let step = HOUR_STEPS.find((s) => Math.ceil(maxH / s - 1e-9) <= maxSteps);
    if (!step) {
      step = HOUR_STEPS[HOUR_STEPS.length - 1];
      while (Math.ceil(maxH / step - 1e-9) > maxSteps) step *= 2;
    }
    const steps = Math.ceil(maxH / step - 1e-9);
    return { max: steps * step * HOUR_MS, ticks: Array.from({ length: steps + 1 }, (_, i) => i * step * HOUR_MS) };
  };

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
          lines.push(line(date, row.entry.title, row.entry, row.entry, row.counted));
        }
      }
    }
    // BOM so Excel opens it as UTF-8.
    return `﻿${lines.join('\r\n')}\r\n`;
  };

  // ---------- Stored format ----------
  //
  // 'settings'        -> { v, ...settings }
  // 'log-YYYY-MM'     -> { v, entries: { id: entry with that month's days only } }
  // 'log-YYYY-MM~2'…  -> more of the same month, when one key would be too big
  //
  // Splitting the log by month means a running timer rewrites one small key
  // instead of the whole history. Output is sorted, so the same state always
  // serializes to the same strings and unchanged keys are never rewritten.

  // The host rejects a single write over 256 KB; stay well under it.
  const MAX_KEY_CHARS = 180 * 1024;
  const LOG_KEY_RE = /^log-(\d{4}-\d{2})(?:~\d+)?$/;
  const isStoredKey = (key) => key === SETTINGS_KEY || LOG_KEY_RE.test(key);

  const safeParse = (str) => {
    if (typeof str !== 'string' || !str) return null;
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  };

  const sortedObject = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));

  const shardString = (entries) => JSON.stringify({ v: SCHEMA_VERSION, entries: sortedObject(entries) });

  // A month's entries as one key, or several when one would be too big.
  const encodeMonth = (month, entries) => {
    const ids = Object.keys(entries).sort();
    const parts = [];
    let part = {};
    let size = 0;
    for (const id of ids) {
      const entrySize = JSON.stringify(entries[id]).length + id.length + 4;
      if (size && size + entrySize > MAX_KEY_CHARS) {
        parts.push(part);
        part = {};
        size = 0;
      }
      part[id] = entries[id];
      size += entrySize;
    }
    parts.push(part);
    return Object.fromEntries(parts.map((p, i) => [`${LOG_KEY_PREFIX}${month}${i ? `~${i + 1}` : ''}`, shardString(p)]));
  };

  const encodeState = (settings, log) => {
    const months = {};
    for (const [id, entry] of Object.entries(log.entries)) {
      for (const [date, ms] of Object.entries(entry.byDate)) {
        const month = date.slice(0, 7);
        months[month] = months[month] || {};
        months[month][id] = months[month][id] || { ...entry, byDate: {} };
        months[month][id].byDate[date] = ms;
      }
    }
    // The view used last is per device (see app.js), so it isn't synced.
    const { view, ...synced } = coerceSettings(settings);
    const data = { [SETTINGS_KEY]: JSON.stringify(sortedObject({ v: SCHEMA_VERSION, ...synced })) };
    for (const [month, entries] of Object.entries(months)) {
      for (const entry of Object.values(entries)) entry.byDate = sortedObject(entry.byDate);
      Object.assign(data, encodeMonth(month, entries));
    }
    return sortedObject(data);
  };

  // A stored value this version can read: a JSON object with v === SCHEMA_VERSION.
  const readable = (str) => {
    const parsed = safeParse(str);
    return parsed && typeof parsed === 'object' && parsed.v === SCHEMA_VERSION ? parsed : null;
  };

  /**
   * Stored keys → settings and log. `unreadable` lists keys this version
   * can't read (written by a newer version, or damaged). They must never be
   * overwritten; see createStore's protect().
   */
  const decodeState = (data) => {
    const unreadable = Object.keys(data).filter((k) => isStoredKey(k) && data[k] && !readable(data[k]));
    const settingsRaw = readable(data[SETTINGS_KEY]);
    const settings = coerceSettings(settingsRaw);
    const log = emptyLog();
    // Oldest month first, so the newest month's copy of an entry's details wins.
    const logKeys = Object.keys(data).filter((k) => LOG_KEY_RE.test(k)).sort();
    for (const key of logKeys) {
      const parsed = readable(data[key]);
      if (!parsed || !parsed.entries || typeof parsed.entries !== 'object') continue;
      const month = key.match(LOG_KEY_RE)[1];
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
    return { settings, log, unreadable };
  };

  /**
   * Three-way merge of one stored key, for when storage no longer holds what
   * this device last read or wrote (`base`): another device wrote it, or this
   * device never saw it. `ours` is what this device wants to write, `theirs`
   * what storage holds now. Per entry (per field, for settings):
   * - only one side changed it: that side's version, including a removal;
   * - both changed it: ours;
   * - it's new on one side: kept.
   * Every device merges before it writes, so an entry missing from `theirs`
   * that we had seen was removed on purpose. A device that never saw any
   * settings has only defaults to offer, so theirs win.
   */
  const mergeStoredValue = (key, base, ours, theirs) => {
    if (!theirs || theirs === base) return ours;
    if (ours === base) return theirs;
    if (key === SETTINGS_KEY) {
      const b = readable(base);
      const o = readable(ours);
      const t = readable(theirs);
      if (!b || !o || !t) return t ? theirs : ours;
      const merged = { ...t };
      for (const field of Object.keys(o)) if (!sameJson(o[field], b[field])) merged[field] = o[field];
      return JSON.stringify(sortedObject(merged));
    }
    const entriesOf = (str) => {
      const parsed = readable(str);
      return parsed && parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    };
    const b = entriesOf(base);
    const o = entriesOf(ours);
    const t = entriesOf(theirs);
    const unchangedByUs = (id) => id in b && id in o && sameJson(o[id], b[id]);
    const unchangedByThem = (id) => id in b && id in t && sameJson(t[id], b[id]);
    const merged = {};
    for (const id of new Set([...Object.keys(o), ...Object.keys(t)])) {
      if (id in o && id in t) merged[id] = unchangedByUs(id) ? t[id] : o[id];
      else if (id in o) {
        if (!unchangedByUs(id)) merged[id] = o[id]; // they removed it and we didn't touch it: gone
      } else if (!unchangedByThem(id)) {
        merged[id] = t[id]; // we removed it and they didn't touch it: gone
      }
    }
    return Object.keys(merged).length ? shardString(merged) : '';
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

  // ---------- Backup ----------
  //
  // A backup file holds the same keys as storage, so it reads back through
  // decodeState and can't drift from the stored format.

  const BACKUP_APP = 'sp-timesheet';

  const buildBackup = (settings, log, now = new Date()) =>
    JSON.stringify({ app: BACKUP_APP, schema: SCHEMA_VERSION, exportedAt: now.toISOString(), data: encodeState(settings, log) });

  // Throws an Error with a message fit for the user when the file can't be used.
  const parseBackup = (text) => {
    const parsed = safeParse(text);
    if (!parsed || parsed.app !== BACKUP_APP || !parsed.data || typeof parsed.data !== 'object') {
      throw new Error('That file is not a Timesheet backup.');
    }
    if (parsed.schema !== SCHEMA_VERSION) {
      throw new Error('That backup is from a newer version of Timesheet. Update the plugin, then restore it.');
    }
    const data = Object.fromEntries(Object.entries(parsed.data).filter(([k, v]) => isStoredKey(k) && typeof v === 'string'));
    const { settings, log } = decodeState(data);
    return { settings, log, hasSettings: Boolean(readable(data[SETTINGS_KEY])), exportedAt: String(parsed.exportedAt || '') };
  };

  // Adds what `source` has and `target` lacks: whole entries, and days missing
  // from entries both have. Nothing already in target is changed or removed.
  const mergeLogs = (target, source) => {
    const added = { entries: 0, days: 0 };
    for (const [id, entry] of Object.entries(source.entries)) {
      const existing = target.entries[id];
      if (!existing) {
        target.entries[id] = { ...entry, tags: entry.tags.map((t) => ({ ...t })), byDate: { ...entry.byDate } };
        added.entries++;
        continue;
      }
      for (const [date, ms] of Object.entries(entry.byDate)) {
        if (!(date in existing.byDate)) {
          existing.byDate[date] = ms;
          added.days++;
        }
      }
    }
    return added;
  };

  // The single blob older hosts keep everything in is limited like any write.
  const MAX_BLOB_CHARS = 240 * 1024;

  /**
   * Key/value storage on the plugin's synced data. Hosts with keyed storage
   * (listSyncedDataKeys exists) get one synced key per stored key. Older hosts
   * only have the single unkeyed blob, so the keys live inside it. Older hosts
   * also silently ignore the key argument, which is why the check is on
   * listSyncedDataKeys and not on persistDataSynced.
   *
   * Guards against losing data:
   * - save() refuses to run before a load has succeeded.
   * - save() reads each key again before writing it. When storage no longer
   *   holds what this device last saw (another device wrote it, or this device
   *   never saw it), it merges instead of overwriting (mergeStoredValue) and
   *   sets `mergedSinceLoad`, so the caller reloads and keeps the merged data.
   * - Keys passed to protect() (from a newer version, or damaged) are never
   *   written or removed, and a blob this version can't read makes the store
   *   read-only.
   * - An empty key listing while the settings key exists is treated as a
   *   failed load, not as "nothing saved yet".
   *
   * Only keys whose content changed are written, so re-saving data that was
   * just loaded writes nothing. Calls are serialized, so a load can't
   * interleave with a save.
   */
  const createStore = (api) => {
    const keyed = typeof api.listSyncedDataKeys === 'function';
    let known = {}; // what storage holds, as far as we know
    let loaded = false;
    let readOnly = false;
    let mergedSinceLoad = false;
    const protectedKeys = new Set();
    let queue = Promise.resolve();
    const serialize = (fn) => {
      const run = queue.then(fn);
      queue = run.catch(() => {});
      return run;
    };
    const asText = (value) => (typeof value === 'string' ? value : '');

    const load = async () => {
      mergedSinceLoad = false;
      if (keyed) {
        const listed = await api.listSyncedDataKeys();
        if (!Array.isArray(listed)) throw new Error('Timesheet storage: unexpected key listing');
        const data = {};
        for (const key of listed.filter(isStoredKey)) {
          const value = await api.loadSyncedData(key);
          if (value == null || value === '') continue;
          if (typeof value === 'string') data[key] = value;
          else protectedKeys.add(key); // not text: leave it alone
        }
        if (Object.keys(data).length || protectedKeys.size) {
          known = { ...data };
          loaded = true;
          return data;
        }
        // Every save writes the settings key, so an empty listing with settings
        // present means the listing is wrong, not that nothing was saved.
        if (asText(await api.loadSyncedData(SETTINGS_KEY))) {
          throw new Error('Timesheet storage: key listing came back empty but data exists');
        }
        // Nothing keyed yet: first run of this version, so pick up 1.x data from
        // the unkeyed blob. It's left in place as a backup; `known` stays empty
        // so the next save writes every key (merging with anything already there).
        const legacy = blobToData(safeParse(await api.loadSyncedData()));
        known = {};
        loaded = true;
        return legacy;
      }
      const raw = await api.loadSyncedData();
      const parsed = safeParse(raw);
      const isV1 = parsed && parsed.v === 1;
      const data = blobToData(parsed);
      // A blob that isn't ours to read (newer version, damaged, not text) is
      // never overwritten.
      readOnly = raw != null && raw !== '' && !isV1 && !(parsed && parsed.v === SCHEMA_VERSION);
      known = parsed && parsed.v === SCHEMA_VERSION ? { ...data } : {};
      loaded = true;
      return data;
    };

    // A non-empty value this version can't read (a newer version wrote it
    // while this device was running): protect it, never merge into it.
    const foreign = (key, text) => Boolean(text) && isStoredKey(key) && !readable(text);

    // `base` is what this device knew storage held when the save was asked
    // for, which is what `data` was built against. A load queued ahead of the
    // save may move `known` on before it runs; merging against that instead
    // would overwrite whatever the load brought in.
    const save = async (data, base) => {
      if (!loaded) throw new Error('Timesheet storage: save() before a successful load()');
      if (readOnly) return 0;
      const keys = [...new Set([...Object.keys(base), ...Object.keys(data)])].filter((k) => !protectedKeys.has(k));
      const changed = keys.filter((k) => (data[k] || '') !== (base[k] || ''));
      if (!changed.length) return 0;

      if (keyed) {
        let written = 0;
        for (const key of changed) {
          const current = await api.loadSyncedData(key);
          const currentText = asText(current);
          if ((current != null && typeof current !== 'string') || foreign(key, currentText)) {
            protectedKeys.add(key);
            continue;
          }
          let value = data[key] || '';
          if (currentText !== (base[key] || '')) {
            value = mergeStoredValue(key, base[key] || '', value, currentText);
            mergedSinceLoad = true;
          }
          if (value !== currentText) {
            await api.persistDataSynced(value, key); // empty string removes the key
            written++;
          }
          if (value) known[key] = value;
          else delete known[key];
        }
        return written;
      }

      const raw = await api.loadSyncedData();
      const current = safeParse(raw);
      const currentData = current && current.v === SCHEMA_VERSION ? blobToData(current) : null;
      if (raw && !currentData && !(current && current.v === 1)) {
        readOnly = true; // replaced by something this version can't read
        return 0;
      }
      const next = {};
      for (const key of new Set([...Object.keys(data), ...Object.keys(base), ...Object.keys(currentData || {})])) {
        const theirs = currentData ? currentData[key] || '' : base[key] || '';
        if (foreign(key, theirs)) protectedKeys.add(key);
        let value = protectedKeys.has(key) ? theirs : data[key] || '';
        if (!protectedKeys.has(key) && theirs !== (base[key] || '')) {
          value = mergeStoredValue(key, base[key] || '', value, theirs);
          mergedSinceLoad = true;
        }
        if (value) next[key] = value;
      }
      const blob = JSON.stringify({ v: SCHEMA_VERSION, keys: sortedObject(next) });
      if (blob.length > MAX_BLOB_CHARS) {
        throw new Error('Timesheet storage: data is too large for this version of Super Productivity; update the app');
      }
      if (blob !== raw) await api.persistDataSynced(blob);
      known = sortedObject(next);
      return changed.length;
    };

    return {
      keyed,
      get readOnly() { return readOnly; },
      get mergedSinceLoad() { return mergedSinceLoad; },
      get protectedKeys() { return [...protectedKeys]; },
      protect: (keys) => keys.forEach((k) => protectedKeys.add(k)),
      load: () => serialize(load),
      save: (data) => {
        const base = { ...known };
        return serialize(() => save(data, base));
      },
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
    dayStartOffset,
    shiftedNow,
    formatRange,
    formatDayHeading,
    formatDuration,
    formatClock,
    parseDuration,
    toDurationInput,
    coerceSettings,
    resolveWeekStart,
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
    OTHER,
    NO_TAG,
    projectKey,
    assignProjectSlots,
    weekChart,
    weekTotals,
    compareWithPreviousWeek,
    weekProgress,
    breakdown,
    hourScale,
    buildCsv,
    encodeState,
    decodeState,
    blobToData,
    mergeStoredValue,
    buildBackup,
    parseBackup,
    mergeLogs,
    createStore,
  };
})();
