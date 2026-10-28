// Builds the plugin:
//   dist/sp-timesheet-vX.Y.Z.zip  the plugin: install it with Settings → Plugins →
//                                 Choose Plugin File, or attach it to a release
//   dist/sp-timesheet/            the same files unzipped, for reading
//   dist/community-plugins-entry.json  the entry for Super Productivity's listing
//   dist/dev.html                 the view with a mock PluginAPI, for the browser
//   dist/dev-release.html         the same with the minified release code
//
// index.html in src/ is a template: <!-- @inline file --> is replaced by that
// file from src/ (as <style> or <script>), and <!-- @dev file --> by a file
// from dev/ in dist/dev.html only.
//
// Super Productivity before the 1 MB limit (#10578) rejects an index.html over
// 100 KB, so the release copy has comments and whitespace removed (esbuild,
// pinned in package-lock.json). Names are kept, so it still reads as the
// source. dist/dev.html is not minified.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { createZip } from './zip.mjs';

const MAX_INDEX_HTML = 100 * 1024;
const WARN_INDEX_HTML = 90 * 1024;

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const tag = (file, content) => {
  if (file.endsWith('.css')) return `<style>\n${content}</style>`;
  if (/<\/script/i.test(content)) throw new Error(`${file} contains "</script", which would end the inline script early`);
  return `<script>\n${content}</script>`;
};

const minify = async (file, code) => (await transform(code, {
  loader: file.endsWith('.css') ? 'css' : 'js',
  minifyWhitespace: true,
  minifySyntax: false,
  minifyIdentifiers: false,
  legalComments: 'none',
  charset: 'utf8',
  target: file.endsWith('.css') ? ['chrome100', 'safari15'] : 'es2020',
})).code;

// Indentation and blank lines only; the markup has no <pre> or <textarea>.
const compactHtml = (html) => html.replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n');

const MARKER_RE = /^[ \t]*<!-- @(inline|dev) ([\w.-]+) -->[ \t]*\r?\n?/gm;
const sourcePath = (kind, name) => `${kind === 'dev' ? 'dev' : 'src'}/${name}`;

const template = await read('src/index.html');
const contents = {};
const minified = {};
for (const [, kind, name] of template.matchAll(MARKER_RE)) {
  const path = sourcePath(kind, name);
  contents[path] = await read(path);
  if (kind === 'inline') minified[path] = await minify(name, contents[path]);
}

// A replacer function, so "$" in the inlined code is never read as a pattern.
const renderHtml = ({ mock, minify: min }) => (min ? compactHtml(template) : template).replace(MARKER_RE, (_, kind, name) => {
  if (kind === 'dev' && !mock) return '';
  const path = sourcePath(kind, name);
  return `${tag(name, min && kind === 'inline' ? minified[path] : contents[path])}\n`;
});

const manifest = JSON.parse(await read('src/manifest.json'));
const pkg = JSON.parse(await read('package.json'));

const problems = [];
if (!/^[a-z0-9-]+$/.test(manifest.id || '')) problems.push('manifest.id must be lowercase letters, digits and dashes');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) problems.push('manifest.version must be numeric x.y.z (the listing requires it)');
if (!Array.isArray(manifest.hooks) || !Array.isArray(manifest.permissions)) problems.push('manifest.hooks and manifest.permissions must be arrays');
if (problems.length) {
  console.error(problems.map((p) => `✖ ${p}`).join('\n'));
  process.exit(1);
}

const html = renderHtml({ mock: false, minify: true });
const devHtml = renderHtml({ mock: true, minify: false });
// The release code with the mock, to check the minified build in a browser.
const devReleaseHtml = renderHtml({ mock: true, minify: true });

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const htmlBytes = Buffer.byteLength(html);
if (htmlBytes > MAX_INDEX_HTML) {
  console.error(`✖ index.html is ${kb(htmlBytes)}; Super Productivity rejects more than ${kb(MAX_INDEX_HTML)}`);
  process.exit(1);
}
if (htmlBytes > WARN_INDEX_HTML) {
  console.warn(`⚠ index.html is ${kb(htmlBytes)}, close to the ${kb(MAX_INDEX_HTML)} limit of older app versions`);
}

const files = [
  { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
  { name: 'plugin.js', data: Buffer.from(await read('src/plugin.js')) },
  { name: 'index.html', data: Buffer.from(html) },
  { name: 'icon.svg', data: Buffer.from(await read('src/icon.svg')) },
];

const dist = new URL('dist/', root);
await rm(dist, { recursive: true, force: true });
await mkdir(new URL(`${manifest.id}/`, dist), { recursive: true });
for (const { name, data } of files) await writeFile(new URL(`${manifest.id}/${name}`, dist), data);
await writeFile(new URL('dev.html', dist), devHtml);
await writeFile(new URL('dev-release.html', dist), devReleaseHtml);

const zipName = `${manifest.id}-v${manifest.version}.zip`;
const zip = createZip(files);
await writeFile(new URL(zipName, dist), zip);
const sha256 = createHash('sha256').update(zip).digest('hex');

const repo = String(pkg.repository?.url || '').replace(/\.git$/, '');
const entry = {
  name: manifest.name,
  shortDescription: 'Weekly timesheet and charts of your tracked time: days by project, a 12-week trend, daily targets, manual entries, CSV export, and hours kept after a task is deleted.',
  url: repo,
  author: pkg.author,
  authorUrl: repo.replace(/\/[^/]+$/, ''),
  id: manifest.id,
  release: {
    version: manifest.version,
    downloadUrl: `${repo}/releases/download/v${manifest.version}/${zipName}`,
    sha256,
  },
};
await writeFile(new URL('community-plugins-entry.json', dist), `${JSON.stringify(entry, null, 2)}\n`);

console.log(`✓ ${manifest.name} ${manifest.version}`);
console.log(`  dist/${zipName}  ${kb(zip.length)}  ← install this (Settings → Plugins → Choose Plugin File)`);
console.log(`  index.html ${kb(htmlBytes)} of the ${kb(MAX_INDEX_HTML)} limit`);
console.log(`  sha256 ${sha256}`);
console.log(`  dist/${manifest.id}/          the same files unzipped`);
console.log('  dist/community-plugins-entry.json');
console.log('  dist/dev.html, dev-release.html  open via `npm run dev`');
