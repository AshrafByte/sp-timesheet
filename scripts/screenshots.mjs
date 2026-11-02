// Regenerates the README screenshots in docs/images/ from the dev build, with
// the busy demo dataset (dev/demo.js) and headless Chrome or Edge:
//
//   npm run build && node scripts/screenshots.mjs [name…]
//
// Set CHROME to the browser executable if it isn't found. Shots are taken at
// 2x for sharp text; the README shows them at half size.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'docs', 'images');
const PORT = 5199;

const SHOTS = {
  'insights-dark': { size: [1280, 1330], query: 'shot=insights' },
  'insights-light': { size: [1280, 1330], query: 'shot=insights&theme=light' },
  'timesheet-dark': { size: [1280, 1180], query: 'shot=timesheet' },
  'day-selected-light': { size: [1280, 1200], query: 'shot=insights-day&theme=light' },
  // Narrower, so the popover and dialogs stay readable in the README grid.
  'filter-dark': { size: [800, 600], query: 'shot=filter' },
  'settings-dark': { size: [800, 920], query: 'shot=settings' },
  'entry-light': { size: [800, 600], query: 'shot=entry&theme=light' },
  // Desktop browsers won't open a window narrower than about 500px, so the
  // phone screens are iframes on a transparent page.
  phones: { size: [862, 762], page: 'dev/phones.html', query: 'shot=insights', transparent: true },
};

const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) {
  console.error('No Chrome or Edge found. Set CHROME to its executable.');
  process.exit(1);
}

const capture = (name, { size, query, page, transparent }, profile) => new Promise((resolve, reject) => {
  const url = page
    ? `http://localhost:${PORT}/${page}?${query}`
    : `http://localhost:${PORT}/dist/dev.html?demo=busy&reset=1&timer=0&firstDay=1&${query}`;
  execFile(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-prefers-reduced-motion',
    ...(transparent ? ['--default-background-color=00000000'] : []),
    `--user-data-dir=${profile}`,
    '--force-device-scale-factor=2',
    `--window-size=${size[0]},${size[1]}`,
    '--virtual-time-budget=15000',
    `--screenshot=${join(out, `${name}.png`)}`,
    url,
  ], { timeout: 60000 }, (err) => (err ? reject(err) : resolve()));
});

const server = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
try {
  await new Promise((r) => setTimeout(r, 800));
  await mkdir(out, { recursive: true });
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
  for (const name of names) {
    if (!SHOTS[name]) throw new Error(`Unknown shot: ${name}`);
    const profile = await mkdtemp(join(tmpdir(), 'timesheet-shot-'));
    try {
      await capture(name, SHOTS[name], profile);
      console.log(`✓ docs/images/${name}.png`);
    } finally {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }
} finally {
  server.kill();
}
