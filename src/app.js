/*
 * Timesheet UI. Connects TimesheetCore to Super Productivity's PluginAPI and
 * the page: fetching tasks, keeping the log saved, rendering the week, and the
 * settings and entry dialogs.
 */
(() => {
  'use strict';

  const C = TimesheetCore;

  // The ACTION hook fires on every store action, including each tick of a
  // running timer, so refreshes triggered by it are throttled.
  const REFRESH_THROTTLE_MS = 4000;
  const POLL_MS = 30000;
  // Archived tasks rarely change and can be a large fetch.
  const FULL_REFRESH_MS = 5 * 60 * 1000;
  const FULL_RETRY_MS = 60 * 1000;
  // Changes that only mirror Super Productivity can wait: SP still has that
  // data. Edits made here are saved immediately.
  const SAVE_DELAY_MS = 30000;
  const LOAD_RETRY_MS = 15000;
  const RELOAD_DEBOUNCE_MS = 300;
  const API_WAIT_MS = 10000;
  const DOWNLOAD_TIMEOUT_MS = 5000;

  const state = {
    api: null,
    store: null,
    storageReady: false,
    loaded: false,
    settings: C.coerceSettings(),
    log: C.emptyLog(),
    weekStart: C.startOfWeek(new Date(), C.DEFAULT_SETTINGS.weekStartsOn),
    projects: [],
    projectsById: {},
    tags: [],
    tagsById: {},
    activeTasks: null, // null until fetched successfully
    archivedTasks: null,
    filter: { projectId: 'all', tagId: 'all' },
    collapsed: new Set(),
    chartSelected: null, // the day picked in Insights ('YYYY-MM-DD'), or null for the whole week
    breakdownExpanded: false,
    animateCharts: true,
    userRevision: 0, // bumped by every edit made in this view
  };

  // ---------- Helpers ----------

  const $ = (id) => document.getElementById(id);

  // Small DOM builder. Text always goes in as text, never as HTML.
  const h = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  };

  const byTitle = (a, b) => String(a.title).localeCompare(String(b.title));
  const indexById = (items) => Object.fromEntries(items.map((item) => [item.id, item]));
  const fmt = (ms) => C.formatDuration(ms, state.settings.timeFormat);

  const debug = (...args) => {
    if (state.settings.debugLogging) console.debug('[Timesheet]', ...args);
  };
  const reportError = (message, err) => console.error('[Timesheet]', message, err);
  const snack = (msg, type = 'SUCCESS') => {
    Promise.resolve()
      .then(() => state.api.showSnack({ msg, type }))
      .catch((err) => reportError('showSnack failed', err));
  };

  const newManualId = () =>
    `manual-${typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;

  // ---------- Saved data ----------

  let saveTimer = null;
  let saveDueAt = 0;
  let saveErrorShown = false;

  const scheduleSave = (delay = SAVE_DELAY_MS) => {
    const due = Date.now() + delay;
    if (saveTimer && saveDueAt <= due) return;
    clearTimeout(saveTimer);
    saveDueAt = due;
    saveTimer = setTimeout(saveNow, delay);
  };

  const saveNow = async () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!state.storageReady) return false;
    try {
      const written = await state.store.save(C.encodeState(state.settings, state.log));
      if (written) debug('saved', written, 'key(s)');
      saveErrorShown = false;
      return true;
    } catch (err) {
      reportError('saving failed', err);
      if (!saveErrorShown) {
        saveErrorShown = true;
        snack('Timesheet could not save its data. It will keep retrying.', 'ERROR');
      }
      scheduleSave();
      return false;
    }
  };

  const applyStored = (data) => {
    const previousWeekStart = state.settings.weekStartsOn;
    ({ settings: state.settings, log: state.log } = C.decodeState(data));
    if (state.settings.weekStartsOn !== previousWeekStart) {
      state.weekStart = C.startOfWeek(state.weekStart, state.settings.weekStartsOn);
    }
    state.storageReady = true;
  };

  // Until a load succeeds, nothing is saved and nothing can be edited; saving
  // over storage we couldn't read would lose history.
  const loadSaved = async () => {
    try {
      applyStored(await state.store.load());
      return true;
    } catch (err) {
      reportError(`loading saved data failed; retrying in ${LOAD_RETRY_MS / 1000}s`, err);
      setTimeout(() => scheduleReload(), LOAD_RETRY_MS);
      return false;
    }
  };

  let reloadTimer = null;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadFromStorage, RELOAD_DEBOUNCE_MS);
  };

  // PERSISTED_DATA_CHANGED fires for this plugin's own writes as well as for
  // changes synced from other devices. Re-reading our own write and saving it
  // back writes nothing (the store skips unchanged keys), so this can't loop.
  const reloadFromStorage = async () => {
    const revision = state.userRevision;
    const wasReady = state.storageReady;
    if (!(await loadSaved())) return;
    if (revision !== state.userRevision) {
      // An edit landed while loading. Its save is queued behind this load, so
      // read again once it has gone through.
      scheduleReload();
      return;
    }
    mergeLive(false); // put Super Productivity's current numbers back on top
    render();
    if (!wasReady) saveNow();
  };

  // ---------- Live data ----------

  let lastFullRefreshAt = 0;
  let lastFullAttemptAt = 0;
  let fetchErrorShown = false;

  const settle = async (calls) => {
    const names = Object.keys(calls);
    const results = await Promise.allSettled(names.map((name) => Promise.resolve().then(calls[name])));
    const ok = {};
    const failed = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') ok[names[i]] = result.value;
      else {
        failed.push(names[i]);
        reportError(`${names[i]} failed`, result.reason);
      }
    });
    return { ok, failed };
  };

  // Returns true when both active and archived tasks arrived, i.e. the task
  // list is complete enough to tell which logged tasks were deleted.
  const fetchLive = async ({ includeArchived }) => {
    const { api } = state;
    const calls = {
      active: () => api.getTasks(),
      projects: () => api.getAllProjects(),
      tags: () => api.getAllTags(),
    };
    if (includeArchived) calls.archived = () => api.getArchivedTasks();
    const { ok, failed } = await settle(calls);

    if ('projects' in ok) {
      state.projects = (Array.isArray(ok.projects) ? ok.projects : []).filter((p) => p && p.id);
      state.projectsById = indexById(state.projects);
    }
    if ('tags' in ok) {
      state.tags = (Array.isArray(ok.tags) ? ok.tags : []).filter((t) => t && t.id && t.id !== C.TODAY_TAG_ID);
      state.tagsById = indexById(state.tags);
    }
    if ('active' in ok) state.activeTasks = Array.isArray(ok.active) ? ok.active : [];
    if ('archived' in ok) {
      state.archivedTasks = Array.isArray(ok.archived) ? ok.archived : [];
      lastFullRefreshAt = Date.now();
    }
    if (failed.length && !fetchErrorShown) {
      fetchErrorShown = true;
      snack('Timesheet could not load some data from Super Productivity. Showing what it has.', 'ERROR');
    }
    return includeArchived && 'active' in ok && 'archived' in ok;
  };

  const mergeLive = (complete) => {
    const tasks = [...(state.activeTasks || []), ...(state.archivedTasks || [])];
    const { changed, missing } = C.mergeLiveTasks(state.log, tasks, {
      projectsById: state.projectsById,
      tagsById: state.tagsById,
      complete,
    });
    if (changed) scheduleSave();
    // A logged task vanished since the last complete fetch: it was archived or
    // deleted, and only a complete fetch can tell which.
    if (!complete && missing > 0 && Date.now() - lastFullAttemptAt > FULL_RETRY_MS) {
      requestRefresh({ full: true });
    }
    return changed;
  };

  let refreshTimer = null;
  let refreshRunning = false;
  let refreshPending = false;
  let wantFull = false;
  let lastRefreshAt = 0;

  const requestRefresh = ({ full = false } = {}) => {
    wantFull = wantFull || full;
    if (refreshRunning) {
      refreshPending = true;
      return;
    }
    if (refreshTimer) return;
    const wait = Math.max(0, lastRefreshAt + REFRESH_THROTTLE_MS - Date.now());
    refreshTimer = setTimeout(runRefresh, wait);
  };

  const runRefresh = async () => {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    refreshRunning = true;
    const now = Date.now();
    const fullDue = now - lastFullAttemptAt > FULL_RETRY_MS
      && (state.archivedTasks === null || now - lastFullRefreshAt > FULL_REFRESH_MS);
    const full = wantFull || fullDue;
    wantFull = false;
    lastRefreshAt = now;
    if (full) lastFullAttemptAt = now;
    try {
      const complete = await fetchLive({ includeArchived: full });
      const changed = mergeLive(complete);
      if (changed || filtersChanged() || !state.loaded) render();
      debug('refreshed', { full, complete, changed });
    } catch (err) {
      reportError('refresh failed', err);
    } finally {
      refreshRunning = false;
      if (refreshPending) {
        refreshPending = false;
        requestRefresh();
      }
    }
  };

  // ---------- Hooks ----------

  const registerHooks = () => {
    const { api } = state;
    const hooks = api.Hooks || {};
    const on = (hook, handler) => {
      if (!hook || typeof api.registerHook !== 'function') return;
      Promise.resolve()
        .then(() => api.registerHook(hook, handler))
        .catch((err) => reportError(`registering ${hook} failed`, err));
    };

    on(hooks.ACTION, () => requestRefresh());
    on(hooks.TASK_DELETE, (payload) => {
      const ids = payload && Array.isArray(payload.taskIds) ? payload.taskIds
        : payload && payload.taskId ? [payload.taskId] : [];
      if (C.markDeleted(state.log, ids)) {
        render();
        saveNow();
      }
      // Subtasks are deleted with their parent but aren't in the payload.
      requestRefresh({ full: true });
    });
    // Runs just before Super Productivity archives the day's done tasks; look
    // again shortly after so they're found in the archive.
    on(hooks.FINISH_DAY, () => {
      setTimeout(() => requestRefresh({ full: true }), 3000);
    });
    on(hooks.PERSISTED_DATA_CHANGED, scheduleReload);
  };

  // ---------- Rendering ----------

  const currentWeekStart = () => C.startOfWeek(new Date(), state.settings.weekStartsOn);
  const tagTitles = (entry) =>
    entry.tags.map((t) => t.title || (state.tagsById[t.id] && state.tagsById[t.id].title)).filter(Boolean);

  // Projects from Super Productivity, plus ones only the log still knows
  // (deleted projects of deleted tasks), so their hours stay filterable.
  const projectOptions = () => {
    const options = new Map(state.projects.map((p) => [p.id, p.title]));
    for (const entry of Object.values(state.log.entries)) {
      if (entry.projectId && !options.has(entry.projectId) && entry.projectTitle) {
        options.set(entry.projectId, entry.projectTitle);
      }
    }
    return [...options].map(([id, title]) => ({ id, title })).sort(byTitle);
  };

  let filterSignature = '';
  const filtersChanged = () =>
    JSON.stringify([projectOptions(), state.tags.map((t) => [t.id, t.title])]) !== filterSignature;

  const fillSelect = (select, options, current) => {
    select.replaceChildren(...options.map(([value, label]) => h('option', { value, text: label })));
    select.value = options.some(([value]) => value === current) ? current : 'all';
    return select.value;
  };

  // Rebuilding a <select> closes it if it's open, so only do it on change.
  const renderFilters = () => {
    const projects = projectOptions();
    const tags = [...state.tags].sort(byTitle);
    const signature = JSON.stringify([projects, state.tags.map((t) => [t.id, t.title])]);
    if (signature === filterSignature) return;
    filterSignature = signature;
    state.filter.projectId = fillSelect($('projectFilter'), [
      ['all', 'All projects'],
      [C.NO_PROJECT, 'No project'],
      ...projects.map((p) => [p.id, p.title]),
    ], state.filter.projectId);
    state.filter.tagId = fillSelect($('tagFilter'), [
      ['all', 'All tags'],
      ...tags.map((t) => [t.id, t.title]),
    ], state.filter.tagId);
  };

  const rowEl = (row, dateStr, isChild) => {
    const { entry } = row;
    const editable = C.isEditable(entry);
    const titles = tagTitles(entry);
    return h('div', {
      class: `ts-row${isChild ? ' is-child' : ''}${editable ? ' is-editable' : ''}`,
      role: editable ? 'button' : null,
      tabindex: editable ? '0' : null,
      title: editable ? 'Edit this entry' : null,
      dataset: editable ? { editId: row.id, editDate: dateStr } : null,
    },
    h('div', { class: 'ts-task' },
      h('span', { class: 'ts-task-title', text: entry.title }),
      entry.isManual && h('span', { class: 'ts-badge', text: 'manual' }),
      entry.isDeleted && h('span', {
        class: 'ts-badge',
        text: 'deleted',
        title: 'No longer in Super Productivity. The hours are kept here.',
      })),
    h('div', { class: 'ts-project' },
      entry.projectTitle
        ? [h('span', { class: 'ts-dot', style: { background: entry.projectColor || '' } }),
          h('span', { class: 'ts-project-name', text: entry.projectTitle })]
        : h('span', { class: 'ts-muted', text: '–' })),
    h('div', { class: 'ts-tags' },
      titles.length
        ? titles.map((title) => h('span', { class: 'ts-tag', text: title }))
        : h('span', { class: 'ts-muted', text: '–' })),
    h('div', { class: 'ts-time', text: fmt(isChild ? row.ms : row.counted) }));
  };

  const dayCard = (day, dateStr, rows, total) => {
    const target = state.settings.dailyTargetHours[day.getDay()] || 0;
    const pct = target > 0 ? Math.min(100, (total / (target * C.HOUR_MS)) * 100) : total > 0 ? 100 : 0;
    const isToday = dateStr === C.toDateStr(new Date());
    const collapsed = state.collapsed.has(dateStr);
    const heading = C.formatDayHeading(day);

    const body = rows.length
      ? rows.flatMap((row) => [
        rowEl(row, dateStr, false),
        ...(state.settings.showSubtasks || row.partial ? row.children.map((child) => rowEl(child, dateStr, true)) : []),
      ])
      : [h('div', { class: 'ts-empty', text: 'No time tracked' })];

    return h('section', {
      class: `ts-day${isToday ? ' is-today' : ''}${collapsed ? ' collapsed' : ''}`,
      'aria-label': heading,
      dataset: { date: dateStr },
    },
    h('div', { class: 'ts-day-head' },
      h('button', { type: 'button', class: 'ts-day-toggle', 'aria-expanded': String(!collapsed), dataset: { toggleDate: dateStr } },
        h('span', { class: 'ts-chevron', 'aria-hidden': 'true', text: '▾' }),
        heading,
        isToday && h('span', { class: 'ts-pill', text: 'Today' })),
      h('div', { class: 'ts-day-right' },
        h('button', {
          type: 'button',
          class: 'ts-day-add',
          title: 'Add an entry for this day',
          'aria-label': `Add an entry for ${heading}`,
          dataset: { addDate: dateStr },
          text: '+',
        }),
        h('div', { class: 'ts-day-hours' }, fmt(total), ' ', h('span', { class: 'ts-day-target', text: `/ ${fmt(target * C.HOUR_MS)}` })))),
    h('div', {
      class: 'ts-progress',
      role: 'progressbar',
      'aria-label': `${heading} progress toward target`,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(Math.round(pct)),
    }, h('div', { class: 'ts-progress-fill', style: { width: `${pct}%` } })),
    h('div', { class: 'ts-table' },
      h('div', { class: 'ts-row ts-row-head', 'aria-hidden': 'true' },
        h('span', { text: 'Task' }), h('span', { text: 'Project' }), h('span', { class: 'ts-tags', text: 'Tags' }), h('span', { class: 'ts-time', text: 'Tracked' })),
      body));
  };

  const stat = (label, value) =>
    h('div', {}, h('div', { class: 'ts-stat-label', text: label }), h('div', { class: 'ts-stat-value', text: value }));

  const renderSummary = (days, weekTotal, activeDays) => {
    const targetHours = days.reduce((sum, d) => sum + (state.settings.dailyTargetHours[d.getDay()] || 0), 0);
    const targetMs = targetHours * C.HOUR_MS;
    const pct = targetMs > 0 ? (weekTotal / targetMs) * 100 : 0;
    $('weekSummary').replaceChildren(...[
      h('div', { class: 'ts-stats' },
        stat('Total this week', fmt(weekTotal)),
        stat('Weekly target', fmt(targetMs)),
        stat('Avg per active day', fmt(activeDays ? weekTotal / activeDays : 0))),
      targetMs > 0 && h('div', {},
        h('div', { class: 'ts-progress-label' },
          h('span', {}, h('strong', { text: `${Math.round(pct)}%` }), ' of weekly target'),
          h('span', { text: `${fmt(weekTotal)} / ${fmt(targetMs)}` })),
        h('div', {
          class: 'ts-progress ts-progress-lg',
          role: 'progressbar',
          'aria-label': 'Progress toward weekly target',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(Math.min(100, Math.round(pct))),
        }, h('div', { class: 'ts-progress-fill', style: { width: `${Math.min(100, pct)}%` } }))),
    ].filter(Boolean));
  };

  const updateCollapseAllLabel = () => {
    const dates = C.weekDates(state.weekStart).map(C.toDateStr);
    $('collapseAllBtn').textContent = dates.every((d) => state.collapsed.has(d)) ? 'Expand all' : 'Collapse all';
  };

  const renderSheet = () => {
    const days = C.weekDates(state.weekStart);
    let weekTotal = 0;
    let activeDays = 0;
    const cards = days.map((day) => {
      const dateStr = C.toDateStr(day);
      const rows = C.rowsForDay(state.log, dateStr, state.filter);
      const total = C.sumCounted(rows);
      weekTotal += total;
      if (total > 0) activeDays++;
      return dayCard(day, dateStr, rows, total);
    });
    $('daysContainer').replaceChildren(...cards);
    renderSummary(days, weekTotal, activeDays);
    updateCollapseAllLabel();
  };

  // ---------- Insights ----------

  const LONG_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const BREAKDOWN_LIMIT = 8;
  const TREND_WEEKS = 12;

  const shortDate = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const weekTitle = () => (+state.weekStart === +currentWeekStart() ? 'This week' : `Week of ${shortDate(state.weekStart)}`);

  const seriesColor = (slots, key) =>
    slots.has(key) ? `var(--ts-series-${slots.get(key) + 1})` : 'var(--ts-series-other)';

  const projectName = (key) => {
    if (key === C.OTHER) return 'Other';
    if (key === C.NO_PROJECT) return 'No project';
    const option = projectOptions().find((p) => p.id === key);
    return option ? option.title : 'Unknown project';
  };

  const tickLabel = (ms) => {
    if (ms === 0) return '0';
    if (ms < C.HOUR_MS) return `${Math.round(ms / 60000)}m`;
    return `${Math.round((ms / C.HOUR_MS) * 100) / 100}h`;
  };

  const tipRow = (keyClass, color, name, value) => h('div', { class: 'ts-tip-row' },
    h('span', { class: keyClass, style: color ? { background: color } : null }),
    h('span', { class: 'ts-tip-name', text: name }),
    h('span', { class: 'ts-tip-num', text: value }));

  // Positions a tooltip over `anchor` (px inside its chart), kept inside the card.
  const placeTooltip = (tip, anchor, content) => {
    if (!anchor) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(...content.filter(Boolean));
    tip.hidden = false;
    const wrapWidth = tip.parentElement.clientWidth;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(anchor.x, half + 4), wrapWidth - half - 4)}px`;
    tip.style.top = `${Math.max(anchor.y, tip.offsetHeight + 12)}px`;
  };

  const focusedHit = (host) => [...host.querySelectorAll('.ts-hit')].indexOf(document.activeElement);

  let insightsKey = '';
  let weekHover = -1;
  let trendHover = -1;
  let swiped = false;

  const renderInsights = () => {
    const width = Math.floor($('weekChart').clientWidth);
    if (!width) return; // hidden; drawn when shown
    const slots = C.assignProjectSlots(state.log);
    const week = C.weekChart(state.log, state.weekStart, state.filter, slots);
    const todayStr = C.toDateStr(new Date());
    const targets = week.map((d) => (state.settings.dailyTargetHours[d.date.getDay()] || 0) * C.HOUR_MS);
    if (!week.some((d) => d.dateStr === state.chartSelected)) state.chartSelected = null;
    const selected = week.findIndex((d) => d.dateStr === state.chartSelected);
    const weekTotal = week.reduce((sum, d) => sum + d.total, 0);
    const activeDays = week.filter((d) => d.total > 0).length;
    const average = activeDays ? weekTotal / activeDays : 0;
    const by = state.settings.breakdownBy;
    const bd = C.breakdown(state.log, selected >= 0 ? [week[selected].dateStr] : week.map((d) => d.dateStr), state.filter, by);

    // Keep the shown week in the trend window; otherwise end it at this week.
    const thisWeek = currentWeekStart();
    const trendEnd = state.weekStart < C.addDays(thisWeek, -7 * (TREND_WEEKS - 1))
      ? C.addDays(state.weekStart, 7 * (TREND_WEEKS - 1))
      : thisWeek;
    const trend = C.weekTotals(state.log, trendEnd, TREND_WEEKS, state.filter);

    // Redrawing every few seconds (a running timer) would restart hover and
    // focus for nothing, so only redraw when something visible changed.
    const animate = state.animateCharts && state.loaded;
    const key = JSON.stringify([width, state.settings, filterSignature, todayStr, +state.weekStart, selected,
      week.map((d) => d.segments), trend.map((t) => t.total), bd, state.breakdownExpanded, [...slots]]);
    if (key === insightsKey && !animate) return;
    insightsKey = key;
    if (animate) state.animateCharts = false;

    // Hero
    const day = selected >= 0 ? week[selected] : null;
    $('heroLabel').textContent = day ? `${LONG_DAY_NAMES[day.date.getDay()]}, ${shortDate(day.date)}` : weekTitle();
    $('heroValue').textContent = fmt(day ? day.total : weekTotal);
    $('showWeekBtn').hidden = !day;
    if (day) {
      const target = targets[selected];
      $('heroSub').textContent = `${target ? `${Math.round((day.total / target) * 100)}% of ${fmt(target)} target` : 'No target this day'} · Week ${fmt(weekTotal)}`;
    } else {
      const parts = [activeDays ? `Daily average ${fmt(average)}` : 'Nothing tracked yet'];
      const cmp = C.compareWithPreviousWeek(state.log, state.weekStart, state.filter);
      if (cmp && cmp.previous > 0) {
        const change = Math.round(((cmp.current - cmp.previous) / cmp.previous) * 100);
        const period = cmp.days < 7 ? 'same days last week' : 'the week before';
        parts.push(change === 0 ? `Same as ${period}` : `${change > 0 ? '↑' : '↓'} ${Math.abs(change)}% vs ${period}`);
      } else if (cmp && cmp.current > 0) {
        parts.push('Nothing tracked the week before');
      }
      $('heroSub').textContent = parts.join(' · ');
    }

    // Week chart
    const weekHost = $('weekChart');
    const refocusWeek = focusedHit(weekHost);
    const maxIndex = week.reduce((best, d, i) => (d.total > week[best].total ? i : best), 0);
    const capIndex = selected >= 0 ? selected : maxIndex;
    const weekTip = (i) => {
      const d = week[i];
      const future = d.dateStr > todayStr;
      return [
        h('div', { class: 'ts-tip-value', text: future ? 'Not yet' : fmt(d.total) }),
        h('div', { class: 'ts-tip-label', text: C.formatDayHeading(d.date) }),
        ...[...d.segments].reverse().map((s) => tipRow('ts-tip-key', seriesColor(slots, s.key), projectName(s.key), fmt(s.ms))),
        targets[i] > 0 && tipRow('ts-key-tick', null, 'Target', fmt(targets[i])),
      ];
    };
    const weekCtl = TimesheetCharts.columnChart(weekHost, {
      width,
      height: 240,
      scale: C.hourScale(Math.max(...week.map((d) => d.total), ...targets)),
      formatTick: tickLabel,
      selected,
      average: activeDays > 1 ? average : null,
      animate,
      capLabel: week[capIndex].total > 0 ? { index: capIndex, text: fmt(week[capIndex].total) } : null,
      columns: week.map((d, i) => ({
        label: C.DAY_NAMES[d.date.getDay()],
        sublabel: String(d.date.getDate()),
        total: d.total,
        segments: d.segments.map((s) => ({ ...s, color: seriesColor(slots, s.key) })),
        target: targets[i],
        strong: d.dateStr === todayStr,
        muted: d.dateStr > todayStr,
        ariaLabel: `${C.formatDayHeading(d.date)}: ${fmt(d.total)}${targets[i] ? ` of ${fmt(targets[i])} target` : ''}`,
      })),
      onHover: (i, anchor) => {
        weekHover = i;
        placeTooltip($('weekTooltip'), anchor, i >= 0 ? weekTip(i) : []);
      },
      onSelect: (i) => {
        if (swiped) {
          swiped = false;
          return;
        }
        if (week[i].dateStr > todayStr) return;
        state.chartSelected = state.chartSelected === week[i].dateStr ? null : week[i].dateStr;
        state.breakdownExpanded = false;
        renderInsights();
      },
    });
    // A redraw replaces the focused column; put focus and the tooltip back
    // (focus() alone doesn't fire a focus event in every case).
    if (refocusWeek >= 0) weekCtl.focus(refocusWeek);
    if (refocusWeek >= 0 || weekHover >= 0) weekCtl.setHover(refocusWeek >= 0 ? refocusWeek : weekHover);

    // Legend: every project in the week (a single one needs no key), plus the lines.
    const keys = [...new Set(week.flatMap((d) => d.segments.map((s) => s.key)))];
    const legend = keys.length > 1
      ? keys.map((k) => h('span', { class: 'ts-legend-item' },
        h('span', { class: 'ts-swatch', style: { background: seriesColor(slots, k) } }), projectName(k)))
      : [];
    if (activeDays > 1) legend.push(h('span', { class: 'ts-legend-item' }, h('span', { class: 'ts-key-line' }), 'Daily average'));
    if (targets.some((t) => t > 0)) legend.push(h('span', { class: 'ts-legend-item' }, h('span', { class: 'ts-key-tick' }), 'Target'));
    $('weekLegend').replaceChildren(...legend);

    renderBreakdown(bd, slots, day);

    // 12-week trend: the week on screen in color, the others gray.
    const trendHost = $('trendChart');
    const refocusTrend = focusedHit(trendHost);
    const weekTarget = state.settings.dailyTargetHours.reduce((a, b) => a + b, 0) * C.HOUR_MS;
    const shown = trend.findIndex((t) => +t.weekStart === +state.weekStart);
    const slot = (width - 40) / TREND_WEEKS;
    const every = slot >= 52 ? 1 : slot >= 30 ? 2 : 3;
    const tracked = trend.filter((t) => t.total > 0);
    $('trendSub').textContent = tracked.length
      ? `Average ${fmt(tracked.reduce((s, t) => s + t.total, 0) / tracked.length)} per week${weekTarget ? ` · target ${fmt(weekTarget)}` : ''}`
      : '';
    const trendCtl = TimesheetCharts.columnChart(trendHost, {
      width,
      height: 170,
      scale: C.hourScale(Math.max(...trend.map((t) => t.total), weekTarget)),
      formatTick: tickLabel,
      average: weekTarget || null,
      animate,
      capLabel: shown >= 0 && trend[shown].total > 0 ? { index: shown, text: fmt(trend[shown].total) } : null,
      columns: trend.map((t, i) => ({
        label: (TREND_WEEKS - 1 - i) % every === 0 ? shortDate(t.weekStart) : '',
        total: t.total,
        segments: [{ key: 'week', ms: t.total, color: i === shown ? 'var(--ts-series-1)' : 'var(--ts-series-other)' }],
        strong: i === shown,
        ariaLabel: `Week of ${shortDate(t.weekStart)}: ${fmt(t.total)}`,
      })),
      onHover: (i, anchor) => {
        trendHover = i;
        placeTooltip($('trendTooltip'), anchor, i >= 0 ? [
          h('div', { class: 'ts-tip-value', text: fmt(trend[i].total) }),
          h('div', { class: 'ts-tip-label', text: `Week of ${shortDate(trend[i].weekStart)}` }),
          weekTarget > 0 && tipRow('ts-key-line', null, 'Target', fmt(weekTarget)),
        ] : []);
      },
      onSelect: (i) => setWeek(trend[i].weekStart),
    });
    if (refocusTrend >= 0) trendCtl.focus(refocusTrend);
    if (refocusTrend >= 0 || trendHover >= 0) trendCtl.setHover(refocusTrend >= 0 ? refocusTrend : trendHover);
  };

  const renderBreakdown = (bd, slots, day) => {
    const by = state.settings.breakdownBy;
    $('breakdownTitle').textContent = day ? C.formatDayHeading(day.date) : weekTitle();
    for (const btn of document.querySelectorAll('[data-by]')) btn.setAttribute('aria-checked', String(btn.dataset.by === by));
    $('breakdownNote').hidden = !(by === 'tag' && bd.overlapping);

    if (!bd.items.length) {
      $('breakdownList').replaceChildren(h('div', { class: 'ts-muted ts-small', text: 'No time tracked' }));
      return;
    }
    const shown = state.breakdownExpanded ? bd.items : bd.items.slice(0, BREAKDOWN_LIMIT);
    const rows = shown.map((item) => {
      const color = by === 'tag' ? 'var(--ts-series-1)' : seriesColor(slots, by === 'project' ? item.key : item.projectKey);
      const label = by === 'project' ? projectName(item.key)
        : by === 'tag' && item.key !== C.NO_TAG ? item.label || (state.tagsById[item.key] || {}).title || 'Unnamed tag'
          : item.label;
      const pct = bd.total ? (item.ms / bd.total) * 100 : 0;
      return h('div', { class: 'ts-bd-row' },
        h('div', { class: 'ts-bd-name' },
          by !== 'tag' && h('span', { class: 'ts-swatch', style: { background: color } }),
          h('span', { class: 'ts-bd-label', text: label, title: label })),
        h('div', { class: 'ts-bd-time', text: fmt(item.ms) }),
        h('div', { class: 'ts-bd-pct', text: pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%` }),
        h('div', { class: 'ts-bd-track', 'aria-hidden': 'true' },
          h('div', { class: 'ts-bd-fill', style: { width: `${Math.min(100, pct)}%`, background: color } })));
    });
    if (bd.items.length > BREAKDOWN_LIMIT) {
      rows.push(h('button', {
        type: 'button',
        class: 'ts-btn ts-btn-quiet ts-bd-more',
        dataset: { action: 'toggle-breakdown' },
        text: state.breakdownExpanded ? 'Show fewer' : `Show ${bd.items.length - BREAKDOWN_LIMIT} more`,
      }));
    }
    $('breakdownList').replaceChildren(...rows);
  };

  // The filters sit in a popover, so the button shows what's active: a count,
  // the accent color, and the filter names in its tooltip.
  const renderFilterButton = () => {
    const selected = (select) => (select.selectedOptions[0] || {}).textContent || '';
    const active = [];
    if (state.filter.projectId !== 'all') active.push(`Project: ${selected($('projectFilter'))}`);
    if (state.filter.tagId !== 'all') active.push(`Tag: ${selected($('tagFilter'))}`);
    const btn = $('filterBtn');
    btn.classList.toggle('is-active', active.length > 0);
    btn.title = active.length ? active.join(' · ') : 'Filter by project or tag';
    btn.setAttribute('aria-label', active.length ? `Filter, ${active.length} active` : 'Filter');
    $('filterCount').textContent = String(active.length);
    $('filterCount').hidden = !active.length;
    $('clearFiltersBtn').hidden = !active.length;
  };

  const setFilterOpen = (open) => {
    $('filterPopover').hidden = !open;
    $('filterBtn').setAttribute('aria-expanded', String(open));
    if (open) $('projectFilter').focus();
  };

  const render = () => {
    renderFilters();
    renderFilterButton();
    $('rangeLabel').textContent = C.formatRange(state.weekStart);
    $('nextWeek').disabled = state.weekStart >= currentWeekStart();
    const chart = state.settings.view === 'chart';
    for (const tab of document.querySelectorAll('[data-view]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === state.settings.view));
    }
    $('sheetView').hidden = chart;
    $('chartView').hidden = !chart;
    if (chart) renderInsights();
    else renderSheet();
    $('statusLine').textContent = state.loaded ? '' : 'Loading…';
  };

  const scrollToToday = () => {
    const card = document.querySelector('.ts-day.is-today');
    if (card && state.settings.view === 'sheet') card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const setWeek = (weekStart) => {
    state.weekStart = weekStart;
    state.chartSelected = null;
    state.breakdownExpanded = false;
    state.animateCharts = true;
    render();
  };

  // View and breakdown choices: stored with the settings, without a message.
  const setPreference = (key, value) => {
    if (state.settings[key] === value) return;
    state.settings = C.coerceSettings({ ...state.settings, [key]: value });
    state.userRevision++;
    scheduleSave(2000);
  };

  // ---------- Editing ----------

  // Saves an edit made here right away and reports how it went.
  const commitUserChange = async (message) => {
    state.userRevision++;
    render();
    const saved = await saveNow();
    snack(saved ? message : 'Saved here, but not stored yet. Timesheet will retry.', saved ? 'SUCCESS' : 'ERROR');
  };

  const ensureStorage = () => {
    if (state.storageReady) return true;
    snack('Timesheet is still loading its saved data. Try again in a moment.', 'ERROR');
    return false;
  };

  let editing = null; // { id, date } while editing an existing entry

  const setEntryError = (message) => {
    $('entryError').textContent = message;
    $('entryError').hidden = !message;
  };

  const openEntryDialog = ({ id = null, date = C.toDateStr(new Date()) } = {}) => {
    if (!ensureStorage()) return;
    const entry = id ? state.log.entries[id] : null;
    if (id && !C.isEditable(entry)) return;
    editing = entry ? { id, date } : null;
    const titleEditable = !entry || entry.isManual;

    $('entryTitleHeading').textContent = entry ? 'Edit entry' : 'Add entry';
    $('entrySub').textContent = !entry
      ? 'Stored in the timesheet only. Your Super Productivity tasks are not changed.'
      : entry.isManual
        ? 'A manual entry, stored in the timesheet only.'
        : 'This task was deleted in Super Productivity. Its hours are kept here, and you can correct or remove them.';

    const projects = projectOptions();
    if (entry && entry.projectId && !projects.some((p) => p.id === entry.projectId)) {
      projects.push({ id: entry.projectId, title: entry.projectTitle || 'Unknown project' });
    }
    $('entryProject').replaceChildren(
      h('option', { value: '', text: 'No project' }),
      ...projects.map((p) => h('option', { value: p.id, text: p.title })),
    );

    $('entryTitle').value = entry ? entry.title : '';
    $('entryTitle').disabled = !titleEditable;
    $('entryProject').value = (entry && entry.projectId) || '';
    $('entryProject').disabled = !titleEditable;
    $('entryDate').value = date;
    $('entryDuration').value = entry ? C.toDurationInput(entry.byDate[date] || 0) : '';
    const deleteBtn = $('entryDeleteBtn');
    deleteBtn.hidden = !entry;
    deleteBtn.textContent = 'Delete';
    delete deleteBtn.dataset.armed;
    setEntryError('');

    $('entryDialog').showModal();
    (titleEditable ? $('entryTitle') : $('entryDuration')).focus();
  };

  const saveEntry = () => {
    const date = $('entryDate').value;
    const ms = C.parseDuration($('entryDuration').value);
    const title = $('entryTitle').value.trim();
    const projectId = $('entryProject').value || null;
    const project = projectId ? projectOptions().find((p) => p.id === projectId) : null;
    const fullProject = projectId ? state.projectsById[projectId] : null;
    const isManual = !editing || state.log.entries[editing.id].isManual;

    if (!C.DATE_RE.test(date)) return setEntryError('Pick a date.');
    if (!(ms > 0) || ms > C.MAX_ENTRY_MS) return setEntryError('Enter a time between 1m and 24h, for example 2h35m.');
    if (isManual && !title) return setEntryError('Give the entry a title.');

    const details = {
      title,
      projectId,
      projectTitle: project ? project.title : null,
      projectColor: fullProject && fullProject.theme ? fullProject.theme.primary : null,
    };
    const ok = editing
      ? C.updateEntry(state.log, editing.id, { fromDate: editing.date, toDate: date, ms, ...details })
      : !!C.addManualEntry(state.log, { ...details, date, ms }, newManualId);
    if (!ok) return setEntryError('That entry could not be saved.');

    $('entryDialog').close();
    commitUserChange(editing ? 'Entry updated' : 'Entry added');
  };

  const deleteEntry = () => {
    const btn = $('entryDeleteBtn');
    if (!btn.dataset.armed) {
      btn.dataset.armed = 'true';
      btn.textContent = 'Click again to delete';
      return;
    }
    if (editing && C.removeEntryDay(state.log, editing.id, editing.date)) {
      $('entryDialog').close();
      commitUserChange('Entry deleted');
    }
  };

  // ---------- Settings ----------

  const openSettings = () => {
    if (!ensureStorage()) return;
    const s = state.settings;
    $('weekStartSelect').value = String(s.weekStartsOn);
    $('timeFormatSelect').value = s.timeFormat;
    $('showSubtasksInput').checked = s.showSubtasks;
    $('debugLoggingInput').checked = s.debugLogging;
    const order = Array.from({ length: 7 }, (_, i) => (s.weekStartsOn + i) % 7);
    $('targetsList').replaceChildren(...order.map((day) => h('label', { class: 'ts-target' },
      C.DAY_NAMES[day],
      h('input', {
        type: 'number',
        min: '0',
        max: '24',
        step: '0.25',
        inputmode: 'decimal',
        value: String(s.dailyTargetHours[day]),
        dataset: { day: String(day) },
      }))));
    $('settingsDialog').showModal();
  };

  const saveSettings = () => {
    const targets = [...state.settings.dailyTargetHours];
    for (const input of $('targetsList').querySelectorAll('input')) {
      targets[Number(input.dataset.day)] = input.value === '' ? 0 : Number(input.value);
    }
    state.settings = C.coerceSettings({
      ...state.settings,
      weekStartsOn: Number($('weekStartSelect').value),
      dailyTargetHours: targets,
      timeFormat: $('timeFormatSelect').value,
      showSubtasks: $('showSubtasksInput').checked,
      debugLogging: $('debugLoggingInput').checked,
    });
    state.weekStart = C.startOfWeek(state.weekStart, state.settings.weekStartsOn);
    $('settingsDialog').close();
    commitUserChange('Settings saved');
  };

  // ---------- Export ----------

  // The iframe is sandboxed without downloads, so plugin.js (which runs in the
  // app itself) saves the file and answers with the result.
  const requestDownload = (filename, data) => new Promise((resolve) => {
    const requestId = newManualId();
    const finish = (result) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(result);
    };
    const onMessage = (event) => {
      const msg = event.data;
      if (event.source !== window.parent || !msg || msg.type !== 'SP_TIMESHEET_DOWNLOAD_RESULT' || msg.requestId !== requestId) return;
      finish({ ok: msg.ok === true, error: msg.error });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'No answer from plugin.js' }), DOWNLOAD_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'SP_TIMESHEET_DOWNLOAD', requestId, filename, data }, '*');
  });

  const exportCsv = async () => {
    const btn = $('exportBtn');
    const dates = C.weekDates(state.weekStart).map(C.toDateStr);
    const filename = `timesheet-${dates[0]}-to-${dates[6]}.csv`;
    btn.disabled = true;
    try {
      const result = await requestDownload(filename, C.buildCsv(state.log, dates, state.filter));
      if (result.ok) snack(`Exported ${filename}`);
      else {
        reportError('export failed', result.error);
        snack('Export failed. The developer console has details.', 'ERROR');
      }
    } finally {
      btn.disabled = false;
    }
  };

  // ---------- Events ----------

  const wireEvents = () => {
    $('prevWeek').addEventListener('click', () => setWeek(C.addDays(state.weekStart, -7)));
    $('nextWeek').addEventListener('click', () => {
      const next = C.addDays(state.weekStart, 7);
      // Nothing is tracked in the future, so stop at the current week.
      if (next <= currentWeekStart()) setWeek(next);
    });
    $('todayBtn').addEventListener('click', () => {
      setWeek(currentWeekStart());
      scrollToToday();
    });
    $('projectFilter').addEventListener('change', (e) => {
      state.filter.projectId = e.target.value;
      render();
    });
    $('tagFilter').addEventListener('change', (e) => {
      state.filter.tagId = e.target.value;
      render();
    });
    $('filterBtn').addEventListener('click', () => setFilterOpen($('filterPopover').hidden));
    $('clearFiltersBtn').addEventListener('click', () => {
      state.filter.projectId = 'all';
      state.filter.tagId = 'all';
      $('projectFilter').value = 'all';
      $('tagFilter').value = 'all';
      render();
      $('projectFilter').focus();
    });
    // Close the popover on a click outside it, or on Escape.
    document.addEventListener('click', (e) => {
      if (!$('filterPopover').hidden && !e.target.closest('.ts-filter')) setFilterOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || $('filterPopover').hidden) return;
      setFilterOpen(false);
      $('filterBtn').focus();
    });
    $('exportBtn').addEventListener('click', exportCsv);
    $('addEntryBtn').addEventListener('click', () => openEntryDialog());
    $('settingsBtn').addEventListener('click', openSettings);

    for (const tab of document.querySelectorAll('[data-view]')) {
      tab.addEventListener('click', () => {
        setPreference('view', tab.dataset.view);
        state.animateCharts = true;
        render();
      });
    }
    for (const btn of document.querySelectorAll('[data-by]')) {
      btn.addEventListener('click', () => {
        setPreference('breakdownBy', btn.dataset.by);
        state.breakdownExpanded = false;
        renderInsights();
      });
    }
    $('breakdownList').addEventListener('click', (e) => {
      if (!e.target.closest('[data-action="toggle-breakdown"]')) return;
      state.breakdownExpanded = !state.breakdownExpanded;
      renderInsights();
    });
    $('showWeekBtn').addEventListener('click', () => {
      state.chartSelected = null;
      renderInsights();
    });

    // Swipe the week chart sideways to change week, as on a phone.
    let swipeStart = null;
    $('weekChart').addEventListener('pointerdown', (e) => {
      swipeStart = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY };
    });
    $('weekChart').addEventListener('pointerup', (e) => {
      if (!swipeStart) return;
      const dx = e.clientX - swipeStart.x;
      const dy = e.clientY - swipeStart.y;
      swipeStart = null;
      if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
      swiped = true; // the click that follows isn't a tap on a day
      setTimeout(() => { swiped = false; }, 400);
      if (dx > 0) setWeek(C.addDays(state.weekStart, -7));
      else if (C.addDays(state.weekStart, 7) <= currentWeekStart()) setWeek(C.addDays(state.weekStart, 7));
    });

    // Charts are drawn at their real pixel width, so redraw when it changes.
    if (typeof ResizeObserver === 'function') {
      let lastWidth = 0;
      new ResizeObserver(() => {
        const width = $('weekChart').clientWidth;
        if (width && width !== lastWidth && state.settings.view === 'chart') {
          lastWidth = width;
          renderInsights();
        }
      }).observe($('chartView'));
    }
    $('collapseAllBtn').addEventListener('click', () => {
      const dates = C.weekDates(state.weekStart).map(C.toDateStr);
      const collapse = dates.some((d) => !state.collapsed.has(d));
      for (const d of dates) {
        if (collapse) state.collapsed.add(d);
        else state.collapsed.delete(d);
      }
      render();
    });

    const days = $('daysContainer');
    days.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-toggle-date]');
      if (toggle) {
        const date = toggle.dataset.toggleDate;
        const collapsed = !state.collapsed.has(date);
        if (collapsed) state.collapsed.add(date);
        else state.collapsed.delete(date);
        toggle.closest('.ts-day').classList.toggle('collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
        updateCollapseAllLabel();
        return;
      }
      const add = e.target.closest('[data-add-date]');
      if (add) return openEntryDialog({ date: add.dataset.addDate });
      const row = e.target.closest('[data-edit-id]');
      if (row) openEntryDialog({ id: row.dataset.editId, date: row.dataset.editDate });
    });
    days.addEventListener('keydown', (e) => {
      const row = e.target.closest('[data-edit-id]');
      if (row && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openEntryDialog({ id: row.dataset.editId, date: row.dataset.editDate });
      }
    });

    $('entryForm').addEventListener('input', () => setEntryError(''));
    $('entryForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveEntry();
    });
    $('entryDeleteBtn').addEventListener('click', deleteEntry);
    $('settingsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveSettings();
    });
    for (const btn of document.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () => btn.closest('dialog').close());
    }
    for (const dialog of document.querySelectorAll('dialog')) {
      // Clicking the backdrop closes the dialog.
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close();
      });
    }

    // The view can be torn down at any time; get pending changes out first.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow();
    });
    window.addEventListener('pagehide', () => saveNow());
  };

  // ---------- Start ----------

  // The host injects window.PluginAPI into this iframe, but it can arrive
  // after this script starts running.
  const waitForApi = () => new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (window.PluginAPI) resolve(window.PluginAPI);
      else if (Date.now() - started > API_WAIT_MS) reject(new Error('PluginAPI was not injected'));
      else setTimeout(check, 25);
    };
    check();
  });

  const boot = async (api) => {
    state.api = api;
    const dark = !(api.cfg && api.cfg.theme === 'light');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    // Chart colors have separate light and dark steps (styles.css).
    document.documentElement.classList.toggle('ts-dark', dark);
    state.store = C.createStore(api);
    debug('storage mode:', state.store.keyed ? 'keyed' : 'single blob');

    await loadSaved();
    state.weekStart = currentWeekStart();
    render();

    wantFull = true;
    await runRefresh();
    // Hooks only after the first refresh, so nothing can start a second
    // refresh alongside it.
    registerHooks();
    state.loaded = true;
    render();
    scrollToToday();
    // Snapshot right away (this also lands a 1.x migration).
    saveNow();

    setInterval(() => requestRefresh(), POLL_MS);
  };

  wireEvents();
  render(); // the empty week shows immediately, before any data arrives
  waitForApi()
    .then(boot)
    .catch((err) => {
      reportError('could not start', err);
      $('statusLine').textContent = 'Could not connect to Super Productivity.';
    });
})();
