// Unit tests for netlify/functions/subscribe.js. No browser and no network:
// the handler is built around a stub Supabase client that records what it
// was asked to insert and returns whatever error the test chooses.

const { test, expect } = require('@playwright/test');
const { createHandler } = require('../netlify/functions/subscribe');

function stubClient(error = null) {
  const inserted = [];
  const client = {
    from(table) {
      return { insert: async (row) => { inserted.push({ table, row }); return { error }; } };
    },
  };
  return { client, inserted };
}

const post = (body) => ({ httpMethod: 'POST', body: JSON.stringify(body) });
const parse = (res) => JSON.parse(res.body);

test('subscribe — stores a valid address, lowercased and trimmed, with its source', async () => {
  const { client, inserted } = stubClient();
  const res = await createHandler(() => client)(post({ email: '  Reader@Example.COM ', source: 'home' }));
  expect(res.statusCode).toBe(200);
  expect(parse(res)).toEqual({ ok: true });
  expect(inserted).toEqual([{ table: 'subscribers', row: { email: 'reader@example.com', source: 'home' } }]);
});

test('subscribe — an address already on the list is success, not an error', async () => {
  const { client } = stubClient({ code: '23505', message: 'duplicate key value violates unique constraint' });
  const res = await createHandler(() => client)(post({ email: 'reader@example.com', source: 'get-involved' }));
  expect(res.statusCode).toBe(200);
  expect(parse(res)).toEqual({ ok: true });
});

test('subscribe — any other database error is reported, not hidden', async () => {
  const { client } = stubClient({ code: '42501', message: 'permission denied for table subscribers' });
  const res = await createHandler(() => client)(post({ email: 'reader@example.com', source: 'home' }));
  expect(res.statusCode).toBe(502);
  expect(parse(res).ok).toBeUndefined();
});

test('subscribe — rejects malformed addresses without touching the database', async () => {
  for (const email of ['', 'no-at-sign', 'a@b', 'two words@example.com', null, 42, 'x'.repeat(250) + '@example.com']) {
    const { client, inserted } = stubClient();
    const res = await createHandler(() => client)(post({ email, source: 'home' }));
    expect(res.statusCode, String(email)).toBe(400);
    expect(inserted).toHaveLength(0);
  }
});

test('subscribe — an unknown source is stored as null', async () => {
  const { client, inserted } = stubClient();
  await createHandler(() => client)(post({ email: 'reader@example.com', source: '<script>' }));
  expect(inserted[0].row.source).toBeNull();
});

test('subscribe — a filled honeypot gets ok but stores nothing', async () => {
  const { client, inserted } = stubClient();
  const res = await createHandler(() => client)(post({ email: 'bot@example.com', source: 'home', website: 'http://spam' }));
  expect(parse(res)).toEqual({ ok: true });
  expect(inserted).toHaveLength(0);
});

test('subscribe — only POST, only JSON, and a clear error when Supabase is not configured', async () => {
  const handler = createHandler(() => null);
  expect((await handler({ httpMethod: 'GET' })).statusCode).toBe(405);
  expect((await handler({ httpMethod: 'POST', body: '{not json' })).statusCode).toBe(400);
  const res = await handler(post({ email: 'reader@example.com', source: 'home' }));
  expect(res.statusCode).toBe(500);
  expect(parse(res).error).toContain('SUPABASE_URL');
});
