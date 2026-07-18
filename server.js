import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import episodesHandler from './api/episodes.js';
import searchHandler from './api/search.js';
import sportsSearchHandler from './api/sports-search.js';
import sportsEventsHandler from './api/sports-events.js';
import moviesSearchHandler from './api/movies-search.js';
import moviesHandler from './api/movies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, 'public');
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
  const filePath = path.resolve(publicDir, relativePath);

  const publicDirWithSlash = publicDir.endsWith(path.sep) ? publicDir : (publicDir + path.sep);
  if (filePath !== publicDir && !filePath.startsWith(publicDirWithSlash)) {
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

function handleRoute(handler, req, res) {
  Promise.resolve()
    .then(() => handler(req, res))
    .catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
      }
    });
}

const server = http.createServer((req, res) => {
  const url = req.url || '';
  if (url.startsWith('/api/episodes')) {
    handleRoute(episodesHandler, req, res);
    return;
  }
  if (url.startsWith('/api/search')) {
    handleRoute(searchHandler, req, res);
    return;
  }
  if (url.startsWith('/api/sports-search')) {
    handleRoute(sportsSearchHandler, req, res);
    return;
  }
  if (url.startsWith('/api/sports-events')) {
    handleRoute(sportsEventsHandler, req, res);
    return;
  }
  if (url.startsWith('/api/movies-search')) {
    handleRoute(moviesSearchHandler, req, res);
    return;
  }
  if (url.startsWith('/api/movies')) {
    handleRoute(moviesHandler, req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`MakeICS TV Episodes running at http://localhost:${port}`);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
  process.exit(1);
});
