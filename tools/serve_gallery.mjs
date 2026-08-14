// @ts-nocheck -- static preview server for the screenshot gallery.
/**
 * Serves gallery/ for local preview. Forwards CLI host/port arguments:
 *   node tools/serve_gallery.mjs [--port 7100] [--host 127.0.0.1]
 */

import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const galleryRoot = join(root, 'gallery');

let port = 7100;
let host = '127.0.0.1';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) port = Number(argv[++i]);
  else if ((argv[i] === '--host' || argv[i] === '-h') && argv[i + 1]) host = argv[++i];
  else if (/^\d+$/.test(argv[i])) port = Number(argv[i]);
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`invalid port`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = createServer((req, res) => {
  /** @type {string} */
  let path;
  try {
    // Malformed percent-encoding makes decodeURIComponent throw URIError —
    // without this catch one bad request crashed the whole preview server.
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  if (path === '/' || path === '') path = '/index.html';
  const file = normalize(join(galleryRoot, path));
  // Bare startsWith also admits SIBLING paths like `gallery-evil/...`, because
  // `...\gallery-evil` starts with `...\gallery`. Require the separator.
  if (file !== galleryRoot && !file.startsWith(galleryRoot + sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = statSync(file).isDirectory() ? readFileSync(join(file, 'index.html')) : readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(port, host, () => {
  console.log(`gallery preview: http://${host}:${port}/`);
});
