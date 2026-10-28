import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './load-core.mjs';

const C = loadCore();
const H = C.HOUR_MS;
const ALL = { projectId: 'all', tagId: 'all' };

const task = (id, timeSpentOnDay, extra = {}) => ({
  id, title: id, projectId: null, tagIds: [], subTaskIds: [], parentId: null, timeSpentOnDay, ...extra,
});
const logOf = (tasks, opts) => {
  const log = C.emptyLog();
  C.mergeLiveTasks(log, tasks, opts);
  return log;
};

const MON = new Date(2026, 9, 26);
const day = (offset) => C.toDateStr(C.addDays(MON, offset));

test('settings: view and breakdown are validated', () => {
  assert.equal(C.coerceSettings({}).view, 'sheet');
  assert.equal(C.coerceSettings({ view: 'chart', breakdownBy: 'tag' }).view, 'chart');
  assert.equal(C.coerceSettings({ view: 'pie' }).view, 'sheet');
  assert.equal(C.coerceSettings({ breakdownBy: 'tag' }).breakdownBy, 'tag');
  assert.equal(C.coerceSettings({ breakdownBy: 'x' }).breakdownBy, 'project');
});

test('project colors follow all-time totals, not the week or filter on screen', () => {
  const log = logOf([
    task('a', { [day(-30)]: 10 * H }, { projectId: 'big' }),
    task('b', { [day(0)]: 3 * H }, { projectId: 'small' }),
    task('c', { [day(0)]: 1 * H }),
  ]);
  const slots = C.assignProjectSlots(log);
  assert.equal(slots.get('big'), 0);
  assert.equal(slots.get('small'), 1);
  assert.equal(slots.get(C.NO_PROJECT), 2);
});

test('with more than eight projects the tail shares "Other"', () => {
  const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, { [day(0)]: (10 - i) * H }, { projectId: `p${i}` }));
  const slots = C.assignProjectSlots(logOf(tasks));
  assert.equal(slots.size, 7);
  assert.equal(slots.has('p6'), true);
  assert.equal(slots.has('p7'), false);
  const eight = C.assignProjectSlots(logOf(tasks.slice(0, 8)));
  assert.equal(eight.size, 8, 'eight projects all get a color');
});

test('weekChart stacks counted time by project, in slot order, without double counting subtasks', () => {
  const log = logOf([
    task('parent', { [day(0)]: 3 * H }, { projectId: 'p1', subTaskIds: ['s'] }),
    task('s', { [day(0)]: 3 * H }, { projectId: 'p1', parentId: 'parent' }),
    task('x', { [day(0)]: H, [day(2)]: 2 * H }, { projectId: 'p2' }),
  ]);
  const slots = C.assignProjectSlots(log);
  const week = C.weekChart(log, MON, ALL, slots);
  assert.equal(week.length, 7);
  assert.equal(week[0].total, 4 * H);
  assert.deepEqual(week[0].segments, [{ key: 'p1', ms: 3 * H }, { key: 'p2', ms: H }]);
  assert.equal(week[1].total, 0);
  assert.deepEqual(week[1].segments, []);
  assert.equal(week[2].total, 2 * H);
});

test('weekChart respects filters', () => {
  const log = logOf([
    task('a', { [day(0)]: H }, { projectId: 'p1' }),
    task('b', { [day(0)]: 2 * H }, { projectId: 'p2' }),
  ]);
  const week = C.weekChart(log, MON, { projectId: 'p2', tagId: 'all' }, C.assignProjectSlots(log));
  assert.equal(week[0].total, 2 * H);
  assert.deepEqual(week[0].segments.map((s) => s.key), ['p2']);
});

test('weekTotals returns consecutive weeks, oldest first', () => {
  const log = logOf([task('a', { [day(-7)]: H, [day(-6)]: H, [day(0)]: 3 * H, [day(6)]: H })]);
  const weeks = C.weekTotals(log, MON, 3, ALL);
  assert.deepEqual(weeks.map((w) => C.toDateStr(w.weekStart)), [day(-14), day(-7), day(0)]);
  assert.deepEqual(weeks.map((w) => w.total), [0, 2 * H, 4 * H]);
});

test('week comparison uses the same days of the previous week', () => {
  const log = logOf([task('a', { [day(-7)]: H, [day(-6)]: H, [day(-5)]: 5 * H, [day(0)]: 3 * H })]);
  // "Today" is Tuesday: compare Mon–Tue with last Mon–Tue.
  const cmp = C.compareWithPreviousWeek(log, MON, ALL, C.addDays(MON, 1));
  assert.deepEqual(cmp, { current: 3 * H, previous: 2 * H, days: 2 });
  assert.equal(C.compareWithPreviousWeek(log, C.addDays(MON, 7), ALL, MON), null, 'a future week has nothing to compare');
  assert.equal(C.compareWithPreviousWeek(log, MON, ALL, C.addDays(MON, 30)).days, 7);
});

