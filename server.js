import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import episodesHandler from './api/episodes.js';
import searchHandler from './api/search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const port = Number.parseInt(process.env.PORT || '3000', 10);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const normalizedPath = path.normalize(decodeURIComponent(requestUrl.pathname)).replace(/^\.\.(\/|\\|$)/, '');
  const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.slice(1);
  const filePath = path.join(publicDir, relativePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const contents = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    res.end(contents);
  } catch {
    const contents = await fs.readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(contents);
  }
}

const server = http.createServer((req, res) => {
  const url = req.url || '';
  if (url.startsWith('/api/episodes')) {
    episodesHandler(req, res);
    return;
  }
  if (url.startsWith('/api/search')) {
    searchHandler(req, res);
    return;
  }
  if (url.startsWith('/api/sports-search')) {
    import('./api/sports-search.js').then((m) => m.default(req, res));
    return;
  }
  if (url.startsWith('/api/sports-events')) {
    import('./api/sports-events.js').then((m) => m.default(req, res));
    return;
  }
  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`MakeICS TV Episodes running at http://localhost:${port}`);
});
