# Timesheet for Super Productivity

A weekly timesheet of the time you track in [Super Productivity](https://super-productivity.com).

- **One card per day**: what you worked on (task, project, tags, time), with a progress bar toward that day's target hours.
- **Week summary**: total, weekly target, average per active day.
- **Manual entries** for work done away from the app: calls, meetings, travel.
- **Hours stay on record** after a task is deleted in Super Productivity. The row is marked *deleted* and keeps counting.
- **CSV export** of the visible week, with the project and tag filters applied.
- A compact header: week, view switch, and on the right a Filter button (project, including "No project", and tag; it shows how many are active), export, settings and Add. A tag filter also matches subtasks.
- Follows the app's light and dark theme. Works at phone width.

### Insights

Switch from **Timesheet** to **Insights** at the top for a picture of the week:

- **The week as stacked columns**, one per day, colored by project, with a dashed daily-average line and a mark at each day's target. Hover or focus a day for its breakdown.
- **Tap a day** to focus on it: the other days fade, and the headline shows that day's total and how close you got to its target. Tap it again, or *Show whole week*, to go back.
- **Progress toward the weekly target**: the week's total against its target, with a bar and a pace marker showing where you'd be if every day so far had met its target ("12h 40m behind pace"). Below it: average per active day, time left to target, days on target so far, and the change against the same days of the previous week. A selected day shows its own target progress instead.
- **Breakdown** of the week or the selected day by project, tag or task, as proportional bars with time and share.
- **Last 12 weeks** as weekly totals against your weekly target. Click a week to jump to it.
- Swipe the week chart sideways on a touchscreen to change week. Arrow keys move between days.

A project keeps its color across weeks and filters. Colors go to the projects with the most tracked time overall, from a palette checked for color-blind separation in both themes. With more than eight projects, the smaller ones share "Other".

## Install

From the app: **Settings → Plugins → Community Plugins → Timesheet → Install** (once listed).

By hand: download `sp-timesheet-vX.Y.Z.zip` from [Releases](https://github.com/AshrafByte/sp-timesheet/releases), then **Settings → Plugins → Choose Plugin File**. The plugin adds **Timesheet** to the sidebar.

**Updating:** upload the new zip the same way, over the installed plugin. **Don't remove the plugin first.** Removing a plugin in Super Productivity deletes its saved data, on every device that syncs. Download a backup (⚙ › Backup) before big changes.

## How the numbers work

- Super Productivity stores tracked time per task per day. Timesheet shows exactly that. There are no start and end times because the app doesn't record them.
- A parent task's time already includes its subtasks, so totals count the parent once. Subtasks are listed under their parent as detail. You can turn this off in settings. If a subtask is deleted, its hours still count.
- Time on tasks that still exist comes from Super Productivity and is edited there. Manual entries and deleted tasks can be edited or removed in the timesheet. Moving an entry onto a day where it already has time adds the two.
- "Today" follows Super Productivity's *Start of next day* setting, so a day that ends at 4 am in the app ends at 4 am here too.
- Timesheet can only keep hours it has seen. A task deleted before Timesheet was ever opened can't be recovered.

## Settings

The ⚙ button:

- **Week starts on**: any weekday, or *Same as Super Productivity*, which follows the app's *First day of week* (or your locale when the app is on *System default*). New installs follow the app.
- **Open on**: the view used last on this device, or always Timesheet, or always Insights.
- Target hours per weekday, time format (`3h 45m` or `3.75h`), whether subtasks are listed, and debug logging.
- **Backup**: download all of Timesheet's data as a file, or restore from one. Restoring adds entries and days the timesheet doesn't have and applies the backup's settings; it never removes anything.

## Data and privacy

Everything stays in Super Productivity's own plugin storage and syncs with the rest of your data. There are no network requests. The plugin reads tasks, projects, tags and the app's settings, and never changes or deletes them.

Storage is split into one key per month (more for a very busy month, since a single write is limited to 256 KB), so a running timer only rewrites the current month. Apps older than the keyed storage API keep everything in a single entry instead. Data from Timesheet 1.x is migrated on first start; on newer apps the 1.x entry is left in place as a backup.

### How saved data is protected

- **Other devices.** Before writing a month, Timesheet reads it again. If another device changed it, the two are merged entry by entry instead of one overwriting the other. A device opening Timesheet for the first time waits a minute before saving, so sync can bring in data from other devices first.
- **Newer versions.** Data written by a newer version of Timesheet is never overwritten or merged into. Timesheet shows a notice, and edits that would land in that data are refused with a message instead of being lost.
- **Failed saves.** Nothing is saved until saved data has loaded successfully. Edits that couldn't be saved are kept and retried, and saved again before any reload.
- **Changes in Super Productivity.** A task whose tracked time is missing or in an unknown format keeps its logged hours. If many logged tasks disappear at once, for example when the archive fails to load (the app then reports no archived tasks), Timesheet checks again a minute later before marking them deleted.

## Development

Needs Node 20 or newer. The only dependency is esbuild, which the build uses for minifying; it is pinned to an exact version.

```bash
npm ci          # once: install the pinned esbuild
npm test        # unit tests, storage tests, build checks
npm run build   # dist/: the plugin zip to install, listing entry
npm run dev     # build, then serve on http://localhost:5178
```

- `http://localhost:5178/dist/dev.html` runs the view against a mock API with sample data and a running timer. Options: `?theme=light`, `?host=old` (no keyed storage), `?seed=v1` (start from 1.x data), `?reset=1`, `?timer=0`, `?firstDay=0..6` and `?dayStart=HH:MM` (the app's settings). `window.__mock` in the console can delete tasks, finish the day, or simulate a sync from another device.
- `http://localhost:5178/dist/dev-release.html` is the same with the minified release code.
- `http://localhost:5178/dev/host.html` runs the built `plugin.js` in a stand-in app window, which covers CSV export and backups. Add `?release=1` for the release code.

**Size limit.** Super Productivity versions before the 1 MB limit ([#10578](https://github.com/super-productivity/super-productivity/issues/10578)) reject an `index.html` over 100 KB, so the release copy is minified, local names included. The build stops with an error above 100 KB and warns above 90 KB. To read the shipped code, rebuild it from source (below) or open `dist/dev.html`.

### Layout

| Path | What it is |
| --- | --- |
| `src/manifest.json` | Plugin manifest. The version here is the only version. |
| `src/core.js` | Logic with no DOM or API access: dates, durations, the time log, chart data, CSV, storage. |
| `src/charts.js` | SVG column charts, drawn from plain data. |
| `src/app.js` | The view: fetching, saving, rendering, dialogs. |
| `src/index.html`, `src/styles.css` | Markup and styles. The build inlines CSS and JS into `index.html`. |
| `src/plugin.js` | Runs in the app: the sidebar entry and saving exported files (CSV, backups). |
| `scripts/` | Build, zip writer, dev server. |
| `dev/` | Mock API and host harness, never shipped. |
| `tests/` | `node --test` suites. |

### Releasing

1. Bump `version` in `src/manifest.json`, add a `CHANGELOG.md` entry, then `npm test`.
2. `npm ci && npm run build`. The zip is reproducible: the same source and the pinned esbuild give the same SHA-256, so a reviewer can rebuild it and compare.
3. Create release `vX.Y.Z` on GitHub and attach `dist/sp-timesheet-vX.Y.Z.zip`.
4. Open a PR to [super-productivity](https://github.com/super-productivity/super-productivity) that adds or updates the entry in `src/assets/community-plugins.json` with the contents of `dist/community-plugins-entry.json`.

## License

MIT. See [LICENSE](LICENSE).
