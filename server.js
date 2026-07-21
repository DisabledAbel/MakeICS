'use strict';

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
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(requestUrl.pathname);
  } catch (err) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (decodedPathname.includes('..') || decodedPathname.includes('\0')) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const normalizedPath = path.normalize(decodedPathname);
  const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.replace(/^\//, '');
  const filePath = path.resolve(publicDir, relativePath);

  // Robust path-traversal check using path.relative
  const relative = path.relative(publicDir, filePath);
  const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
  if (isOutside) {
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

function validateQueryParams(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    for (const [key, val] of requestUrl.searchParams.entries()) {
      if (key.includes('\0')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Parameter name contains invalid null bytes.` }));
        return false;
      }

      if (typeof val !== 'string') continue;

      let maxLen = 120;
      if (key === 'tz' || key === 'timezone') maxLen = 50;
      else if (key === 'since') maxLen = 30;
      else if (key === 'type') maxLen = 30;
      else if (key === 'format') maxLen = 10;
      else if (key === 'teamId') maxLen = 50;

      if (val.length > maxLen) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Parameter '${key}' exceeds maximum length of ${maxLen} characters.` }));
        return false;
      }

      if (key === 'q' || key === 'show') {
        if (/[\0\r\n]/.test(val)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Parameter '${key}' contains invalid or unsafe characters.` }));
          return false;
        }
      } else {
        if (/[\0\r\n<>`$]/.test(val)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Parameter '${key}' contains invalid or unsafe characters.` }));
          return false;
        }
      }
    }
    return true;
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request URL.' }));
    return false;
  }
}

async function handleRoute(handler, req, res) {
  try {
    await handler(req, res);
  } catch (err) {
    console.error('Error handling route:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
    }
  }
}

const server = http.createServer((req, res) => {
  const url = req.url || '';
  if (url.startsWith('/api/')) {
    if (!validateQueryParams(req, res)) {
      return;
    }
  }

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
  handleRoute(serveStatic, req, res);
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
