#!/usr/bin/env node
//
// Pelham Civic Guide — single source of truth build.
//
// Reads content/*.json (+ the 18 meeting partials and prompt-template.md) and
// regenerates the parts of index.html marked with BUILD anchors, plus the
// Ask Pelham system prompt. Nothing outside an anchor is touched.
//
//   node scripts/build.js            write index.html and the system prompt
//   node scripts/build.js --check    generate in memory, exit 1 on any diff
//
// --check is the CI guard: it fails if the committed output does not match
// what the content files produce, which catches someone hand-editing
// generated HTML instead of the JSON behind it.
//
// Phases:
//   1  load + validate (ajv 2020-12), foreign keys, token resolution
//   2  generate the system prompt as a JS module
//   3  run the nine HTML generators
//   4  splice the results into index.html between its BUILD anchors
//   5  validate the output and print a summary

'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const CHECK = process.argv.includes('--check');

const p = (...s) => path.join(ROOT, ...s);
const read = (f) => fs.readFileSync(f, 'utf8');
const readJson = (f) => JSON.parse(read(f));

// Files whose content is data. Each must have a matching schema sidecar.
const DATA_FILES = [
  'facts', 'bodies', 'officials', 'issues', 'elections',
  'meetings', 'sources', 'taxes', 'quick-reference', 'hero', 'pages',
];

let errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

// Maintainer comments removed from partials on the way into index.html.
const stripped = [];

// ── html helpers ───────────────────────────────────────────────────────────
// Content fields carry a deliberate safe subset of HTML (<strong>, <em>, <a>,
// <br>), so prose is emitted raw. Only values that should never contain markup
// — URLs, ids, class fragments — go through esc().
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const indent = (block, pad) =>
  block.split('\n').map((l) => (l.trim() ? pad + l : l)).join('\n');

// Maintainer comments in the meeting partials are notes to whoever edits the
// file, not content for readers, so they are dropped on the way into
// index.html. The partial keeps them — it is the source of truth, and an
// unresolved REVIEW flag should stay visible to anyone opening that file.
//
// Matched on the comment's first word rather than a literal "<!-- REVIEW:"
// prefix: the flags in the July partials open with a newline and read
// "REVIEW FLAG - ...", so a strict prefix match would silently strip nothing.
// Leading whitespace and the colon are both optional.
const MAINTAINER_COMMENT = /<!--\s*(REVIEW|NOTE|BUILD)\b[\s\S]*?-->\n?/gi;

function stripMaintainerComments(text, file, stats) {
  return text.replace(MAINTAINER_COMMENT, (m) => {
    const kind = /<!--\s*([A-Z]+)/i.exec(m)[1].toUpperCase();
    stats.push({ file, kind });
    return '';
  });
}

// =========================================================================
// PHASE 1 — load and validate
// =========================================================================
function phase1() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  const data = {};
  for (const name of DATA_FILES) {
    const dataPath = p('content', `${name}.json`);
    const schemaPath = p('content', 'schema', `${name}.schema.json`);
    if (!fs.existsSync(schemaPath)) {
      fail(name, `no schema sidecar at content/schema/${name}.schema.json`);
      continue;
    }
    const doc = readJson(dataPath);
    const validate = ajv.compile(readJson(schemaPath));
    if (!validate(doc)) {
      for (const e of validate.errors) {
        fail(`${name}.json`, `${e.instancePath || '(root)'} ${e.message}`);
      }
    }
    data[name] = doc;
  }
  if (errors.length) return data;

  // ── foreign keys ────────────────────────────────────────────────────────
  const bodyIds = new Set(data.bodies.bodies.map((b) => b.id));
  const factIds = new Set(data.facts.facts.map((f) => f.id));

  const checkBody = (file, id, ref) => {
    if (ref && !bodyIds.has(ref)) fail(`${file}.json`, `${id} → unknown governing_body "${ref}"`);
  };
  data.officials.officials.forEach((o) => checkBody('officials', o.id, o.governing_body));
  data.meetings.meetings.forEach((m) => checkBody('meetings', m.id, m.governing_body));
  data.elections.races.forEach((r) => checkBody('elections', r.id, r.body));
  data.issues.issues.forEach((i) => i.governing_body.forEach((g) => checkBody('issues', i.id, g)));
  data['quick-reference'].entries.forEach((q) => q.governing_body.forEach((g) => checkBody('quick-reference', q.id, g)));
  data.sources.sources.forEach((s) => checkBody('sources', s.id, s.governing_body));
  data.taxes.bars.forEach((b) => checkBody('taxes', b.id, b.governing_body));
  data.taxes.explainers.forEach((e) => checkBody('taxes', e.id, e.governing_body));
  ((data.taxes.comparison || {}).entries || []).forEach((e) => checkBody('taxes', e.id, e.governing_body));

  data.bodies.bodies.forEach((b) => {
    if (b.budget && !factIds.has(b.budget.fact_ref)) {
      fail('bodies.json', `${b.id}.budget.fact_ref → unknown fact "${b.budget.fact_ref}"`);
    }
  });

  const raceIds = new Set(data.elections.races.map((r) => r.id));
  data.elections.candidates.forEach((c) => {
    if (!raceIds.has(c.race_id)) fail('elections.json', `${c.id} → unknown race_id "${c.race_id}"`);
    if (c.platform_ref) {
      const race = data.elections.races.find((r) => r.id === c.race_id);
      if (!race || !(race.shared_platforms || {})[c.platform_ref]) {
        fail('elections.json', `${c.id} → unknown platform_ref "${c.platform_ref}"`);
      }
    }
  });

  // ── meeting partials exist ──────────────────────────────────────────────
  for (const m of data.meetings.meetings) {
    if (m.status !== 'published') continue;
    for (const k of ['exec_summary_file', 'detailed_summary_file', 'transcript_file']) {
      if (!m[k]) fail('meetings.json', `${m.id}.${k} is null but status is "published"`);
      else if (!fs.existsSync(p(m[k]))) fail('meetings.json', `${m.id}.${k} → missing file ${m[k]}`);
    }
  }

  return data;
}

// ── token resolution ───────────────────────────────────────────────────────
// {{fact:<id>}} resolves to that fact's `display`. Unknown tokens are a build
// error naming the token and where it came from, never a silent passthrough.
function makeResolver(facts) {
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const used = new Map();

  // {{fact:id}} → display, {{fact:id.short}} → display_short (falling back to
  // display). The short form exists because the same fact is legitimately
  // written two ways: "November 3, 2026" in prose, "Nov 3, 2026" in a
  // voter-info box.
  const resolve = (text, where) => {
    if (typeof text !== 'string') return text;
    return text.replace(/\{\{fact:([a-z0-9-]+)(\.short)?\}\}/g, (whole, id, short) => {
      const f = byId.get(id);
      if (!f) {
        fail(where, `unresolved token ${whole}`);
        return whole;
      }
      if (!used.has(id)) used.set(id, new Set());
      used.get(id).add(where);
      return short ? (f.display_short || f.display) : f.display;
    });
  };
  resolve.used = used;
  resolve.byId = byId;
  return resolve;
}


const NL = '\n';

// Prompt blocks are plain text; content fields carry a little inline HTML.
const plain = (t) => String(t)
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();

