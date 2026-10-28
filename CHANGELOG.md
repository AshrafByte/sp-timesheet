# Changelog

## 2.0.1

### Fixed
- Super Productivity logged an error each time it loaded the plugin: the plugin added its own sidebar entry, so the one the app adds for it was rejected as a duplicate. The entry now comes from the app and shows the plugin's icon.

## 2.0.0

Rewrite of 1.x, with its saved data migrated automatically.

### Fixed
- Subtask time was counted twice (once on the subtask, once in the parent, which already includes it). Day and week totals were too high for any task with subtasks.
- When fetching archived tasks failed, every archived task was marked deleted.
- A day's time removed from a task in Super Productivity stayed in the timesheet.
- Moving a manual entry to another date left a copy on the old date.
- If loading saved data failed at startup, the next save replaced the stored history (manual entries, deleted tasks) with only the live tasks. Saving now waits for a successful load.
- A deleted subtask's hours dropped out of totals once Super Productivity recomputed its parent.
- Moving an entry onto a day it already had time on replaced that time; now the two are added.

### Changed
- Storage is split into one key per month (on apps that support keyed storage), so a running timer rewrites one small key instead of the whole history. A very busy month is split further to stay under the host's 256 KB limit per write. Saves only write keys that changed.
- Saving no longer overwrites what another device saved: each month is read again before it's written and merged entry by entry when it changed. A device on its first run waits a minute before saving. Data from a newer version of the plugin is never overwritten, and edits that would land in it are refused.
- Edits that failed to save are kept and saved before the next reload, instead of being replaced by it.
- If many logged tasks disappear at once (the archive can come back empty after a load error), they're only marked deleted after a second check a minute later.
- "Today" follows Super Productivity's *Start of next day* setting.
- The view used last is remembered per device and no longer synced.
- Rows of tasks that still exist in Super Productivity are read-only. Editing them used to be overwritten by the next refresh.
- The plugin no longer has permission to delete tasks. The manifest now lists every API it uses, including `getAppState` for the app's week start and start of day.
- Debug output is off unless enabled in settings. The storage debug line is gone.
- The released `index.html` is minified, which keeps it under the 100 KB limit of older Super Productivity versions. The build refuses to produce anything larger. The build is reproducible, so the release can be checked against the source.
- New installs follow Super Productivity's first day of the week. Existing settings are kept.
- Super Productivity's built-in "Today" tag is no longer shown.

### Added
- **Insights view**: the week as stacked columns per day (colored by project) with a daily-average line and target marks; tap a day to focus on it; progress toward the weekly target with a pace marker, plus average per active day, time left, days on target and the change against the same days of last week; a breakdown by project, tag or task; and the last 12 weeks against the weekly target. Hover and keyboard tooltips, swipe to change week, light and dark palettes checked for color-blind separation.
- CSV export of the visible week, with filters applied.
- "No project" filter. Tag filters also match subtasks.
- Time format setting (`3h 45m` or `3.75h`) and a setting to hide subtask rows.
- Week start on any weekday, or following Super Productivity's setting.
- Setting for which view opens: the one used last, Timesheet, or Insights.
- Backup and restore (⚙ › Backup). Restoring only adds what's missing.
- Keyboard access to rows, native dialogs (Esc closes them), progress bars announced to screen readers, and focus rings in the accent color.
- With reduced motion turned on in the system, charts and progress bars don't animate and opening the view jumps to today instead of scrolling.

### Removed
- **Auto-delete finished tasks.** It ran only while the Timesheet view was open, so in practice it deleted done tasks the next time you opened the view. It went ahead even when saving the tasks' hours had failed. Super Productivity's *Finish Day* already archives done tasks with their time kept, and Timesheet reads archived tasks.

## 1.0.0

First version (not published).