test('weekProgress: pace counts targets through today; days on target skip 0h days', () => {
  const targets = [0, 8, 8, 8, 8, 8, 0]; // Sun..Sat
  const log = logOf([
    task('a', { [day(0)]: 9 * H, [day(1)]: 3 * H, [day(5)]: 2 * H }), // Mon over, Tue short, Sat extra
  ]);
  // Wednesday: Mon–Wed are "so far".
  const wed = C.weekProgress(log, MON, ALL, targets, C.addDays(MON, 2));
  assert.equal(wed.total, 14 * H);
  assert.equal(wed.target, 40 * H);
  assert.equal(wed.pace, 24 * H);
  assert.equal(wed.daysWithTarget, 3);
  assert.equal(wed.daysOnTarget, 1);
  assert.equal(wed.activeDays, 3);
  assert.equal(wed.average, (14 / 3) * H);

  // After the week: pace is the whole target; the 0h Saturday doesn't count as a day with a target.
  const later = C.weekProgress(log, MON, ALL, targets, C.addDays(MON, 10));
  assert.equal(later.pace, later.target);
  assert.equal(later.daysWithTarget, 5);
  assert.equal(later.daysOnTarget, 1);
});

test('weekProgress with no targets and no time', () => {
  const p = C.weekProgress(C.emptyLog(), MON, ALL, [0, 0, 0, 0, 0, 0, 0], C.addDays(MON, 3));
  assert.deepEqual(p, { total: 0, target: 0, pace: 0, activeDays: 0, average: 0, daysWithTarget: 0, daysOnTarget: 0 });
});

test('breakdown by project and by task', () => {
  const log = logOf([
    task('a', { [day(0)]: H, [day(1)]: H }, { projectId: 'p1' }),
    task('b', { [day(0)]: 3 * H }, { projectId: 'p2' }),
    task('c', { [day(1)]: H }),
  ], { projectsById: { p1: { title: 'One' }, p2: { title: 'Two' } } });
  const days = [day(0), day(1)];

  const byProject = C.breakdown(log, days, ALL, 'project');
  assert.equal(byProject.total, 6 * H);
  assert.deepEqual(byProject.items.map((i) => [i.label, i.ms]), [['Two', 3 * H], ['One', 2 * H], ['No project', H]]);

  const byTask = C.breakdown(log, days, ALL, 'task');
  assert.deepEqual(byTask.items.map((i) => [i.key, i.ms, i.projectKey]), [['b', 3 * H, 'p2'], ['a', 2 * H, 'p1'], ['c', H, C.NO_PROJECT]]);
});

test('breakdown by tag: subtask time carries its own and its parent\'s tags; overlap is reported', () => {
  const log = logOf([
    task('parent', { [day(0)]: 3 * H }, { tagIds: ['work'], subTaskIds: ['s1', 's2'] }),
    task('s1', { [day(0)]: 2 * H }, { parentId: 'parent', tagIds: ['deep'] }),
    task('s2', { [day(0)]: H }, { parentId: 'parent' }),
    task('loose', { [day(0)]: H }),
  ], { tagsById: { work: { title: 'Work' }, deep: { title: 'Deep' } } });

  const result = C.breakdown(log, [day(0)], ALL, 'tag');
  assert.equal(result.total, 4 * H, 'the total is real time, not the sum of overlapping tags');
  assert.equal(result.overlapping, true);
  assert.deepEqual(result.items.map((i) => [i.key, i.label, i.ms]), [
    ['work', 'Work', 3 * H],
    ['deep', 'Deep', 2 * H],
    [C.NO_TAG, 'No tag', H],
  ]);
  assert.equal(C.breakdown(log, [day(1)], ALL, 'tag').items.length, 0);
});

test('hourScale picks readable steps', () => {
  const hours = (scale) => ({ max: scale.max / H, ticks: scale.ticks.map((t) => t / H) });
  assert.deepEqual(hours(C.hourScale(0)), { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
  assert.deepEqual(hours(C.hourScale(5.2 * H)), { max: 6, ticks: [0, 2, 4, 6] });
  assert.deepEqual(hours(C.hourScale(8 * H)), { max: 8, ticks: [0, 2, 4, 6, 8] });
  assert.deepEqual(hours(C.hourScale(41 * H)), { max: 48, ticks: [0, 12, 24, 36, 48] });
  assert.deepEqual(hours(C.hourScale(9 * H, 3)), { max: 9, ticks: [0, 3, 6, 9] });
});
