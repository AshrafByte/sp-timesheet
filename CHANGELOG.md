# Changelog

## 2.0.0

Rewrite of 1.x, with its saved data migrated automatically.

### Fixed
- Subtask time was counted twice (once on the subtask, once in the parent, which already includes it). Day and week totals were too high for any task with subtasks.
- When fetching archived tasks failed, every archived task was marked deleted.
- A day's time removed from a task in Super Productivity stayed in the timesheet.
- Moving a manual entry to another date left a copy on the old date.
- If loading saved data failed at startup, the next save replaced the stored history (manual entries, deleted tasks) with only the live tasks. Saving now waits for a successful load.

### Changed
- Storage is split into one key per month (on apps that support keyed storage), so a running timer rewrites one small key instead of the whole history. Saves only write keys that changed, and no longer read back every write.
- Rows of tasks that still exist in Super Productivity are read-only. Editing them used to be overwritten by the next refresh.
- The plugin no longer has permission to delete tasks.
- Debug output is off unless enabled in settings. The storage debug line is gone.
- The released `index.html` has comments and whitespace removed, which keeps it under the 100 KB limit of older Super Productivity versions (75 KB now). The build refuses to produce anything larger.
- Default first day of the week for new installs is Monday. Existing settings are kept.
- Super Productivity's built-in "Today" tag is no longer shown.

### Added
- **Insights view**: the week as stacked columns per day (colored by project) with a daily-average line and target marks; tap a day to focus on it; progress toward the weekly target with a pace marker, plus average per active day, time left, days on target and the change against the same days of last week; a breakdown by project, tag or task; and the last 12 weeks against the weekly target. Hover and keyboard tooltips, swipe to change week, light and dark palettes checked for color-blind separation.
- CSV export of the visible week, with filters applied.
- "No project" filter. Tag filters also match subtasks.
- Time format setting (`3h 45m` or `3.75h`) and a setting to hide subtask rows.
- Week starting on Saturday.
- Keyboard access to rows, native dialogs (Esc closes them), progress bars announced to screen readers.

### Removed
- **Auto-delete finished tasks.** It ran only while the Timesheet view was open, so in practice it deleted done tasks the next time you opened the view. It went ahead even when saving the tasks' hours had failed. Super Productivity's *Finish Day* already archives done tasks with their time kept, and Timesheet reads archived tasks.

## 1.0.0

First version (not published).
