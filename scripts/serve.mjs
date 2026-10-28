// Static file server for development: http://localhost:5178/dist/dev.html
// (the view on its own) and /dev/host.html (the view inside a fake app window,
// running plugin.js).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 5178;
const root = fileURLToPath(new URL('../', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(root + (path === '/' ? '/dist/dev.html' : path));
  if (!file.startsWith(normalize(root + sep))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Timesheet dev server: http://localhost:${PORT}/dist/dev.html`);
  console.log(`With plugin.js:       http://localhost:${PORT}/dev/host.html`);
});
