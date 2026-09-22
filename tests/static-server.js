// Zero-dependency static file server for the local test run.
//
// `npm run test:local` needs index.html served over http:// rather than
// file://, because the page's scripts and the Playwright assertions both
// assume a real origin. Playwright's `webServer` block in
// playwright.config.local.js starts this and tears it down again.
//
// Deliberately not a dependency (serve/http-server): the repo's only
// devDependency today is Playwright itself, and a test helper is not worth
// adding a package to the install for.
//
// NOTE: /api/ask does not exist here. That is why the local config runs the
// UI suite only - ai.spec.js needs the deployed Netlify function.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  let full = path.resolve(ROOT, rel);

  // Mirror the clean-URL rewrites in netlify.toml: /issues serves issues.html.
  // Without this the local suite would have to use .html paths that production
  // never sees, and a broken link would only show up after deploy.
  if (!path.extname(rel) && fs.existsSync(full + '.html')) {
    rel += '.html';
    full += '.html';
  }

  // Never serve outside the repo, whatever the request path claims.
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel);
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('static server: http://127.0.0.1:' + PORT + ' (root: ' + ROOT + ')');
});
