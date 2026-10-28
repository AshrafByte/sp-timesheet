/*
 * Development only: a busy, realistic dataset for screenshots and demos, and
 * scripted view states for capturing them. dist/dev.html loads this before
 * mock-api.js, which uses it when the URL has ?demo=busy.
 *   ?demo=busy        twelve weeks of work across nine projects
 *   ?shot=<state>     timesheet | insights (last week) | insights-day | filter | settings | entry
 * Once a shot is set up, <html data-shot="ready"> is set.
 */
const TimesheetDemo = (() => {
  'use strict';

  const H = 3600000;
  const M = 60000;

  const projects = [
    { id: 'p-northwind', title: 'Northwind Redesign', theme: { primary: '#e8505b' } },
    { id: 'p-api', title: 'Platform API', theme: { primary: '#3b82f6' } },
    { id: 'p-mobile', title: 'Mobile App', theme: { primary: '#14b8a6' } },
    { id: 'p-ops', title: 'Operations', theme: { primary: '#a855f7' } },
    { id: 'p-hiring', title: 'Hiring', theme: { primary: '#f59e0b' } },
    { id: 'p-research', title: 'Research', theme: { primary: '#22c55e' } },
    { id: 'p-oss', title: 'Open Source', theme: { primary: '#64748b' } },
    { id: 'p-learning', title: 'Learning', theme: { primary: '#ec4899' } },
    { id: 'p-admin', title: 'Admin', theme: { primary: '#94a3b8' } },
  ];

  const tags = [
    { id: 'TODAY', title: 'Today' },
    { id: 't-deep', title: 'Deep work' },
    { id: 't-meeting', title: 'Meeting' },
    { id: 't-review', title: 'Review' },
    { id: 't-bug', title: 'Bug' },
    { id: 't-urgent', title: 'Urgent' },
    { id: 't-pairing', title: 'Pairing' },
  ];

  // [key, title, project, tags, weight]
  const pool = [
    ['checkout', 'Checkout redesign', 'p-northwind', ['t-deep'], 6],
    ['nw-review', 'Design review with Northwind', 'p-northwind', ['t-meeting'], 2],
    ['nw-a11y', 'Accessibility pass on forms', 'p-northwind', ['t-review'], 2],
    ['nw-demo', 'Prepare sprint demo', 'p-northwind', [], 1],
    ['api-rate', 'Rate limiting middleware', 'p-api', ['t-deep'], 4],
    ['api-page', 'Fix pagination in /orders', 'p-api', ['t-bug', 't-urgent'], 3],
    ['api-spec', 'OpenAPI spec for v2', 'p-api', ['t-deep'], 3],
    ['api-cr', 'Code review: auth refactor', 'p-api', ['t-review'], 2],
    ['api-index', 'Database index tuning', 'p-api', ['t-pairing'], 2],
    ['mob-sync', 'Offline sync spike', 'p-mobile', ['t-deep'], 3],
    ['mob-crash', 'Crash on Android 14 startup', 'p-mobile', ['t-bug', 't-urgent'], 2],
    ['mob-push', 'Push notification settings', 'p-mobile', [], 2],
    ['ops-incident', 'Incident follow-up: queue backlog', 'p-ops', ['t-urgent'], 2],
    ['ops-certs', 'Rotate staging certificates', 'p-ops', [], 1],
    ['ops-runbook', 'Update on-call runbook', 'p-ops', [], 1],
    ['hire-interview', 'Interview: senior frontend', 'p-hiring', ['t-meeting'], 2],
    ['hire-review', 'Review take-home submissions', 'p-hiring', ['t-review'], 1],
    ['res-vector', 'Evaluate vector search options', 'p-research', ['t-deep'], 2],
    ['oss-triage', 'Triage date-picker issues', 'p-oss', [], 1],
    ['oss-pr', 'Review PR: keyboard navigation', 'p-oss', ['t-review'], 1],
    ['learn-rust', 'Rust ownership course', 'p-learning', [], 1],
    ['admin-plan', 'Weekly planning', 'p-admin', ['t-meeting'], 1],
    ['admin-expenses', 'Expense report', 'p-admin', [], 1],
  ];
  const checkoutSubtasks = [
    ['payment', 'Payment step layout'],
    ['address', 'Address form validation'],
    ['summary', 'Order summary component'],
  ];

  const build = ({ dayStr }) => {
    let seed = 20261028;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const totalWeight = pool.reduce((s, p) => s + p[4], 0);
    const pick = () => {
      let r = rand() * totalWeight;
      for (const p of pool) if ((r -= p[4]) < 0) return p;
      return pool[0];
    };

    const tasks = new Map();
    const bucketOf = (offset) => Math.floor((offset + 84) / 14); // a task runs for about two weeks
    const currentBucket = bucketOf(0);
    const add = (id, base, offset, ms) => {
      if (!tasks.has(id)) tasks.set(id, { ...base, id, timeSpentOnDay: {} });
      const t = tasks.get(id);
      const d = dayStr(offset);
      t.timeSpentOnDay[d] = (t.timeSpentOnDay[d] || 0) + ms;
    };
    const quarter = (minutes) => Math.max(15, Math.round(minutes / 15) * 15) * M;

    for (let offset = -84; offset <= 0; offset++) {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      const weekday = date.getDay();
      if (weekday === 0) continue;
      const saturday = weekday === 6;
      if (saturday && rand() > 0.3) continue;
      const bucket = bucketOf(offset);
      const done = bucket < currentBucket;
      // Today is still in progress.
      let budget = offset === 0 ? 4.4 * H : saturday ? (1 + rand()) * H : (6.5 + rand() * 2.5) * H;

      if (!saturday) {
        add(`standup-${bucket}`, { title: 'Daily standup', projectId: 'p-admin', tagIds: ['t-meeting'], isDone: done }, offset, 15 * M);
        budget -= 15 * M;
      }
      while (budget > 10 * M) {
        const [key, title, projectId, tagIds] = pick();
        const ms = Math.min(budget, quarter(20 + rand() * 120));
        budget -= ms;
        if (key === 'checkout') {
          const [subKey, subTitle] = checkoutSubtasks[Math.floor(rand() * checkoutSubtasks.length)];
          add(`checkout-${subKey}-${bucket}`, { title: subTitle, projectId, tagIds: [], parentId: `checkout-${bucket}`, isDone: done }, offset, ms);
          add(`checkout-${bucket}`, { title, projectId, tagIds, isDone: done }, offset, ms);
        } else {
          add(`${key}-${bucket}`, { title, projectId, tagIds: offset === 0 && key === 'api-page' ? ['TODAY', ...tagIds] : tagIds, isDone: done }, offset, ms);
        }
      }
    }

    const all = [...tasks.values()].map((t) => ({ projectId: null, tagIds: [], subTaskIds: [], parentId: null, isDone: false, ...t }));
    for (const t of all) {
      if (t.parentId) {
        const parent = all.find((p) => p.id === t.parentId);
        if (parent) parent.subTaskIds.push(t.id);
      }
    }

    // Kept only by Timesheet: manual entries and a task deleted in the app.
    const lastThursday = (() => {
      const d = new Date();
      const back = ((d.getDay() - 4 + 7) % 7) || 7;
      return -back;
    })();
    const entry = (title, projectId, byDate, extra) => {
      const project = projects.find((p) => p.id === projectId);
      return {
        title,
        projectId,
        projectTitle: project ? project.title : null,
        projectColor: project ? project.theme.primary : null,
        tags: [],
        parentId: null,
        isManual: false,
        isDeleted: false,
        byDate,
        ...extra,
      };
    };
    const monday = -(((new Date().getDay() + 6) % 7));
    const stored = {
      'manual-workshop': entry('Client workshop (on-site)', 'p-northwind', { [dayStr(lastThursday)]: 3 * H }, { isManual: true }),
      'manual-travel': entry('Travel to client office', null, { [dayStr(lastThursday)]: 90 * M }, { isManual: true }),
      'manual-call': entry('Phone call with Northwind PM', 'p-northwind', { [dayStr(monday)]: 25 * M }, { isManual: true }),
      'legacy-export': entry('Legacy CSV export script', 'p-api', { [dayStr(monday + 1)]: 105 * M }, { isDeleted: true }),
    };

    return {
      projects,
      tags,
      active: all.filter((t) => !t.isDone),
      archived: all.filter((t) => t.isDone),
      stored,
    };
  };

  // ---------- Scripted view states ----------

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (test, timeout = 20000) => {
    const start = Date.now();
    while (!test()) {
      if (Date.now() - start > timeout) throw new Error('demo: timed out');
      await delay(50);
    }
  };
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const showView = (view) => {
    const tab = document.querySelector(`[data-view="${view}"]`);
    if (tab && tab.getAttribute('aria-selected') !== 'true') click(tab);
  };
  const set = (id, value) => {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const runShot = async (name) => {
    await waitFor(() => document.querySelector('.ts-day') && document.getElementById('statusLine').textContent === '');
    await delay(300);
    switch (name) {
      case 'timesheet':
        showView('sheet');
        break;
      case 'insights':
        // Last week: a whole week of columns rather than the days so far.
        showView('chart');
        click(document.getElementById('prevWeek'));
        break;
      case 'insights-day': {
        showView('chart');
        await delay(700);
        const tuesday = [...document.querySelectorAll('#weekChart .ts-hit')].find((el) => /^Tue/.test(el.getAttribute('aria-label')));
        click(tuesday);
        click(document.querySelector('[data-by="task"]'));
        break;
      }
      case 'filter':
        showView('sheet');
        click(document.getElementById('filterBtn'));
        set('projectFilter', 'p-api');
        break;
      case 'settings':
        click(document.getElementById('settingsBtn'));
        break;
      case 'entry':
        showView('sheet');
        click(document.getElementById('addEntryBtn'));
        document.getElementById('entryTitle').value = 'Client workshop (on-site)';
        set('entryProject', 'p-northwind');
        document.getElementById('entryDuration').value = '3h';
        break;
      default:
        break;
    }
    await delay(900); // let charts finish growing in
    // Opening scrolls to today; make sure that has settled at the top.
    window.scrollTo({ top: 0, behavior: 'instant' });
    await delay(200);
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.documentElement.dataset.shot = 'ready';
  };

  return { build, runShot };
})();
