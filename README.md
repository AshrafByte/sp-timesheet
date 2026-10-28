# Timesheet for Super Productivity

A weekly timesheet of the time you track in [Super Productivity](https://super-productivity.com).

- **One card per day**: what you worked on (task, project, tags, time), with a progress bar toward that day's target hours.
- **Week summary**: total, weekly target, average per active day.
- **Manual entries** for work done away from the app: calls, meetings, travel.
- **Hours stay on record** after a task is deleted in Super Productivity. The row is marked *deleted* and keeps counting.
- **CSV export** of the visible week, with the project and tag filters applied.
- Filters by project (including "No project") and by tag. A tag filter also matches subtasks.
- Follows the app's light and dark theme. Works at phone width.

## Install

From the app: **Settings → Plugins → Community Plugins → Timesheet → Install** (once listed).

By hand: download `sp-timesheet-vX.Y.Z.zip` from [Releases](https://github.com/AshrafByte/sp-timesheet/releases), then **Settings → Plugins → Choose Plugin File**. The plugin adds **Timesheet** to the sidebar.

## How the numbers work

- Super Productivity stores tracked time per task per day. Timesheet shows exactly that. There are no start and end times because the app doesn't record them.
- A parent task's time already includes its subtasks, so totals count the parent once. Subtasks are listed under their parent as detail. You can turn this off in settings.
- Time on tasks that still exist comes from Super Productivity and is edited there. Manual entries and deleted tasks can be edited or removed in the timesheet.
- Timesheet can only keep hours it has seen. A task deleted before Timesheet was ever opened can't be recovered.

## Settings

The ⚙ button: first day of the week, target hours per weekday, time format (`3h 45m` or `3.75h`), whether subtasks are listed, and debug logging.

## Data and privacy

Everything stays in Super Productivity's own plugin storage and syncs with the rest of your data. There are no network requests. The plugin reads tasks, projects and tags, and never changes or deletes them.

Storage is split into one key per month, so a running timer only rewrites the current month. Apps older than the keyed storage API keep everything in a single entry instead. Data from Timesheet 1.x is migrated on first start; on newer apps the 1.x entry is left in place as a backup.

## Development

Needs Node 20 or newer. There are no dependencies to install.

```bash
npm test        # unit tests, storage tests, build checks
npm run build   # dist/: unpacked plugin, release zip, listing entry
npm run dev     # build, then serve on http://localhost:5178
```

- `http://localhost:5178/dist/dev.html` runs the view against a mock API with sample data and a running timer. Options: `?theme=light`, `?host=old` (no keyed storage), `?seed=v1` (start from 1.x data), `?reset=1`, `?timer=0`. `window.__mock` in the console can delete tasks, finish the day, or simulate a sync from another device.
- `http://localhost:5178/dev/host.html` runs the built `plugin.js` in a stand-in app window, which covers the CSV export.

### Layout

| Path | What it is |
| --- | --- |
| `src/manifest.json` | Plugin manifest. The version here is the only version. |
| `src/core.js` | Logic with no DOM or API access: dates, durations, the time log, CSV, storage. |
| `src/app.js` | The view: fetching, saving, rendering, dialogs. |
| `src/index.html`, `src/styles.css` | Markup and styles. The build inlines CSS and JS into `index.html`. |
| `src/plugin.js` | Runs in the app: the sidebar entry and saving CSV exports. |
| `scripts/` | Build, zip writer, dev server. |
| `dev/` | Mock API and host harness, never shipped. |
| `tests/` | `node --test` suites. |

### Releasing

1. Bump `version` in `src/manifest.json`, add a `CHANGELOG.md` entry, then `npm test`.
2. `npm run build`. The zip is reproducible, so rebuilding the same source gives the same SHA-256.
3. Create release `vX.Y.Z` on GitHub and attach `dist/sp-timesheet-vX.Y.Z.zip`.
4. Open a PR to [super-productivity](https://github.com/super-productivity/super-productivity) that adds or updates the entry in `src/assets/community-plugins.json` with the contents of `dist/community-plugins-entry.json`.

## License

MIT. See [LICENSE](LICENSE).
