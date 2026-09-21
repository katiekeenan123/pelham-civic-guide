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
  'meetings', 'sources', 'taxes', 'quick-reference',
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
    out.push('      </div>');
    out.push('');
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
    out.push('');
    if (race.context) {
      out.push('      <div class="race-context">');
      out.push(`        ${r(race.context, 'elections.json')}`);
      out.push('      </div>');
    }
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

function generateMeetings(data, r) {
  const published = data.meetings.meetings.filter((m) => m.status === 'published');
  const out = [];
  out.push(`    <p class="section-intro">${r(data.meetings.section_intro, 'meetings.json')}</p>`);
  out.push('    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:32px;">');
  published.forEach((m, i) => {
    const cls = i === 0 ? 'mtg-selector active-mtg' : 'mtg-selector';
    out.push(`      <button class="${cls}" data-meeting="${esc(m.id)}"><span class="mtg-sel-body">${m.selector.body}</span><span class="mtg-sel-date">${m.selector.detail}</span></button>`);
  });
  out.push('    </div>');
  out.push('    <div style="display:flex;gap:0;margin-bottom:24px;border-bottom:2px solid var(--border);">');
  out.push('      <button class="detail-tab active-tab" data-tab="exec">Executive Summary</button>');
  out.push('      <button class="detail-tab" data-tab="detailed">Detailed Summary</button>');
  out.push('      <button class="detail-tab detail-tab-transcript" data-tab="transcript">Full Transcript (raw) ↓</button>');
  out.push('    </div>');
  out.push('    <div id="mtg-content">');

  const TABS = [
    ['exec', 'exec_summary_file'],
    ['detailed', 'detailed_summary_file'],
    ['transcript', 'transcript_file'],
  ];

  published.forEach((m, i) => {
    const hide = i === 0 ? '' : ' style="display:none;"';
    out.push(`      <div class="mtg-set" data-meeting="${esc(m.id)}"${hide}>`);

    // Disclaimer. A leading "the " in minutes_label sits outside the anchor,
    // matching the pre-refactor markup.
    const lbl = m.minutes_label || 'posted minutes';
    const linked = lbl.startsWith('the ')
      ? `the <a href="${esc(m.minutes_url)}" target="_blank">${lbl.slice(4)}</a>`
      : `<a href="${esc(m.minutes_url)}" target="_blank">${lbl}</a>`;
    const extra = m.disclaimer_extra ? ` ${r(m.disclaimer_extra, 'meetings.json')}` : '';
    out.push('      <div class="summary-disclaimer">');
    out.push('        <span class="summary-disclaimer-icon">⚠️</span>');
    out.push(`        <div><strong>AI-generated — not official records.</strong>${extra} Always verify against the <a href="${esc(m.recording_url)}" target="_blank">official recording</a> and ${linked}.</div>`);
    out.push('      </div>');

    for (const [tab, key] of TABS) {
      const hidePanel = tab === 'exec' ? '' : ' style="display:none;"';
      out.push(`      <div id="panel-${esc(m.id)}-${tab}" class="mtg-panel" data-tab="${tab}"${hidePanel}>`);
      let partial = read(p(m[key]));
      partial = stripMaintainerComments(partial, m[key], stripped);
      // Partials were extracted as panel inner HTML and end with the closing
      // tag's indentation; restore that exactly rather than re-indenting.
      partial = partial.replace(/^\n+/, '').replace(/\n$/, '');
      out.push(partial);
      out.push('      </div>');
    }
    out.push('      </div>');
    out.push('');
  });

  out.push('      <div id="mtg-placeholder" style="display:none;"></div>');
  out.push('    </div>');
  return out.join('\n');
}

