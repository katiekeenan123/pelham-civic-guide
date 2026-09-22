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
const SITE_URL = 'https://pelhamengagementproject.netlify.app';

// The shell assumes these exist at the publish root. Checked explicitly so the
// failure is a clear message rather than nine pages that render unstyled.
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
<link rel="stylesheet" href="/styles.css">
${headExtra}</head>
<body${bodyClass ? ` class="${esc(bodyClass)}"` : ''}>

${nav}

<main id="main">
${content}
${askCta}</main>

<footer>
  <p><strong>Pelham Civic Guide</strong> — An independent resource for Pelham, NY residents.</p>
  <p class="footer-feedback">See something wrong or have a suggestion? <a href="/about#feedback">Share feedback →</a></p>
${footer}
</footer>

<script src="/app.js" defer></script>
</body>
</html>
`;
}

module.exports = { generatePageShell, extractionRequired, SITE_NAME, SITE_URL };