// =========================================================================
// PHASE 2 — system prompt
// =========================================================================
function buildPrompt(data, r) {
  let t = read(p('content', 'prompt-template.md'));

  // Strip the maintainer header: everything above the first horizontal rule is
  // instructions for whoever edits the template, not for the model.
  const rule = t.indexOf('\n---\n');
  if (rule === -1) fail('prompt-template.md', 'missing the `---` divider that ends the maintainer header');
  t = rule === -1 ? t : t.slice(rule + 5).trimStart();

  const blocks = {
    'current-issues': () => {
      const out = ['The issues the site is actively tracking. Each is sourced; cite the source when you use one.'];
      for (const i of data.issues.issues) {
        out.push(`- ${plain(r(i.title, 'issues.json'))} [${i.status}: ${plain(r(i.status_label, 'issues.json'))}]`);
        out.push(`    ${plain(r(i.description, 'issues.json'))}`);
        out.push(`    Source: ${i.source_label}${i.source_date ? ` (${i.source_date})` : ''} ${i.source_url}`);
      }
      return out.join(NL);
    },

    elections: () => {
      const e = data.elections;
      const out = [`Election day ${r('{{fact:election-date-2026}}', 'elections.json')}. Races and candidates:`];
      for (const race of e.races) {
        const body = data.bodies.bodies.find((b) => b.id === race.body);
        const seats = race.show_seats === false ? '' : `, ${race.seats} seat(s)`;
        out.push(`  ${body.name} — ${race.title}${seats}, ${race.term_length}${race.badge ? ` (${race.badge})` : ''}`);
        if (race.context) out.push(`    Context: ${plain(r(race.context, 'elections.json'))}`);
        for (const c of e.candidates.filter((x) => x.race_id === race.id)) {
          const office = c.office ? ` for ${c.office}` : '';
          out.push(`    - ${c.name} (${c.party})${office}${c.incumbent ? ' — INCUMBENT' : ''}: ${plain(r(c.meta, 'elections.json'))}`);
          let sum = plain(r(c.summary, 'elections.json'));
          if (c.platform_ref) sum += ' ' + plain(r(race.shared_platforms[c.platform_ref], 'elections.json'));
          out.push(`        ${sum}`);
        }
      }
      return out.join(NL);
    },

    'processed-meetings': () => {
      const pub = data.meetings.meetings.filter((m) => m.status === 'published');
      const out = ['Meetings the site has processed and published summaries for. Point residents to the site for detail, and to the recording to verify.'];
      for (const m of pub) {
        const body = data.bodies.bodies.find((b) => b.id === m.governing_body);
        out.push(`- ${body.name}, ${m.date}${m.chair ? ` — ${m.chair}` : ''}. Recording: ${m.recording_url}`);
      }
      return out.join(NL);
    },

    'vetted-sources': () =>
      data.sources.sources.filter((s) => s.in_prompt !== false)
        .map((s) => `- ${s.domain} (${s.description})`).join('\n'),

    officials: () => {
      const out = [];
      for (const b of data.bodies.bodies) {
        const people = data.officials.officials
          .filter((o) => o.governing_body === b.id && o.in_prompt !== false);
        if (!people.length) continue;
        out.push(`  ${b.name.toUpperCase()}:`);
        for (const o of people) {
          const who = o.vacant ? 'VACANT' : o.name;
          const bits = [];
          if (o.term_end) bits.push(`term ends ${o.term_end}`);
          if (o.seat_type !== 'elected') bits.push(o.seat_type);
          const tail = bits.length ? ` (${bits.join('; ')})` : '';
          out.push(`    ${o.title}: ${who}${tail}`);
          if (o.notes) out.push(`      note: ${r(o.notes, 'officials.json')}`);
        }
      }
      return [`Current elected officials and senior staff (roster verified ${data.officials.verified}):`,
        ...out].join('\n');
    },

    'key-facts': () => {
      const cats = [...new Set(data.facts.facts.map((f) => f.category))];
      const out = [];
      for (const c of cats) {
        const rows = data.facts.facts.filter((f) => f.category === c && f.in_prompt !== false);
        if (!rows.length) continue;
        out.push(`${c.toUpperCase()}:`);
        for (const f of rows) {
          const q = f.qualifier ? ` — ${r(f.qualifier, 'facts.json')}` : '';
          const conf = f.confidence && f.confidence !== 'verified' ? ` [${f.confidence}]` : '';
          out.push(`- ${f.fact}: ${f.display}${conf}${q} (as at ${f.as_of}; source: ${f.source.name})`);
        }
        out.push('');
      }
      return out.join('\n').trimEnd();
    },

    'critical-facts': () =>
      data.facts.facts.filter((f) => f.caution)
        .map((f) => `- ${f.fact} — ${f.display}.\n  ${r(f.caution, 'facts.json')}`).join('\n'),

    'issue-cautions': () =>
      data.issues.issues.filter((i) => i.prompt_caution)
        .map((i) => `- ${i.title}\n  ${r(i.prompt_caution, 'issues.json')}`).join('\n'),

    'public-comment-by-body': () =>
      data.bodies.bodies.filter((b) => b.public_comment_process)
        .map((b) => `- ${b.name}: ${b.public_comment_process}`).join('\n'),
  };

  t = t.replace(/\{\{generated:([a-z-]+)\}\}/g, (_, name) => {
    if (!blocks[name]) {
      fail('prompt-template.md', `unknown block {{generated:${name}}}`);
      return '';
    }
    return blocks[name]();
  });

  t = r(t, 'prompt-template.md');
  return t.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ask-pelham.js gets the prompt as a required module, not a file read. Netlify's
// bundler follows `require`; it does not pick up a sibling .txt, so a
// readFileSync would work locally and throw ENOENT in the deployed function.
function writePromptModule(text) {
  const body = '// GENERATED by scripts/build.js from content/prompt-template.md\n'
    + '// and content/*.json. Do not edit — run `npm run build` instead.\n'
    + '//\n'
    + '// Shipped as a module rather than a .txt because Netlify\'s function\n'
    + '// bundler follows require() but does not include arbitrary sibling files.\n'
    + `module.exports = ${JSON.stringify(text)};\n`;
  return body;
}

// =========================================================================
// SHARED NAVIGATION
// =========================================================================
//
// One nav, rendered per page with the current item marked. Every page pulls
// from content/pages.json, so the desktop bar, the More menu and the mobile
// drawer cannot list different things — the failure mode this exists to
// prevent is a tenth page that appears in one of the three and not the others.
//
// generateNav(activePage, data) -> HTML string
//   activePage is a pages.json id ('home', 'elections', …) or null for a page
//   that is not in the nav. An unknown id is a build error rather than a nav
//   with nothing highlighted.

// A badge disappears on its own date. Emitting it conditionally at build time
// alone is not enough — the site is only rebuilt when content changes, so a
// "Nov 3" badge would sit there into December if nobody touched the content.
// It is rendered with the date attached and app.js removes it once the date
// passes, so the page self-corrects without a rebuild.
function navBadge(badge) {
  if (!badge) return '';
  return ` <span class="nav-badge" data-hide-after="${esc(badge.until)}">${esc(badge.label)}</span>`;
}

function generateNav(activePage, data) {
  const pages = data.pages.pages;

  if (activePage !== null && !pages.some((x) => x.id === activePage)) {
    fail('pages.json', `generateNav called with unknown page "${activePage}"`);
  }

  // The badge date is duplicated from elections.json by necessity — the nav
  // needs it without loading the whole elections file at runtime — so the
  // build checks the two agree rather than trusting them to.
  for (const pg of pages) {
    if (pg.badge && pg.badge.until !== data.elections.election_date) {
      fail('pages.json', `${pg.id} badge.until (${pg.badge.until}) does not match elections.election_date (${data.elections.election_date})`);
    }
  }

  const link = (pg, cls) => {
    const active = pg.id === activePage;
    const classes = [cls, active ? 'is-active' : ''].filter(Boolean).join(' ');
    const current = active ? ' aria-current="page"' : '';
    return `<a href="${esc(pg.url)}" class="${classes}"${current}>${esc(pg.label)}${navBadge(pg.badge)}</a>`;
  };

  const primary = pages.filter((x) => x.group === 'primary');
  const more = pages.filter((x) => x.group === 'more');
  const moreActive = more.some((x) => x.id === activePage);

  const out = [];
  out.push('<a class="skip-link" href="#main">Skip to content</a>');
  out.push('<nav class="nav-bar" aria-label="Primary">');
  out.push('  <div class="nav-inner">');

  // Hamburger first in source order so it is the first thing a keyboard or
  // screen-reader user reaches on small screens, where it is the only way in.
  out.push('    <button class="nav-burger" id="nav-burger" aria-label="Open menu" aria-expanded="false" aria-controls="nav-drawer">');
  out.push('      <span></span><span></span><span></span>');
  out.push('    </button>');

  out.push('    <a href="/" class="nav-brand">Pelham Engagement Project</a>');

  out.push('    <div class="nav-links">');
  for (const pg of primary) out.push(`      ${link(pg, 'nav-link')}`);
  out.push('      <div class="nav-more-wrap">');
  out.push(`        <button class="nav-link nav-more-trigger${moreActive ? ' is-active' : ''}" id="nav-more" aria-expanded="false" aria-haspopup="true" aria-controls="nav-more-menu">Learn More <span aria-hidden="true">▾</span></button>`);
  out.push('        <div class="nav-more-menu" id="nav-more-menu" role="menu">');
  for (const pg of more) {
    const active = pg.id === activePage;
    out.push(`          <a href="${esc(pg.url)}" role="menuitem" class="${active ? 'is-active' : ''}"${active ? ' aria-current="page"' : ''}><span class="nav-ico" aria-hidden="true">${pg.icon}</span>${esc(pg.label)}</a>`);
  }
  out.push('        </div>');
  out.push('      </div>');
  out.push('    </div>');
  out.push('  </div>');
  out.push('</nav>');

  // Mobile drawer. Lists every page, not just the primary five — on a phone
  // this replaces both the bar and the More menu, so hiding four pages behind
  // a second interaction would be the wrong trade.
  out.push('<div class="nav-scrim" id="nav-scrim" hidden></div>');
  out.push('<aside class="nav-drawer" id="nav-drawer" hidden aria-label="Site menu">');
  out.push('  <div class="nav-drawer-head">');
  out.push('    <span class="nav-drawer-title">Pelham Engagement Project</span>');
  out.push('    <button class="nav-drawer-close" id="nav-drawer-close" aria-label="Close menu">×</button>');
  out.push('  </div>');
  out.push('  <ul class="nav-drawer-list">');
  for (const pg of pages) {
    const active = pg.id === activePage;
    out.push(`    <li><a href="${esc(pg.url)}" class="${active ? 'is-active' : ''}"${active ? ' aria-current="page"' : ''}><span class="nav-ico" aria-hidden="true">${pg.icon}</span><span class="nav-drawer-label">${esc(pg.label)}</span>${navBadge(pg.badge)}</a></li>`);
  }
  out.push('  </ul>');
  if (data.pages.drawer_note) {
    out.push(`  <p class="nav-drawer-note">${esc(data.pages.drawer_note)}</p>`);
  }
  out.push('</aside>');

  return out.join(NL);
}

// =========================================================================
// PHASE 3 — the nine HTML generators
// =========================================================================

function generateIssueCards(data, r) {
  const shown = data.issues.issues.filter((i) => i.show_on_home !== false);
  const cards = shown.map((i) => {
    const status = `<div class="issue-status"><div class="status-dot dot-${i.status}"></div>${r(i.status_label, 'issues.json')}</div>`;
    const link = `<a href="${esc(i.source_url)}"${i.source_url.startsWith('#') ? '' : ' target="_blank"'} class="issue-source-link">${r(i.source_label, 'issues.json')}</a>`;
    return `      <div class="issue-card fade-in"><span class="issue-tag tag-${i.tag_style}">${i.tag}</span>`
      + `<h3>${r(i.title, 'issues.json')}</h3><p>${r(i.description, 'issues.json')}</p>${status}${link}</div>`;
  });
  return [`    <p class="section-intro">${r(data.issues.section_intro, 'issues.json')}</p>`,
    '    <div class="issues-grid">', ...cards, '    </div>'].join('\n');
}

function generateElections(data, r) {
  const e = data.elections;
  const out = [];
  out.push('    <div style="background: rgba(200,151,58,0.12); border: 1px solid rgba(200,151,58,0.3); border-left: 4px solid var(--gold); padding: 14px 18px; margin-bottom: 36px; font-size: 13px; color: #c8aa70; font-family: \'IBM Plex Sans\', sans-serif; line-height: 1.6;">');
  out.push(`      ${r(e.editorial_note, 'elections.json')}`);
  out.push('    </div>');
  out.push('');

  for (const race of e.races) {
    const body = data.bodies.bodies.find((b) => b.id === race.body);
    out.push('    <div class="race-block">');
    out.push('      <div class="race-header">');
    out.push('        <div class="race-meta">');
    out.push(`          <span class="race-body">${body.name}</span>`);
    // A race block covering two different offices shows no combined seat count.
    const seats = race.show_seats === false
      ? '' : ` · ${race.seats} seat${race.seats === 1 ? '' : 's'}`;
    out.push(`          <span class="race-type">${race.title}${seats} · ${race.term_length}</span>`);
    out.push('        </div>');
    if (race.badge) out.push(`        <span class="race-badge contested">${race.badge}</span>`);
    // Collapsing a race is a button, not a <details>, so the existing header
    // layout survives; app.js toggles it and it stays open without JS.
    out.push(`        <button class="race-toggle" aria-expanded="true" aria-controls="race-panel-${esc(race.id)}" aria-label="Collapse ${esc(race.title)}"><span aria-hidden="true">▾</span></button>`);
    out.push('      </div>');
    out.push(`      <div class="race-panel" id="race-panel-${esc(race.id)}">`);
    out.push('');
    // Context sits directly under the header rather than below the cards —
    // it frames the race, so a reader needs it before the candidates.
    if (race.context) {
      out.push('      <div class="race-context">');
      out.push(`        ${r(race.context, 'elections.json')}`);
      out.push('      </div>');
      out.push('');
    }
    if (race.note) {
      out.push('      <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 14px 18px; margin-bottom: 20px; font-size: 13px; color: var(--slate-light); line-height: 1.6;">');
      out.push(`        ${r(race.note, 'elections.json')}`);
      out.push('      </div>');
      out.push('');
    }
    out.push('      <div class="candidates-grid">');
    out.push('');

    // Group candidates into party columns, preserving first-appearance order.
    const mine = e.candidates.filter((c) => c.race_id === race.id);
    const cols = [];
    for (const c of mine) {
      let col = cols.find((x) => x.party === c.party);
      if (!col) { col = { party: c.party, style: c.party_style, list: [] }; cols.push(col); }
      col.list.push(c);
    }
    for (const col of cols) {
      out.push('        <div class="party-column">');
      out.push(`          <div class="party-label ${col.style}">${col.party}</div>`);
      out.push('');
      for (const c of col.list) {
        let summary = r(c.summary, 'elections.json');
        if (c.platform_ref) {
          summary += ' ' + r(race.shared_platforms[c.platform_ref], 'elections.json');
        }
        out.push('          <div class="candidate-card">');
        out.push(`            <div class="candidate-name">${c.name}</div>`);
        out.push(`            <div class="candidate-meta">${r(c.meta, 'elections.json')}</div>`);
        out.push(`            <p class="candidate-summary">${summary}</p>`);
        out.push(`            <a href="${esc(c.source_url)}" target="_blank" class="examiner-link">${c.source_label} →</a>`);
        out.push('          </div>');
      }
      out.push('        </div>');
      out.push('');
    }
    out.push('      </div>');
    out.push('      </div>');
    out.push('    </div>');
    out.push('');
  }

  out.push('    <div style="margin-top: 40px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px;">');
  for (const v of e.voter_info) {
    out.push('      <div class="voter-info-box">');
    out.push(`        <div class="voter-info-label">${v.label}</div>`);
    out.push(`        <div class="voter-info-value">${r(v.value, 'elections.json')}</div>`);
    if (v.note) out.push(`        <div class="voter-info-note">${r(v.note, 'elections.json')}</div>`);
    out.push('      </div>');
  }
  out.push('    </div>');
  return out.join('\n');
}

// The most recent meeting per governing body — the one the home digest shows
// a card for. Derived from the dates rather than flagged per meeting, so
// adding a newer meeting for a body retires the previous card automatically.
function latestPerBody(published) {
  const latest = new Map();
  for (const m of published) {
    const cur = latest.get(m.governing_body);
    if (!cur || m.date > cur.date) latest.set(m.governing_body, m);
  }
  const ids = new Set([...latest.values()].map((m) => m.id));
  return published.filter((m) => ids.has(m.id));
}

const longDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US',
  { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// ── Meeting partial parsing ────────────────────────────────────────────────
// The partials were written as the inner HTML of three tabs. The Meetings
// page now shows one summary per meeting with named sections, so the build
// cuts each partial at the block boundaries it already has rather than asking
// every partial to be rewritten. The cuts are on markup the partials all share
// (.mtg-meta, .exec-summary, .exec-votes, .detail-section, .transcript-body),
// and anything the parser cannot place is a build error naming the file —
// a section silently dropping out of a summary is the failure to prevent.

// Split `html` into the pieces that start at each occurrence of `marker`.
// Returns [before-first, piece, piece, …].
function splitAt(html, marker) {
  const parts = [];
  let from = 0;
  let at = html.indexOf(marker);
  while (at !== -1) {
    parts.push(html.slice(from, at));
    from = at;
    at = html.indexOf(marker, at + marker.length);
  }
  parts.push(html.slice(from));
  return parts;
}

function readPartial(file) {
  return stripMaintainerComments(read(p(file)), file, stripped).trim();
}

function parseExec(m) {
  const file = m.exec_summary_file;
  const html = readPartial(file);
  const [head, ...blocks] = splitAt(html, '<div class="exec-votes"');
  const at = head.indexOf('<div class="exec-summary">');
  if (at === -1) fail(file, 'no .exec-summary block');

  const out = { meta: head.slice(0, at).trim(), summary: head.slice(at).trim(), votes: null, actions: null };
  for (const block of blocks) {
    const label = /<div class="exec-votes-label">([\s\S]*?)<\/div>/.exec(block);
    if (!label) { fail(file, '.exec-votes block has no .exec-votes-label'); continue; }
    // The label becomes the <summary> line, so it is removed from the body.
    const body = block.replace(label[0], '').trim();
    const text = label[1].trim();
    if (/^Key Votes/i.test(text)) {
      // "Key Votes — All approved unanimously": the qualifier after the dash
      // is worth keeping on the folded line; it answers "was anything close?"
      out.votes = { note: text.replace(/^Key Votes\s*(—|-|–)?\s*/i, ''), body };
    } else if (/^Action Items/i.test(text)) {
      out.actions = { note: text.replace(/^Action Items\s*(—|-|–)?\s*/i, ''), body };
    } else {
      fail(file, `unrecognised .exec-votes-label "${text}" — expected Key Votes or Action Items`);
    }
  }
  if (!out.votes) fail(file, 'no Key Votes block');
  if (!out.actions) fail(file, 'no Action Items block');
  return out;
}

function parseDetailed(m) {
  const file = m.detailed_summary_file;
  const [, ...sections] = splitAt(readPartial(file), '<div class="detail-section">');
  if (!sections.length) fail(file, 'no .detail-section blocks');
  return sections.map((s) => {
    const title = /<span class="detail-section-title">([\s\S]*?)<\/span>/.exec(s);
    return { title: title ? title[1] : '', html: s.trim() };
  });
}

function parseTranscript(m) {
  const file = m.transcript_file;
  const html = readPartial(file);
  const at = html.indexOf('<div class="transcript-body">');
  if (at === -1) fail(file, 'no .transcript-body block');
  // The leading .mtg-meta repeats the summary's own header, so it is dropped.
  return html.slice(at);
}

// Residents who showed up = the public comment sections of the detailed
// summary. Derived rather than hand-listed, so a new meeting gets the section
// for free; a meeting with none says so rather than rendering an empty box.
const isPublicComment = (s) => /public comment/i.test(s.title);

function generateMeetingSet(m, r, shown) {
  const exec = parseExec(m);
  const detailed = parseDetailed(m);
  const residents = detailed.filter(isPublicComment);
  const transcript = parseTranscript(m);

  const out = [];
  out.push(`      <article class="mtg-set" data-meeting="${esc(m.id)}"${shown ? '' : ' hidden'}>`);
  out.push(`        <h3 class="mtg-set-title">${m.selector.detail}</h3>`);

  // Disclaimer. A leading "the " in minutes_label sits outside the anchor.
  const lbl = m.minutes_label || 'posted minutes';
  const linked = lbl.startsWith('the ')
    ? `the <a href="${esc(m.minutes_url)}" target="_blank">${lbl.slice(4)}</a>`
    : `<a href="${esc(m.minutes_url)}" target="_blank">${lbl}</a>`;
  const extra = m.disclaimer_extra ? ` ${r(m.disclaimer_extra, 'meetings.json')}` : '';
  out.push('        <div class="summary-disclaimer">');
  out.push('          <span class="summary-disclaimer-icon">⚠️</span>');
  out.push(`          <div><strong>AI-generated — not official records.</strong>${extra} Always verify against the <a href="${esc(m.recording_url)}" target="_blank">official recording</a> and ${linked}.</div>`);
  out.push('        </div>');
  out.push(`        ${exec.meta}`);

  // Always open: what happened, and who from the public was there.
  out.push('        <section class="mtg-sec" data-section="exec">');
  out.push('          <h4 class="mtg-sec-title">Executive summary</h4>');
  out.push(`          ${exec.summary}`);
  out.push('        </section>');
  out.push('        <section class="mtg-sec" data-section="residents">');
  out.push('          <h4 class="mtg-sec-title">Residents who showed up</h4>');
  if (residents.length) {
    for (const s of residents) out.push(`          ${s.html}`);
  } else {
    out.push(`          <p class="mtg-sec-empty">This summary records no public comment from residents. The <a href="${esc(m.recording_url)}" target="_blank">recording</a> is the complete record.</p>`);
  }
  out.push('        </section>');

  // Collapsed by default: the detail a reader opens on purpose.
  const fold = (key, title, note, body) => {
    out.push(`        <details class="mtg-fold" data-section="${key}">`);
    out.push(`          <summary><span class="mtg-fold-title">${title}</span>${note ? `<span class="mtg-fold-note">${note}</span>` : ''}</summary>`);
    out.push(`          <div class="mtg-fold-body">${body}</div>`);
    out.push('        </details>');
  };
  fold('votes', 'Key votes', exec.votes && exec.votes.note, exec.votes ? exec.votes.body : '');
  fold('actions', 'Action items', exec.actions && exec.actions.note, exec.actions ? exec.actions.body : '');
  fold('detailed', 'Detailed summary', `${detailed.length} sections, with timestamps`, detailed.map((s) => s.html).join('\n'));
  // "Load more" is added by app.js once the transcript runs past a page; the
  // whole transcript is in the markup so it still reads without JS.
  fold('transcript', 'Full transcript (raw)', 'AI transcription', transcript);

  out.push('      </article>');
  return out.join('\n');
}

// Meetings page, two levels: a tab per governing body, then within a body its
// most recent meeting expanded and every earlier one as a plain date list.
// "Most recent" is derived from the dates, so adding a meeting to
// meetings.json moves the previous one into the list with no other edit.
function generateMeetings(data, r) {
  const published = data.meetings.meetings.filter((m) => m.status === 'published');
  // Bodies in bodies.json order, only those with something to show.
  const bodies = data.bodies.bodies.filter((b) => published.some((m) => m.governing_body === b.id));

  const out = [];
  out.push(`    <p class="section-intro">${r(data.meetings.section_intro, 'meetings.json')}</p>`);
  out.push('    <div class="mtg-body-tabs" role="tablist" aria-label="Governing body">');
  bodies.forEach((b, i) => {
    const latest = published.filter((m) => m.governing_body === b.id).sort((a, c) => c.date.localeCompare(a.date))[0];
    out.push(`      <button class="mtg-body-tab${i === 0 ? ' is-active' : ''}" role="tab" id="mtg-tab-${esc(b.id)}" data-body="${esc(b.id)}" aria-controls="mtg-body-${esc(b.id)}" aria-selected="${i === 0}"${i === 0 ? '' : ' tabindex="-1"'}><span class="mtg-body-name">${b.name}</span><span class="mtg-body-latest">Latest: ${longDate(latest.date)}</span></button>`);
  });
  out.push('    </div>');

  bodies.forEach((b, i) => {
    const mine = published.filter((m) => m.governing_body === b.id).sort((a, c) => c.date.localeCompare(a.date));
    out.push(`    <div class="mtg-body-panel" role="tabpanel" id="mtg-body-${esc(b.id)}" data-body="${esc(b.id)}" aria-labelledby="mtg-tab-${esc(b.id)}"${i === 0 ? '' : ' hidden'}>`);
    mine.forEach((m, j) => out.push(generateMeetingSet(m, r, j === 0)));

    if (mine.length > 1) {
      // Lists every meeting; app.js hides the entry for the one on screen, so
      // on load this reads as the earlier meetings and, once one is opened,
      // the latest is there to go back to.
      out.push('      <nav class="mtg-older" aria-label="Earlier meetings">');
      out.push('        <div class="mtg-older-label">Earlier meetings</div>');
      out.push('        <ul class="mtg-date-list">');
      mine.forEach((m, j) => {
        out.push(`          <li${j === 0 ? ' hidden' : ''}><a class="mtg-date-link" href="#${esc(m.id)}" data-meeting="${esc(m.id)}">${longDate(m.date)}</a> <span class="mtg-date-detail">${m.selector.detail.split(' · ')[0]}${j === 0 ? ' · latest' : ''}</span></li>`);
      });
      out.push('        </ul>');
      out.push('      </nav>');
    }
    out.push('    </div>');
    out.push('');
  });
  return out.join('\n').trimEnd();
}

function generateGovernanceCards(data, r) {
  const out = ['    <div class="gov-grid">'];
  for (const b of data.bodies.bodies) {
    const accent = b.accent && b.accent !== 'none' ? `${b.accent}-top ` : '';
    out.push(`      <div class="gov-card ${accent}fade-in">`);
    out.push(`        <div class="gov-card-label">${b.label}</div>`);
    out.push(`        <h3>${b.name}</h3>`);
    out.push(`        <p>${r(b.description, 'bodies.json')}</p>`);
    out.push('        <div class="gov-card-detail">');

    const rows = b.detail_rows.slice();
    if (b.budget) {
      const fact = r(`{{fact:${b.budget.fact_ref}}}`, 'bodies.json');
      const note = b.budget.note ? ` ${r(b.budget.note, 'bodies.json')}` : '';
      rows.splice(1, 0, { key: b.budget.label, value: `${fact}${note}` });
    }
    for (const row of rows) {
      out.push(`          <div class="detail-row"><span class="detail-key">${row.key}</span><span class="detail-val">${r(row.value, 'bodies.json')}</span></div>`);
    }
    out.push('        </div>');
    const domain = b.website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    out.push(`        <a href="${esc(b.website)}" target="_blank" class="gov-link">${domain} →</a>`);
    out.push('        <div class="source-links">');
    for (const l of b.source_links) {
      out.push(`          <a href="${esc(l.url)}" target="_blank" class="source-link">${l.label}</a>`);
    }
    out.push('        </div>');
    out.push('      </div>');
    out.push('');
  }

  // Quick-reference tile — a routing list, not a governing body.
  const q = data['quick-reference'];
  out.push('      <div class="gov-card fade-in" style="background: var(--light); border-style: dashed;">');
  out.push(`        <div class="gov-card-label">${q.label}</div>`);
  out.push(`        <h3>${q.title}</h3>`);
  out.push('        <p style="font-size:13px;">');
  const lines = q.entries.map((x) => `          <strong>${x.question}</strong> → ${x.route_to}`);
  out.push(lines.join('<br><br>\n'));
  out.push('        </p>');
  out.push('      </div>');
  out.push('    </div>');
  return out.join('\n');
}

function generateMeetingSchedule(data, r) {
  const out = [];
  for (const b of data.bodies.bodies) {
    if (!b.meeting_schedule || !b.board_name) continue;
    const ms = b.meeting_schedule;
    const domain = b.website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    out.push('          <tr>');
    out.push(`            <td><span class="body-name">${b.board_name}</span><br><a href="${esc(b.website)}" target="_blank" class="meeting-link">${domain}</a></td>`);
    out.push(`            <td>${ms.cadence_detail || ms.cadence}</td>`);
    out.push(`            <td>${ms.address_display || ms.address}</td>`);
    out.push(`            <td>${r(ms.participation, 'bodies.json')}</td>`);
    out.push('          </tr>');
  }
  for (const x of data.bodies.extra_schedule_rows || []) {
    out.push('          <tr>');
    out.push(`            <td><span class="body-name">${x.name}</span></td>`);
    out.push(`            <td>${r(x.schedule, 'bodies.json')}</td>`);
    out.push(`            <td>${r(x.location, 'bodies.json')}</td>`);
    out.push(`            <td>${r(x.participation, 'bodies.json')}</td>`);
    out.push('          </tr>');
  }
  return out.join('\n');
}

function generateTaxSection(data, r) {
  const t = data.taxes;
  const out = [`    <p class="section-intro">${r(t.section_intro, 'taxes.json')}</p>`];

  out.push('    <div class="tax-layout">');
  out.push('      <div class="tax-visual">');
  for (const b of t.bars) {
    const name = `${b.icon ? b.icon + ' ' : ''}${b.label}`;
    const detail = b.detail ? `<div class="tax-bar-detail">${r(b.detail, 'taxes.json')}</div>` : '';
    // A null width is a body with no published share: an empty track, so the
    // row is there but nothing about it reads as a proportion.
    const track = b.bar_width === null
      ? '<div class="tax-bar-track is-unknown"></div>'
      : `<div class="tax-bar-track"><div class="tax-bar-fill bar-${b.fill_style}" style="width:${b.bar_width}%"></div></div>`;
    out.push(`        <div class="tax-bar-row fade-in"><div class="tax-bar-header"><span class="tax-bar-name">${name}</span><span class="tax-bar-pct">${b.percent_text}</span></div>${detail}${track}</div>`);
  }

  out.push(`        <div class="tax-note fade-in">${r(t.note, 'taxes.json')}</div>`);
  out.push('      </div>');
  out.push('      <div class="tax-explainer">');
  for (const e of t.explainers) {
    const accent = e.accent && e.accent !== 'none' ? `${e.accent} ` : '';
    const title = `${e.icon ? e.icon + ' ' : ''}${e.title}`;
    const link = e.link
      ? `<a href="${esc(e.link.url)}" target="_blank" class="issue-source-link">${e.link.label}</a>` : '';
    out.push(`        <div class="tax-explainer-block ${accent}fade-in"><div class="teb-title">${title}</div><div class="teb-desc">${r(e.description, 'taxes.json')}</div>${link}</div>`);
  }
  out.push('      </div>');
  out.push('    </div>');

  // Like-for-like village comparison, below the overall breakdown. Bar
  // lengths come from the facts' numeric values, so it is to scale.
  if (t.comparison) {
    const c = t.comparison;
    const rows = c.entries.map((e) => {
      const f = r.byId.get(e.fact_ref);
      if (!f) { fail('taxes.json', `comparison.${e.id}.fact_ref → unknown fact "${e.fact_ref}"`); return null; }
      if (typeof f.value !== 'number') { fail('taxes.json', `comparison.${e.id}: fact "${e.fact_ref}" has no numeric value to size a bar`); return null; }
      return { e, value: f.value, amount: r(`{{fact:${e.fact_ref}}}`, 'taxes.json') };
    }).filter(Boolean);
    const max = Math.max(...rows.map((x) => x.value));
    out.push('    <div class="tax-compare fade-in">');
    out.push(`      <h3 class="tax-compare-title">${c.title}</h3>`);
    if (c.subtitle) out.push(`      <div class="tax-compare-sub">${r(c.subtitle, 'taxes.json')}</div>`);
    out.push('      <div class="tax-compare-grid">');
    for (const { e, value, amount } of rows) {
      const width = Math.round((value / max) * 1000) / 10;
      out.push(`        <div class="tax-compare-card" data-body="${esc(e.governing_body || e.id)}"><div class="tax-compare-label">${e.label}</div><div class="tax-compare-amount">${amount}</div><div class="tax-bar-track"><div class="tax-bar-fill bar-${e.fill_style}" style="width:${width}%"></div></div></div>`);
    }
    out.push('      </div>');
    if (c.note) out.push(`      <p class="tax-compare-note">${r(c.note, 'taxes.json')}</p>`);
    out.push('    </div>');
  }

  // Outbound reading, last on the page: a reader who wants the primary
  // source should not have to hunt for it beneath this site's summary.
  if (t.learn_more) {
    out.push('    <div class="learn-more fade-in">');
    out.push(`      <h3 class="learn-more-title">${t.learn_more.title || 'Learn more'}</h3>`);
    out.push('      <ul class="learn-more-list">');
    for (const l of t.learn_more.links) {
      const note = l.note ? `<span class="learn-more-note">${r(l.note, 'taxes.json')}</span>` : '';
      out.push(`        <li><a href="${esc(l.url)}" target="_blank" rel="noopener">${r(l.label, 'taxes.json')} →</a>${note}</li>`);
    }
    out.push('      </ul>');
    out.push('    </div>');
  }

  return out.join('\n');
}

function generateGetInvolved(data) {
  return data.bodies.bodies
    .filter((b) => b.meeting_schedule)
    .map((b) => {
      const ms = b.meeting_schedule;
      const icon = b.icon ? `${b.icon} ` : '';
      return `            <span class="meeting-chip">${icon}${b.short_name} — ${ms.cadence} · ${ms.address}</span>`;
    }).join('\n');
}

// Get Involved · "Vote in every election". The dates come from facts.json
// like everywhere else, so the page cannot disagree with the Elections page.
function generateInvolvedVote(data, r) {
  const at = 'get-involved';
  const box = (label, value, note) => [
    '        <div class="vote-fact">',
    `          <div class="vote-fact-label">${label}</div>`,
    `          <div class="vote-fact-value">${value}</div>`,
    note ? `          <div class="vote-fact-note">${note}</div>` : '',
    '        </div>',
  ].filter(Boolean).join(NL);
  return [
    '      <div class="vote-facts">',
    box('Next election', r('{{fact:election-date-2026}}', at),
      'Village of Pelham, Village of Pelham Manor and Town of Pelham races are all on this ballot.'),
    box('Register', r('{{fact:voter-registration-deadline}}', at),
      '<a href="https://www.elections.ny.gov" target="_blank">elections.ny.gov</a> or the Westchester County Board of Elections, 914-995-5700.'),
    box('Polls open', r('{{fact:polling-hours}}', at),
      `School budget and Board of Education vote: ${r('{{fact:school-budget-vote-schedule}}', at)}.`),
    '      </div>',
  ].join(NL);
}

// Get Involved · "Run for office": every elected seat in Pelham, from the
// roster. Staff and appointed posts are left out — nobody runs for those.
function generateElectedOffices(data) {
  const out = ['      <ul class="office-list">'];
  for (const b of data.bodies.bodies) {
    const seats = data.officials.officials.filter((o) => o.governing_body === b.id && o.seat_type === 'elected');
    if (!seats.length) continue;
    const titles = [];
    for (const o of seats) {
      const t = titles.find((x) => x.title === o.title);
      if (t) t.n++; else titles.push({ title: o.title, n: 1 });
    }
    const list = titles.map((t) => (t.n > 1 ? `${t.n} × ${t.title}` : t.title)).join(' · ');
    out.push(`        <li><span class="office-body">${b.name}</span><span class="office-count">${seats.length} elected seat${seats.length === 1 ? '' : 's'}</span><span class="office-titles">${list}</span></li>`);
  }
  out.push('      </ul>');
  return out.join(NL);
}

function generateFooter(data, r) {
  const links = data.sources.sources
    .map((s) => `<a href="${esc(s.url)}" target="_blank">${s.domain}</a>`).join(' · ');
  return [
    `  <p style="margin-top:8px;">Sources: ${links}</p>`,
    `  <p style="margin-top:8px;">This guide is for informational purposes. For official information, always check government websites directly. Last updated ${r('{{fact:site-last-updated}}', 'footer')}.</p>`,
  ].join('\n');
}

// KNOWN_ISSUES for the RAG step in ask-pelham.js.
//
// The KEYS are canonical values stored in Supabase articles.matched_issue by
// check_examiner.py in the companion repo, so they are taken verbatim from
// issues[].rag_issue and must never be derived from the issue id — renaming
// one stops matching every article already tagged with the old spelling, and
// nothing in the test suite would notice.
//
// Only the keyword lists are generated. Cards whose rag_issue is null are
// skipped: no stored article is tagged with them, so a key would match
// nothing. rag_only_issues carries the canonical issues that have no card.
function generateKnownIssues(data) {
  const entries = [];
  for (const i of data.issues.issues) {
    if (!i.rag_issue) continue;
    entries.push([i.rag_issue, i.rag_keywords || []]);
  }
  for (const [key, kws] of Object.entries(data.issues.rag_only_issues || {})) {
    entries.push([key, kws]);
  }

  const seen = new Set();
  for (const [key] of entries) {
    if (seen.has(key)) fail('issues.json', `duplicate rag_issue key "${key}"`);
    seen.add(key);
  }

  // Emission order is load-bearing: matchIssue breaks longest-match ties by
  // iteration order, and many keywords across issues are the same length
  // ("colonial" and "flooding" are both 8). rag_order pins it so generating
  // the map cannot silently re-route a question.
  const order = data.issues.rag_order || [];
  const missing = [...seen].filter((k) => !order.includes(k));
  const extra = order.filter((k) => !seen.has(k));
  if (missing.length) fail('issues.json', `rag_order is missing: ${missing.join(', ')}`);
  if (extra.length) fail('issues.json', `rag_order names unknown issues: ${extra.join(', ')}`);
  entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  // A keyword on two issues makes routing depend on object order.
  const owner = new Map();
  for (const [key, kws] of entries) {
    for (const k of kws) {
      if (owner.has(k)) {
        fail('issues.json', `keyword "${k}" is claimed by both "${owner.get(k)}" and "${key}" — longest-match routing would depend on key order`);
      }
      owner.set(k, key);
      if (k !== k.toLowerCase()) fail('issues.json', `rag keyword "${k}" must be lowercase`);
    }
  }

  // Bare identifier keys where JS allows it, quoted otherwise — matching how
  // the map was written by hand.
  const q = (v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const lines = entries.map(([key, kws]) => {
    const k = /^[a-z][a-zA-Z0-9]*$/.test(key) ? key : q(key);
    return `  ${k}: [${kws.map(q).join(', ')}],`;
  });
  return ['const KNOWN_ISSUES = {', ...lines, '};'].join('\n');
}

function generateHeroStats(data, r) {
  const parts = data.hero.stats.map((s) => {
    const num = r(`{{fact:${s.fact_ref}}}`, 'hero.json');
    const inner = `        <span class="stat-num">${num}</span>\n`
      + `        <span class="stat-label">${s.label}</span>`;
    // A stat with a destination is an ordinary link now. In the single-page
    // layout it switched an Explore tab via JS; each section has its own page.
    return s.link_url
      ? `      <a href="${esc(s.link_url)}" class="stat">\n${inner}\n      </a>`
      : `      <div class="stat">\n${inner}\n      </div>`;
  });
  return parts.join('\n      <hr class="stat-divider">\n');
}

function generateSourceChips(data) {
  const out = ['    <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 28px;">'];
  for (const s of data.sources.sources) out.push(`      <span class="source-chip">✓ ${s.domain}</span>`);
  out.push('    </div>');
  return out.join('\n');
}

function generateAboutSources(data) {
  return data.sources.sources
    .map((s) => `          <a href="${esc(s.url)}" target="_blank" class="source-link about-source-link">↗ ${s.domain} — ${s.short_name || s.name}</a>`)
    .join('\n');
}

// ── Home digest blocks ─────────────────────────────────────────────────────
// The homepage is a doorway, not a copy of the site. Each block shows a few
// items and links to the page that holds all of them.

// Most urgent first, then most recently updated. Only cards marked for the
// home grid, capped at four — a digest that shows everything is not a digest.
const ISSUE_URGENCY = { active: 0, watch: 1, resolved: 2 };

function generateIssuePreviews(data, r, limit = 3) {
  const picked = data.issues.issues
    .filter((i) => i.show_on_home !== false)
    .slice()
    .sort((a, b) => (ISSUE_URGENCY[a.status] - ISSUE_URGENCY[b.status])
      || String(b.last_updated).localeCompare(String(a.last_updated)))
    .slice(0, limit);

  const cards = picked.map((i) => {
    // Some issues read better on a topic page than on their own card: a
    // budget issue belongs on /taxes, an election issue on /elections.
    const href = i.link_to || `/issues#${esc(i.id)}`;
    const link = `<a href="${esc(href)}" class="issue-source-link">Read more →</a>`;
    return `      <div class="issue-card fade-in"><span class="issue-tag tag-${i.tag_style}">${i.tag}</span>`
      + `<h3>${r(i.title, 'issues.json')}</h3>`
      + `<div class="issue-status"><div class="status-dot dot-${i.status}"></div>${r(i.status_label, 'issues.json')}</div>${link}</div>`;
  });
  return ['    <div class="issues-grid issues-grid-3">', ...cards, '    </div>'].join(NL);
}

// One card per board, the same meetings the Meetings page opens on.
function generateMeetingPreviews(data, r) {
  const published = data.meetings.meetings.filter((m) => m.status === 'published');
  const cards = latestPerBody(published).map((m) => {
    const body = data.bodies.bodies.find((b) => b.id === m.governing_body);
    const when = new Date(m.date + 'T12:00:00Z').toLocaleDateString('en-US',
      { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const mins = m.duration_min ? `<span class="mtg-card-meta">⏱ ${m.duration_min} min</span>` : '';
    return `      <a class="mtg-card fade-in" href="/meetings#${esc(m.id)}">`
      + `<span class="mtg-card-body">${body.name}</span>`
      + `<span class="mtg-card-date">${when}</span>`
      + `<span class="mtg-card-detail">${m.selector.detail.split(' · ')[0]}</span>`
      + `${mins}</a>`;
  });
  return ['    <div class="mtg-card-grid">', ...cards, '    </div>'].join(NL);
}

// Slim banner, shown until election day. Like the nav badge it carries its own
// expiry rather than being omitted at build time, so it clears itself on the
// day even if nobody rebuilds the site.
function generateElectionsBanner(data, r) {
  const date = data.elections.election_date;
  const races = data.elections.races.length;
  const cands = data.elections.candidates.length;
  return [
    `<a class="home-banner" href="/elections" data-hide-after="${esc(date)}">`,
    '  <span class="home-banner-tag">🗳 Election</span>',
    `  <span class="home-banner-text"><strong>${r('{{fact:election-date-2026}}', 'elections.json')}</strong> — ${races} contested races, ${cands} candidates. Polls ${r('{{fact:polling-hours}}', 'elections.json')}.</span>`,
    '  <span class="home-banner-cta">See who\'s running →</span>',
    '</a>',
  ].join(NL);
}

// =========================================================================
// PAGE ASSEMBLY
// =========================================================================
//
// Each page is content/pages/<id>.html — hand-written markup with BUILD
// anchors marking where generated blocks go — wrapped in the shared shell.
//
// A page only receives the blocks whose anchors it actually contains, so
// adding a block to a page is a matter of pasting the anchor pair into its
// partial. An anchor with no matching generator is a build error, rather
// than silently rendering an empty region.

function pageBlocks(data, r) {
  return {
    'hero-stats': () => generateHeroStats(data, r),
    'elections-banner': () => generateElectionsBanner(data, r),
    'issue-previews': () => generateIssuePreviews(data, r),
    'meeting-previews': () => generateMeetingPreviews(data, r),
    issues: () => generateIssueCards(data, r),
    elections: () => generateElections(data, r),
    meetings: () => generateMeetings(data, r),
    taxes: () => generateTaxSection(data, r),
    governance: () => generateGovernanceCards(data, r),
    'source-chips': () => generateSourceChips(data),
    'get-involved': () => generateGetInvolved(data),
    'involved-vote': () => generateInvolvedVote(data, r),
    'elected-offices': () => generateElectedOffices(data),
    'meeting-schedule': () => generateMeetingSchedule(data, r),
    'about-sources': () => generateAboutSources(data),
  };
}

const PAGE_TITLES = {
  home: 'Home',
  issues: 'Current Issues',
  elections: '2026 Elections',
  meetings: 'Meeting Summaries',
  'get-involved': 'How to Get Involved',
  taxes: 'Where Your Taxes Go',
  'gov-101': 'Who Governs Pelham',
  'ask-ai': 'Ask Pelham AI',
  about: 'About & Corrections',
};

const PAGE_DESCRIPTIONS = {
  home: 'Public information about local government in Pelham, NY — meetings, elections, taxes and how to take part.',
  issues: 'The issues currently being debated in Pelham board meetings and local coverage, each with its source.',
  elections: 'Who is running in the November 2026 Pelham elections, what they stand for, and how to vote.',
  meetings: 'AI-generated summaries of every processed public meeting in Pelham — executive, detailed and full transcript.',
  'get-involved': 'How to email an official, speak at a public meeting, write to the editor, or organise with neighbours in Pelham.',
  taxes: 'Where Pelham property taxes go — the school district, village, county and town shares.',
  'gov-101': 'How Pelham is governed: two villages, a town, a school district and the county, and who to call for what.',
  'ask-ai': 'An assistant that answers questions about Pelham civic life using only vetted local sources.',
  about: 'How this site is made, the sources it draws on, and how to report an error.',
};

function buildPages(data, r) {
  const { generatePageShell, SITE_URL } = require('./page-shell');
  const blocks = pageBlocks(data, r);
  const written = [];

  for (const pg of data.pages.pages) {
    const partialPath = p('content', 'pages', `${pg.id}.html`);
    if (!fs.existsSync(partialPath)) {
      fail('pages.json', `${pg.id} has no partial at content/pages/${pg.id}.html`);
      continue;
    }

    let html = generatePageShell({
      title: PAGE_TITLES[pg.id] || pg.label,
      activePage: pg.id,
      content: read(partialPath).replace(/\n$/, ''),
      description: PAGE_DESCRIPTIONS[pg.id],
      canonical: SITE_URL + pg.url,
      data,
      resolve: r,
    });

    // Splice only the anchors this page actually carries.
    const wanted = [...new Set([...html.matchAll(/<!--\s*BUILD:([a-z-]+)\s*-->/g)].map((m) => m[1]))];
    for (const name of wanted) {
      if (!blocks[name]) {
        fail(`content/pages/${pg.id}.html`, `anchor BUILD:${name} has no generator`);
        continue;
      }
      html = splice(html, name, blocks[name](), 'html');
    }

    written.push([p(pg.file), html, pg]);
  }
  return written;
}

// =========================================================================
// PHASE 4 — splice into index.html
// =========================================================================
function splice(html, name, body, kind) {
  const open = kind === 'js' ? `/* BUILD:${name} */` : `<!-- BUILD:${name} -->`;
  const close = kind === 'js' ? `/* /BUILD:${name} */` : `<!-- /BUILD:${name} -->`;

  if (html.split(open).length !== 2) { fail('index.html', `anchor ${open} must appear exactly once`); return html; }
  if (html.split(close).length !== 2) { fail('index.html', `anchor ${close} must appear exactly once`); return html; }
  if (body.includes('BUILD:')) { fail(name, 'generated output contains a BUILD anchor string'); return html; }

  const a = html.indexOf(open);
  const b = html.indexOf(close);
  if (b < a) { fail('index.html', `anchor ${close} precedes ${open}`); return html; }

  const lineStart = html.lastIndexOf('\n', b) + 1;
  const closeIndent = html.slice(lineStart, b);
  return html.slice(0, a + open.length) + '\n' + body + '\n' + closeIndent + html.slice(b);
}

// =========================================================================
// PHASE 5 — validate output
// =========================================================================
function phase5(html, data, pageId = 'home') {
  const leftover = [...html.matchAll(/\{\{(fact|generated):([a-z0-9-]+)\}\}/g)].map((m) => m[0]);
  if (leftover.length) {
    fail(`${pageId} page`,
      `unresolved tokens in output: ${[...new Set(leftover)].join(', ')}. `
      + 'Tokens only resolve inside a BUILD anchor or in content/*.json — a token '
      + 'written into the static shell would be rewritten to a literal on the first '
      + 'build and never update again.');
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dupes.length) fail(`${pageId} page`, `duplicate ids: ${[...new Set(dupes)].join(', ')}`);

  if (pageId !== 'meetings') {
    return { ids: ids.length, selectors: 0, sets: 0, archived: 0,
             ragKeys: data.issues.issues.filter((i) => i.rag_issue).length
                      + Object.keys(data.issues.rag_only_issues || {}).length };
  }

  const selectors = (html.match(/class="mtg-body-tab[ "]/g) || []).length;
  const sets = (html.match(/class="mtg-set"/g) || []).length;
  const published = data.meetings.meetings.filter((m) => m.status === 'published');
  // One tab per governing body with a published meeting; one summary per
  // published meeting, the latest of each body open and the rest in its list.
  const expectedSelectors = new Set(published.map((m) => m.governing_body)).size;
  if (selectors !== expectedSelectors) {
    fail('meetings page', `${selectors} body tabs but ${expectedSelectors} bodies with a published meeting`);
  }
  if (sets !== published.length) {
    fail('meetings page', `${sets} meeting summaries but ${published.length} published meetings`);
  }
  for (const m of published) {
    if (!html.includes(`class="mtg-set" data-meeting="${m.id}"`)) {
      fail('meetings page', `${m.id} has no summary`);
    }
  }

  return { ids: ids.length, selectors, sets, archived: published.length - expectedSelectors,
           ragKeys: data.issues.issues.filter((i) => i.rag_issue).length
                    + Object.keys(data.issues.rag_only_issues || {}).length };
}

// =========================================================================
function main() {
  const data = phase1();
  if (errors.length) return report();

  const r = makeResolver(data.facts);

  const promptText = buildPrompt(data, r);
  const promptModule = writePromptModule(promptText);

  // Nine pages, each a partial wrapped in the shared shell. index.html is
  // just the 'home' page now — it stopped being both input and output when
  // the content moved to content/pages/.
  const pages = buildPages(data, r);

  // Validate every page, not just the homepage.
  let stats = { ids: 0, selectors: 0, sets: 0, archived: 0, ragKeys: 0 };
  for (const [file, pageHtml, pg] of pages) {
    const st = phase5(pageHtml, data, pg.id);
    if (pg.id === 'meetings') stats = st;
    else stats.ids += st.ids;
  }

  // ask-pelham.js is part-generated too: its KNOWN_ISSUES map comes from
  // issues.json, everything else in the file is hand-written.
  let fn = read(p('netlify', 'functions', 'ask-pelham.js'));
  fn = splice(fn, 'known-issues', generateKnownIssues(data), 'js');

  if (errors.length) return report();

  const targets = [
    ...pages.map(([file, pageHtml]) => [file, pageHtml]),
    [p('netlify', 'functions', 'ask-pelham.js'), fn],
    [p('netlify', 'functions', 'system-prompt.js'), promptModule],
  ];

  let changed = [];
  for (const [file, next] of targets) {
    const prev = fs.existsSync(file) ? read(file) : null;
    if (prev !== next) changed.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    if (!CHECK) fs.writeFileSync(file, next);
  }

  if (CHECK && changed.length) {
    console.error('\n✗ --check: generated output differs from what is committed:');
    changed.forEach((f) => console.error(`    ${f}`));
    console.error('  Run `npm run build` and commit the result.\n');
    process.exit(1);
  }

  const used = r.used.size;
  console.log('');
  console.log('  Pelham build' + (CHECK ? ' (--check)' : ''));
  console.log('  ─────────────────────────────────────────────');
  console.log(`  content files      ${DATA_FILES.length} validated, 0 schema errors`);
  console.log(`  facts              ${data.facts.facts.length} defined, ${used} referenced by tokens`);
  console.log(`  officials          ${data.officials.officials.length}`);
  console.log(`  issues             ${data.issues.issues.length} (${data.issues.issues.filter((i) => i.show_on_home !== false).length} rendered)`);
  console.log(`  races / candidates ${data.elections.races.length} / ${data.elections.candidates.length}`);
  console.log(`  meetings           ${stats.selectors} body tabs, ${stats.sets} summaries (${stats.archived} in earlier-meeting lists), ${stats.sets * 3} partials`);
  console.log(`  pages generated    ${pages.length} (${pages.map(([, , pg]) => pg.id).join(', ')})`);
  console.log(`  html ids           ${stats.ids}, no duplicates`);
  if (stripped.length) {
    const kinds = [...new Set(stripped.map((s) => s.kind))].join(', ');
    console.log(`  partial comments   ${stripped.length} stripped (${kinds}) — kept in the partials`);
  }
  for (const s of stripped.filter((x) => x.kind === 'BUILD')) {
    console.log(`  ⚠ ${s.file} contained a BUILD comment; stripped, but that would have broken the splice`);
  }
  console.log(`  system prompt      ${promptText.length.toLocaleString()} chars → netlify/functions/system-prompt.js`);
  console.log(`  KNOWN_ISSUES       ${stats.ragKeys} canonical keys → netlify/functions/ask-pelham.js`);
  console.log(`  output             ${changed.length ? changed.join(', ') : 'unchanged (idempotent)'}`);
  console.log('');
}

function report() {
  console.error('\n✗ build failed:\n');
  for (const e of errors) console.error(`    ${e}`);
  console.error('');
  process.exit(1);
}

// Exports must be assigned BEFORE main() runs: page-shell.js requires this
// module from inside main(), and would otherwise see an empty exports object.
module.exports = { generateNav, generateFooter, phase1, makeResolver };

if (require.main === module) main();
