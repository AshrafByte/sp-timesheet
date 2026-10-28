import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const build = () => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
const manifest = JSON.parse(readFileSync(new URL('src/manifest.json', root), 'utf8'));
const zipPath = new URL(`dist/${manifest.id}-v${manifest.version}.zip`, root);

// Reads the central directory: [{ name, data }]
const unzip = (buf) => {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.push({ name, data: inflateRawSync(buf.subarray(start, start + size)) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
};

test('build produces a flat, self-contained, reproducible zip', () => {
  build();
  const first = readFileSync(zipPath);
  const files = unzip(first);
  assert.deepEqual(files.map((f) => f.name).sort(), ['icon.svg', 'index.html', 'manifest.json', 'plugin.js']);

  const zipped = JSON.parse(files.find((f) => f.name === 'manifest.json').data.toString());
  assert.equal(zipped.id, manifest.id);
  assert.equal(zipped.version, manifest.version);
  assert.ok(first.length < 10 * 1024 * 1024, 'listing limit is 10 MB');

  const html = files.find((f) => f.name === 'index.html').data.toString();
  assert.doesNotMatch(html, /<!-- @(inline|dev)/, 'every marker was replaced');
  assert.doesNotMatch(html, /__mock|mock-api/, 'the dev mock is not shipped');
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/i, 'no external scripts or stylesheets');
  assert.match(html, /const TimesheetCore = /);

  build();
  const second = readFileSync(zipPath);
  assert.equal(createHash('sha256').update(second).digest('hex'), createHash('sha256').update(first).digest('hex'));

  const entry = JSON.parse(readFileSync(new URL('dist/community-plugins-entry.json', root), 'utf8'));
  assert.equal(entry.id, manifest.id);
  assert.equal(entry.release.version, manifest.version);
  assert.equal(entry.release.sha256, createHash('sha256').update(first).digest('hex'));
});

test('the inlined scripts parse', () => {
  const html = readFileSync(new URL(`dist/${manifest.id}/index.html`, root), 'utf8');
  const scripts = [...html.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 3);
  for (const code of scripts) assert.doesNotThrow(() => new Function(code));
  assert.doesNotThrow(() => new Function(readFileSync(new URL('src/plugin.js', root), 'utf8')));
});
