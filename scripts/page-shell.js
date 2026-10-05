// Page shell for the multi-page site.
//
// Every generated page is: shell(head) + shared nav + the page's own <main> +
// shared footer + shared script. Only the `content` argument differs per page,
// so a change to the chrome is one edit rather than nine.
//
//   generatePageShell({ title, activePage, content, description, ... }) -> HTML
//
// DEPENDENCY, not yet satisfied: the shell links /styles.css and /app.js as
// external files. Today both live inline inside index.html — roughly 1,300
// lines of CSS and 400 of JS. They must be extracted before any page is
// generated, or nine pages will each carry their own copy of the stylesheet
// and the nav drawer will have no behaviour. See extractionRequired() below.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Required lazily inside generatePageShell, not at module load. build.js
// requires this file while it is still executing, so a top-level destructure
// here would capture its exports before they are assigned.
const buildMod = () => require('./build');

const ROOT = path.resolve(__dirname, '..');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const SITE_NAME = 'The Pelham Engagement Project';
// Canonical host. The netlify.app address still serves the site, but it is
// the deploy URL, not the public one — canonical and og:url must name the
// domain we want indexed or the two compete for the same content.
const SITE_URL = 'https://pelhamengagementproject.org';

// The shell assumes these exist at the publish root. Checked explicitly so the
// failure is a clear message rather than nine pages that render unstyled.
// Cache-busting: /styles.css and /app.js are linked with a short hash of
// their contents, so a page can never be paired with an older copy of either.
// Without it, a browser holding the previous app.js ran new markup with old
// behaviour -- the signup form fell back to a native submit and reloaded the
// page. The hash changes only when the file does, so the build stays
// idempotent; editing either file without rebuilding fails build:check.
function assetUrl(file) {
  const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, file))).digest('hex').slice(0, 10);
  return `/${file}?v=${hash}`;
}

function extractionRequired() {
  const missing = ['styles.css', 'app.js'].filter(
    (f) => !fs.existsSync(path.join(ROOT, f)),
  );
  return missing;
}

/**
 * @param {object}  o
 * @param {string}  o.title        page title, without the site-name suffix
 * @param {string}  o.activePage   pages.json id, or null if not in the nav
 * @param {string}  o.content      the page's own markup, placed inside <main>
 * @param {object}  o.data         parsed content/*.json, as phase1() returns
 * @param {string} [o.description] meta description; falls back to the site's
 * @param {string} [o.canonical]   absolute URL for rel=canonical
 * @param {string} [o.bodyClass]   extra class on <body> for page-specific CSS
 * @param {string} [o.headExtra]   additional <head> markup (rare)
 */
function generatePageShell(o) {
  const {
    title, activePage, content, data,
    description = 'Public information about local government in Pelham, NY — meetings, elections, taxes and how to take part.',
    canonical = null,
    bodyClass = '',
    headExtra = '',
  } = o;

  const fullTitle = activePage === 'home' ? SITE_NAME : `${title} · ${SITE_NAME}`;
  const { generateNav, generateFooter, makeResolver } = buildMod();
  const nav = generateNav(activePage, data);

  // The footer is a function call, not a BUILD anchor. splice() requires each
  // anchor to appear exactly once in a file, which holds for one index.html
  // but breaks the moment nine pages each carry a BUILD:footer — and the
  // anchors would be pointless here anyway, since these pages are generated
  // whole rather than patched in place.
  const footer = generateFooter(data, o.resolve || makeResolver(data.facts));

  // Shared CTA, on every content page. Skipped on home, which already has the
  // Ask box itself, and on the Ask page, where it would link to itself.
  const NO_CTA = new Set(['home', 'ask-ai']);
  const askCta = NO_CTA.has(activePage) ? '' : `
<aside class="ask-cta">
  <div class="content-wrap">
    <span class="ask-cta-text">Have a question about Pelham government?</span>
    <a class="ask-cta-link" href="/ask">Ask Pelham AI →</a>
  </div>
</aside>
`;

  // Floating "Ask AI" button, bottom right, on every page except the Ask page
  // itself. A plain link to /ask, so it works without JavaScript; app.js only
  // tucks it away while the footer is on screen so it never covers the
  // footer's links.
  const askFab = activePage === 'ask-ai' ? '' : `
<a class="ask-fab" href="/ask" aria-label="Ask Pelham AI"><svg class="ask-fab-ico" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/><path d="M8.5 10.5h7M8.5 13.5h4.5"/></svg><span class="ask-fab-text">Ask AI</span></a>
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n` : ''}<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">\n` : ''}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${assetUrl('styles.css')}">
${headExtra}</head>
<body${bodyClass ? ` class="${esc(bodyClass)}"` : ''}>

${nav}

<main id="main">
${content}
${askCta}</main>

<footer>
  <p><strong>The Pelham Engagement Project</strong> — An independent resource for Pelham, NY residents.</p>
  <p class="footer-feedback">See something wrong or have a suggestion? <a href="/about#feedback">Share feedback →</a></p>
${footer}
</footer>
${askFab}
<script src="${assetUrl('app.js')}" defer></script>
</body>
</html>
`;
}

module.exports = { generatePageShell, extractionRequired, SITE_NAME, SITE_URL };