function generateMeetingsJs(data) {
  const obj = data.meetings.meetings
    .filter((m) => m.status === 'published')
    .map((m) => `'${m.id}':{title:'${m.title.replace(/'/g, "\\'")}'}`)
    .join(',');
  return `  const meetings = {${obj}};`;
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
    out.push(`        <div class="tax-bar-row fade-in"><div class="tax-bar-header"><span class="tax-bar-name">${name}</span><span class="tax-bar-pct">${b.percent_text}</span></div><div class="tax-bar-track"><div class="tax-bar-fill bar-${b.fill_style}" style="width:${b.bar_width}%"></div></div></div>`);
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

function generateFooter(data, r) {
  const links = data.sources.sources
    .map((s) => `<a href="${esc(s.url)}" target="_blank">${s.domain}</a>`).join(' · ');
  return [
    `  <p style="margin-top:8px;">Sources: ${links}</p>`,
    `  <p style="margin-top:8px;">This guide is for informational purposes. For official information, always check government websites directly. Last updated ${r('{{fact:site-last-updated}}', 'footer')}.</p>`,
  ].join('\n');
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
function phase5(html, data) {
  const leftover = [...html.matchAll(/\{\{(fact|generated):([a-z0-9-]+)\}\}/g)].map((m) => m[0]);
  if (leftover.length) fail('index.html', `unresolved tokens in output: ${[...new Set(leftover)].join(', ')}`);

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dupes.length) fail('index.html', `duplicate ids: ${[...new Set(dupes)].join(', ')}`);

  const selectors = (html.match(/class="mtg-selector/g) || []).length;
  const sets = (html.match(/class="mtg-set"/g) || []).length;
  const published = data.meetings.meetings.filter((m) => m.status === 'published').length;
  if (selectors !== published) fail('index.html', `${selectors} selectors but ${published} published meetings`);
  if (sets !== published) fail('index.html', `${sets} panel sets but ${published} published meetings`);

  return { ids: ids.length, selectors, sets };
}

// =========================================================================
function main() {
  const data = phase1();
  if (errors.length) return report();

  const r = makeResolver(data.facts);

  const promptText = buildPrompt(data, r);
  const promptModule = writePromptModule(promptText);

  let html = read(p('index.html'));
  const sections = [
    ['elections', generateElections(data, r), 'html'],
    ['meetings', generateMeetings(data, r), 'html'],
    ['taxes', generateTaxSection(data, r), 'html'],
    ['issues', generateIssueCards(data, r), 'html'],
    ['governance', generateGovernanceCards(data, r), 'html'],
    ['source-chips', generateSourceChips(data), 'html'],
    ['get-involved', generateGetInvolved(data), 'html'],
    ['meeting-schedule', generateMeetingSchedule(data, r), 'html'],
    ['about-sources', generateAboutSources(data), 'html'],
    ['footer', generateFooter(data, r), 'html'],
    ['meetings-js', generateMeetingsJs(data), 'js'],
  ];
  for (const [name, body, kind] of sections) html = splice(html, name, body, kind);

  // Static shell may carry {{fact:}} tokens of its own (the hero stats).
  html = r(html, 'index.html (static shell)');

  const stats = phase5(html, data);
  if (errors.length) return report();

  const targets = [
    [p('index.html'), html],
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
  console.log(`  meetings           ${stats.selectors} published, ${stats.sets} panel sets, ${stats.sets * 3} partials`);
  console.log(`  sections generated ${sections.length}`);
  console.log(`  html ids           ${stats.ids}, no duplicates`);
  if (stripped.length) {
    const kinds = [...new Set(stripped.map((s) => s.kind))].join(', ');
    console.log(`  partial comments   ${stripped.length} stripped (${kinds}) — kept in the partials`);
  }
  for (const s of stripped.filter((x) => x.kind === 'BUILD')) {
    console.log(`  ⚠ ${s.file} contained a BUILD comment; stripped, but that would have broken the splice`);
  }
  console.log(`  system prompt      ${promptText.length.toLocaleString()} chars → netlify/functions/system-prompt.js`);
  console.log(`  output             ${changed.length ? changed.join(', ') : 'unchanged (idempotent)'}`);
  console.log('');
}

function report() {
  console.error('\n✗ build failed:\n');
  for (const e of errors) console.error(`    ${e}`);
  console.error('');
  process.exit(1);
}

main();
