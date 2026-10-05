// Unit tests for netlify/functions/unsubscribe.js and digest-approve.js. No
// browser and no network: each handler runs against an in-memory stand-in
// for the supabase-js calls it makes.

const { test, expect } = require('@playwright/test');
const unsub = require('../netlify/functions/unsubscribe');
const approve = require('../netlify/functions/digest-approve');

// select/eq/is/maybeSingle, and update(...).eq/is(...).select(...), awaited.
function fakeDb(tables, { error = null } = {}) {
  return {
    from(name) {
      const rows = tables[name];
      const filters = [];
      let update = null;
      const match = () => rows.filter((r) => filters.every((f) => f(r)));
      const api = {
        select: () => api,
        update: (vals) => { update = vals; return api; },
        eq: (c, v) => { filters.push((r) => r[c] === v); return api; },
        is: (c, v) => { filters.push((r) => (r[c] ?? null) === v); return api; },
        maybeSingle: async () => (error ? { data: null, error } : { data: match()[0] || null, error: null }),
        then: (resolve, reject) => {
          if (error) return Promise.resolve({ data: null, error }).then(resolve, reject);
          const hit = match();
          if (update) hit.forEach((r) => Object.assign(r, update));
          return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

const get = (qs) => ({ httpMethod: 'GET', queryStringParameters: qs });
const postTo = (qs, body = '') => ({ httpMethod: 'POST', queryStringParameters: qs, body,
  headers: { 'content-type': 'application/x-www-form-urlencoded' } });

/* ── unsubscribe ───────────────────────────────────────────────────────── */

const TOKEN = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

test('unsubscribe — GET only shows a confirm button; it changes nothing', async () => {
  const tables = { subscribers: [{ id: 1, unsubscribe_token: TOKEN, unsubscribed_at: null }] };
  const res = await unsub.createHandler(() => fakeDb(tables))(get({ token: TOKEN }));
  expect(res.statusCode).toBe(200);
  expect(res.headers['Cache-Control']).toBe('no-store');
  expect(res.body).toContain('Unsubscribe from the Pelham Civic Digest?');
  expect(res.body).toContain('method="post"');
  expect(tables.subscribers[0].unsubscribed_at).toBeNull();
});

test('unsubscribe — POST sets unsubscribed_at once; a second click says already', async () => {
  const tables = { subscribers: [{ id: 1, unsubscribe_token: TOKEN, unsubscribed_at: null }] };
  const handler = unsub.createHandler(() => fakeDb(tables));
  const res = await handler(postTo({ token: TOKEN }));
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("You've been unsubscribed from the Pelham Civic Digest. You won't receive any more emails from us.");
  expect(res.body).toContain('Visit pelhamengagementproject.org →');
  const first = tables.subscribers[0].unsubscribed_at;
  expect(first).toBeTruthy();

  const again = await handler(postTo({ token: TOKEN }));
  expect(again.body).toContain("You're already unsubscribed.");
  expect(tables.subscribers[0].unsubscribed_at).toBe(first);
  expect((await handler(get({ token: TOKEN }))).body).toContain("You're already unsubscribed.");
});

test('unsubscribe — RFC 8058 one-click POST works, token in the query string', async () => {
  const tables = { subscribers: [{ id: 1, unsubscribe_token: TOKEN, unsubscribed_at: null }] };
  const res = await unsub.createHandler(() => fakeDb(tables))(postTo({ token: TOKEN }, 'List-Unsubscribe=One-Click'));
  expect(res.statusCode).toBe(200);
  expect(tables.subscribers[0].unsubscribed_at).toBeTruthy();
});

test('unsubscribe — unknown or malformed tokens are invalid; the draft-preview token is explained', async () => {
  const handler = unsub.createHandler(() => fakeDb({ subscribers: [] }));
  for (const token of ['9e1c2b3a-0000-4000-8000-000000000001', 'nope', '', undefined]) {
    const res = await handler(get({ token }));
    expect(res.statusCode, String(token)).toBe(404);
    expect(res.body).toContain('This unsubscribe link is invalid or has already been used.');
  }
  const preview = await handler(get({ token: '00000000-0000-0000-0000-000000000000' }));
  expect(preview.body).toContain('draft preview');
});

test('unsubscribe — missing config, database errors and other methods fail visibly', async () => {
  expect((await unsub.createHandler(() => null)(get({ token: TOKEN }))).statusCode).toBe(500);
  const broken = unsub.createHandler(() => fakeDb({ subscribers: [] }, { error: { message: 'boom' } }));
  expect((await broken(postTo({ token: TOKEN }))).statusCode).toBe(502);
  expect((await unsub.createHandler(() => null)({ httpMethod: 'PUT' })).statusCode).toBe(405);
});

/* ── digest-approve ────────────────────────────────────────────────────── */

const DIGEST_ID = '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';
const SECRET = 'test-secret-value';
const digestRow = (over = {}) => ({ id: DIGEST_ID, subject: 'Pelham Civic Digest — October 2026', status: 'draft',
  created_at: '2026-10-26T13:00:00Z', html_body: '<p>Body</p><a href="{{unsubscribe_url}}">Unsubscribe</a>', ...over });

test.describe('digest-approve', () => {
  const saved = process.env.DIGEST_APPROVAL_SECRET;
  test.beforeEach(() => { process.env.DIGEST_APPROVAL_SECRET = SECRET; });
  test.afterAll(() => {
    if (saved === undefined) delete process.env.DIGEST_APPROVAL_SECRET;
    else process.env.DIGEST_APPROVAL_SECRET = saved;
  });
  // The Tuesday after the October 2026 draft Monday (the 26th); send is Thursday the 29th.
  const tuesday = () => new Date('2026-10-27T15:00:00Z');

  test('a wrong or missing secret is 403 and changes nothing; an unset secret is 500', async () => {
    const tables = { digests: [digestRow()] };
    const handler = approve.createHandler(() => fakeDb(tables), { now: tuesday });
    for (const secret of ['wrong', '', undefined]) {
      expect((await handler(get({ token: DIGEST_ID, secret }))).statusCode).toBe(403);
      expect((await handler(postTo({ token: DIGEST_ID, secret }))).statusCode).toBe(403);
    }
    expect(tables.digests[0].status).toBe('draft');
    delete process.env.DIGEST_APPROVAL_SECRET;
    expect((await handler(get({ token: DIGEST_ID, secret: SECRET }))).statusCode).toBe(500);
  });

  test('GET shows the digest and an Approve button, but approves nothing', async () => {
    const tables = { digests: [digestRow()] };
    const res = await approve.createHandler(() => fakeDb(tables), { now: tuesday })(get({ token: DIGEST_ID, secret: SECRET }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
    expect(res.body).toContain('Pelham Civic Digest — October 2026');
    expect(res.body).toContain('If approved, it will be sent to subscribers on Thursday, October 29 at 12:00 UTC.');
    expect(res.body).toContain('method="post"');
    expect(tables.digests[0].status).toBe('draft');
  });

  test('POST approves a draft; repeat clicks and sent digests are reported, not changed', async () => {
    const tables = { digests: [digestRow()] };
    const handler = approve.createHandler(() => fakeDb(tables), { now: tuesday });
    const res = await handler(postTo({ token: DIGEST_ID, secret: SECRET }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Digest approved! It will be sent to subscribers on Thursday, October 29 at 12:00 UTC.');
    expect(res.body).toContain('View digest preview →');
    expect(res.body).toContain('Return to site →');
    expect(tables.digests[0].status).toBe('approved');

    expect((await handler(postTo({ token: DIGEST_ID, secret: SECRET }))).body).toContain('This digest has already been approved.');
    tables.digests[0].status = 'sent';
    expect((await handler(postTo({ token: DIGEST_ID, secret: SECRET }))).body).toContain('This digest has already been sent.');
    expect((await handler(get({ token: DIGEST_ID, secret: SECRET }))).body).toContain('This digest has already been sent.');
    expect(tables.digests[0].status).toBe('sent');
  });

  test('approving after the scheduled Thursday says it will not go out on its own', async () => {
    const tables = { digests: [digestRow()] };
    const friday = () => new Date('2026-10-30T09:00:00Z');
    const res = await approve.createHandler(() => fakeDb(tables), { now: friday })(postTo({ token: DIGEST_ID, secret: SECRET }));
    expect(res.body).toContain('will not go out automatically');
    expect(res.body).toContain(`python check_digest.py --send ${DIGEST_ID}`);
  });

  test('the preview shows the stored digest with the unsubscribe placeholder neutralised', async () => {
    const tables = { digests: [digestRow()] };
    const res = await approve.createHandler(() => fakeDb(tables), { now: tuesday })(get({ token: DIGEST_ID, secret: SECRET, view: 'preview' }));
    expect(res.body).toContain('<p>Body</p>');
    expect(res.body).not.toContain('{{unsubscribe_url}}');
    expect(res.body).toContain('Not sent from this page');
  });

  test('an unknown digest is a 404', async () => {
    const handler = approve.createHandler(() => fakeDb({ digests: [] }), { now: tuesday });
    expect((await handler(get({ token: DIGEST_ID, secret: SECRET }))).statusCode).toBe(404);
    expect((await handler(get({ token: 'not-a-uuid', secret: SECRET }))).statusCode).toBe(404);
  });
});

test('digest-approve — send date follows check_digest.py: Thursday after the last Monday, 12:00 UTC', async () => {
  const at = (iso) => { const d = approve.sendDateFor(iso); return d && d.toISOString(); };
  // Drafted on the last Monday of October 2026 (the 26th): Thursday the 29th.
  expect(at('2026-10-26T13:00:00Z')).toBe('2026-10-29T12:00:00.000Z');
  // The last Monday of November is the 30th; its Thursday falls in December.
  expect(at('2026-12-01T10:00:00Z')).toBe('2026-12-03T12:00:00.000Z');
  // Drafted mid-month with --force: --send-approved never picks it up.
  expect(at('2026-10-12T13:00:00Z')).toBeNull();
  // Drafted after that cycle's Thursday run: also never.
  expect(at('2026-10-29T13:00:00Z')).toBeNull();
});
