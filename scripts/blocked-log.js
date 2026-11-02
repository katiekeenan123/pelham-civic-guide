// npm run blocked-log
//
// Downloads the Supabase `blocked_sources` table — every URL the Ask Pelham
// allowlist refused, with the question that triggered it — to
// blocked-sources-log.csv in the repo root (gitignored), and prints a short
// summary. Reading the table needs the service-role key, so set these in the
// environment first (never commit them):
//
//   SUPABASE_URL           https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY   the service_role key (Supabase → Project Settings → API)
//
// Optional: --since YYYY-MM-DD to limit the export.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY (the service_role key) first.');
    process.exit(1);
  }
  const i = process.argv.indexOf('--since');
  const since = i > -1 ? process.argv[i + 1] : null;

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('blocked_sources')
      .select('created_at, stage, url, question')
      .order('created_at', { ascending: false })
      .range(from, from + 999);
    if (since) q = q.gte('created_at', since);
    const { data, error } = await q;
    if (error) {
      console.error(`Could not read blocked_sources: ${error.message}`);
      console.error('If the table does not exist yet, run the blocked_sources block in supabase/grants.sql.');
      process.exit(1);
    }
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const out = path.join(__dirname, '..', 'blocked-sources-log.csv');
  const lines = ['created_at,stage,url,question', ...rows.map((r) => [r.created_at, r.stage, r.url, r.question].map(csvCell).join(','))];
  fs.writeFileSync(out, lines.join('\n') + '\n');

  console.log(`${rows.length} blocked URL(s)${since ? ` since ${since}` : ''} → ${path.relative(process.cwd(), out)}`);
  const counts = {};
  for (const r of rows) {
    const m = /pelhamexaminer\.com\/\d+\/([^/]+)\//.exec(r.url || '');
    let k;
    try { k = m ? `pelhamexaminer.com /${m[1]}/` : new URL(r.url).hostname; } catch { k = '(unparseable)'; }
    counts[k] = (counts[k] || 0) + 1;
  }
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
}

main();
