// UI tests for the Pelham Civic Guide.
//
// The site is nine generated pages sharing one shell. These cover: the shared
// chrome (nav, More menu, mobile drawer, footer) which must work identically
// everywhere; the home digest; and the content pages the digest links to.
//
// Run locally with `npm run test:local`, which builds first and serves the
// working tree. `npm test` runs the same suite against the deployed site.

const { test, expect } = require('@playwright/test');

// Every page in the nav, in nav order. Several tests walk all of them — the
// point of a shared shell is that the chrome cannot differ between pages.
const PAGES = [
  { id: 'home',         url: '/',             label: 'Home' },
  { id: 'issues',       url: '/issues',       label: 'Issues' },
  { id: 'elections',    url: '/elections',    label: 'Elections' },
  { id: 'meetings',     url: '/meetings',     label: 'Meetings' },
  { id: 'get-involved', url: '/get-involved', label: 'Get Involved' },
  { id: 'taxes',        url: '/taxes',        label: 'Taxes' },
  { id: 'gov-101',      url: '/gov-101',      label: 'Gov 101' },
  { id: 'ask-ai',       url: '/ask',          label: 'Ask AI' },
  { id: 'about',        url: '/about',        label: 'About' },
];

/* ── Every page loads and is a single well-formed document ───────────────
 * A bad paste once spliced a second copy of the whole document into the
 * middle of the page. Browsers recover silently and every selector still
 * matched the first hit, so the suite stayed green while the live page
 * rendered its hero twice. Counting singleton landmarks is what catches it.
 */
for (const pg of PAGES) {
  test(`${pg.id} — loads, single document, no duplicate ids`, async ({ page }) => {
    const res = await page.goto(pg.url);
    expect(res.status(), `${pg.url} should not 404`).toBeLessThan(400);

    await expect(page).toHaveTitle(/Pelham Engagement Project/i);
    await expect(page.locator('nav.nav-bar')).toHaveCount(1);
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.locator('footer')).toHaveCount(1);

    const duplicates = await page.evaluate(() => {
      const counts = new Map();
      for (const el of document.querySelectorAll('[id]')) {
        counts.set(el.id, (counts.get(el.id) || 0) + 1);
      }
      return [...counts.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} (${n}x)`);
    });
    expect(duplicates, `duplicate ids: ${duplicates.join(', ')}`).toEqual([]);
  });
}

/* ── Shared navigation ─────────────────────────────────────────────────── */

test('nav — five primary links plus a More menu holding the other four', async ({ page }) => {
  await page.goto('/');
  const nav = page.locator('nav.nav-bar');

  for (const pg of PAGES.filter((x) => ['home', 'issues', 'elections', 'meetings', 'get-involved'].includes(x.id))) {
    await expect(nav.locator(`.nav-link[href="${pg.url}"]`)).toBeVisible();
  }

  const menu = page.locator('#nav-more-menu');
  await expect(menu).toBeHidden();
  await page.click('#nav-more');
  await expect(menu).toBeVisible();
  for (const pg of PAGES.filter((x) => ['taxes', 'gov-101', 'ask-ai', 'about'].includes(x.id))) {
    await expect(menu.locator(`a[href="${pg.url}"]`)).toBeVisible();
  }

  // Escape closes it and returns focus, so keyboard users are not stranded.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('#nav-more')).toBeFocused();
});

test('nav — the current page is marked on every page', async ({ page }) => {
  for (const pg of PAGES) {
    await page.goto(pg.url);
    const current = page.locator('nav.nav-bar [aria-current="page"], #nav-more-menu [aria-current="page"]');
    await expect(current, `${pg.id} should mark itself current`).toHaveCount(1);
    await expect(current).toHaveAttribute('href', pg.url);
  }
});

test('nav — Elections carries a dated badge that expires on its own', async ({ page }) => {
  await page.goto('/');
  const badge = page.locator('nav.nav-bar .nav-badge').first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Nov 3');
  // The date travels with the badge so the page can retire it without a
  // rebuild; a build-time check alone would leave it showing into December.
  await expect(badge).toHaveAttribute('data-hide-after', '2026-11-03');
});

test('nav — mobile drawer opens from the left, lists all nine pages, and closes', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto('/');

  const burger = page.locator('#nav-burger');
  const drawer = page.locator('#nav-drawer');
  await expect(burger).toBeVisible();
  await expect(page.locator('.nav-links')).toBeHidden();
  await expect(drawer).toBeHidden();

  await burger.click();
  await expect(drawer).toBeVisible();
  await expect(burger).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.locator('a')).toHaveCount(PAGES.length);

  // Anchored to the left edge.
  const box = await drawer.boundingBox();
  expect(box.x).toBeLessThan(5);

  await expect(drawer.locator('.nav-drawer-note')).toContainText('AI-generated');

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(burger).toHaveAttribute('aria-expanded', 'false');
});

test('nav — drawer links navigate and mark the new page', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto('/');
  await page.click('#nav-burger');
  await page.locator('#nav-drawer a[href="/elections"]').click();
  await expect(page).toHaveURL(/\/elections$/);
  await expect(page.locator('#nav-drawer a[href="/elections"]')).toHaveAttribute('aria-current', 'page');
});

/* ── Home digest ───────────────────────────────────────────────────────── */

test('home — hero stats, with governing bodies linking to Gov 101', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.hero-stats .stat')).toHaveCount(4);

  const govStat = page.locator('a.stat[href="/gov-101"]');
  await expect(govStat).toBeVisible();
  await expect(govStat).toContainText('5');
  await govStat.click();
  await expect(page).toHaveURL(/\/gov-101$/);
  await expect(page.getByRole('heading', { name: /Who Actually Governs Pelham/i })).toBeVisible();
});

test('home — digest shows at most four issues and links to the full list', async ({ page }) => {
  await page.goto('/');
  const cards = page.locator('#home-issues .issue-card');
  const n = await cards.count();
  expect(n).toBeGreaterThan(0);
  expect(n, 'the digest should be a preview, not the whole list').toBeLessThanOrEqual(4);

  // Most urgent first: an active issue must not sit below a resolved one.
  const statuses = await cards.locator('.status-dot').evaluateAll((els) =>
    els.map((e) => [...e.classList].find((c) => c.startsWith('dot-'))));
  const rank = { 'dot-active': 0, 'dot-watch': 1, 'dot-resolved': 2 };
  const ranks = statuses.map((s) => rank[s]);
  expect(ranks, `ordering was ${statuses.join(', ')}`).toEqual([...ranks].sort((a, b) => a - b));

  await page.click('#home-issues .digest-more');
  await expect(page).toHaveURL(/\/issues$/);
});

test('home — one meeting card per board, linking to the meetings page', async ({ page }) => {
  await page.goto('/');
  const cards = page.locator('.mtg-card');
  await expect(cards).toHaveCount(4);

  const bodies = await cards.locator('.mtg-card-body').allTextContents();
  expect(new Set(bodies).size, 'one card per board, no repeats').toBe(4);

  await page.click('#home-meetings .digest-more');
  await expect(page).toHaveURL(/\/meetings$/);
});

test('home — election banner links through and carries its expiry', async ({ page }) => {
  await page.goto('/');
  const banner = page.locator('.home-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-hide-after', '2026-11-03');
  await expect(banner).toContainText('November 3, 2026');
  await banner.click();
  await expect(page).toHaveURL(/\/elections$/);
});

test('home — Get Involved teaser links to the full page', async ({ page }) => {
  await page.goto('/');
  await page.click('#home-involved .digest-more');
  await expect(page).toHaveURL(/\/get-involved$/);
});

/* ── Content pages ─────────────────────────────────────────────────────── */

test('issues — every tracked issue is listed, each with a source', async ({ page }) => {
  await page.goto('/issues');
  const cards = page.locator('.issue-card');
  // More than the homepage digest shows — that is the point of the page.
  expect(await cards.count()).toBeGreaterThan(4);
  await expect(page.locator('.issue-card .issue-source-link').first()).toBeVisible();
});

test('elections — three race blocks and every candidate named', async ({ page }) => {
  await page.goto('/elections');
  await expect(page.locator('.race-block')).toHaveCount(3);
  for (const name of ['Solomon', 'Howell', 'Burke', 'Long', 'Speros', 'Anzilotti']) {
    await expect(page.locator('main')).toContainText(name);
  }
});

test('taxes — the breakdown renders', async ({ page }) => {
  await page.goto('/taxes');
  await expect(page.getByRole('heading', { name: /Where Do Your Property Taxes Go/i })).toBeVisible();
  await expect(page.locator('.tax-bar-row')).toHaveCount(4);
});

test('gov-101 — the five governing bodies plus the quick-reference card', async ({ page }) => {
  await page.goto('/gov-101');
  await expect(page.locator('.gov-card')).toHaveCount(6);
  await expect(page.locator('main')).toContainText('Westchester County');
  await expect(page.locator('main')).toContainText('Who to call for what?');
});

test('get-involved — the four engagement steps and the meeting chips', async ({ page }) => {
  await page.goto('/get-involved');
  await expect(page.locator('.ladder-step')).toHaveCount(4);
  await expect(page.locator('.ladder-step').first()).toContainText('Start with a conversation');
  await expect(page.locator('.meeting-chip')).toHaveCount(4);
});

/* ── Meetings page: the full archive ───────────────────────────────────── */

const meetingButton = (page, id) => page.locator(`.mtg-selector[data-meeting="${id}"]`);
const detailTab = (page, label) => page.locator('.detail-tab', { hasText: label });
const panel = (page, meeting, tab) => page.locator(`#panel-${meeting}-${tab}`);

const VILLAGE_SEP = 'pelham-board-sep2026';
const TOWN_AUG = 'town-council-aug2026';

test('meetings — every processed meeting is selectable, including superseded ones', async ({ page }) => {
  await page.goto('/meetings');
  const ids = await page.locator('.mtg-selector').evaluateAll((els) => els.map((e) => e.dataset.meeting));
  // The homepage shows the latest per board; this page is the archive, so the
  // older meetings that have no home-page card must be reachable here.
  expect(ids).toContain('pelham-board-jul2026');
  expect(ids).toContain(TOWN_AUG);
  expect(ids).toContain('board-of-ed-jun2026');
  expect(ids.length).toBeGreaterThanOrEqual(8);

  for (const id of ids) {
    await meetingButton(page, id).click();
    const set = page.locator(`.mtg-set[data-meeting="${id}"]`);
    await expect(set, `no panel set for "${id}"`).toBeVisible();
    await expect(set.locator('.mtg-panel[data-tab="exec"]')).toBeVisible();
    await expect(page.locator('#mtg-placeholder')).toBeHidden();
  }
});

test('meetings — detail tabs scope to the selected meeting', async ({ page }) => {
  await page.goto('/meetings');
  await meetingButton(page, TOWN_AUG).click();

  await detailTab(page, 'Detailed Summary').click();
  await expect(panel(page, TOWN_AUG, 'detailed')).toBeVisible();
  await expect(panel(page, TOWN_AUG, 'detailed')).toContainText('Bruno Barbosa');
  // A tab click must not reveal another meeting's panel of the same name.
  await expect(panel(page, VILLAGE_SEP, 'detailed')).toBeHidden();

  await detailTab(page, 'Full Transcript').click();
  await expect(panel(page, TOWN_AUG, 'transcript')).toBeVisible();
});

test('meetings — switching back resets to the Executive Summary tab', async ({ page }) => {
  await page.goto('/meetings');
  await meetingButton(page, TOWN_AUG).click();
  await detailTab(page, 'Full Transcript').click();
  await expect(panel(page, TOWN_AUG, 'transcript')).toBeVisible();

  await meetingButton(page, VILLAGE_SEP).click();
  await expect(panel(page, VILLAGE_SEP, 'exec')).toBeVisible();
  await expect(panel(page, VILLAGE_SEP, 'transcript')).toBeHidden();
  await expect(detailTab(page, 'Executive Summary')).toHaveClass(/active-tab/);
});

test('meetings — the schedule table lists every board', async ({ page }) => {
  await page.goto('/meetings');
  await expect(page.locator('.meetings-table tbody tr')).toHaveCount(5);
  await expect(page.locator('.meetings-table')).toContainText('Daronco Town House');
});

/* ── Ask Pelham ────────────────────────────────────────────────────────── */

test('home — asking a question renders an answer bubble', async ({ page }) => {
  await page.route('**/api/ask', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ answer: 'Test answer.' }),
  }));
  await page.goto('/');
  await page.fill('#ai-input', 'Who is the mayor?');
  await page.click('#ask-btn');
  await expect(page.locator('.chat-bubble.assistant')).toContainText('Test answer.');
});

/* Chat bubbles are built with innerHTML, so anything the reader types — or
 * anything the model returns — reaches the DOM as markup unless it is escaped
 * first. The assistant path matters as much as the user path: the answer text
 * arrives from the network. */
test('escapes XSS in chat bubbles', async ({ page }) => {
  const PAYLOAD = '<img src=x onerror=alert(1)>';

  let dialogFired = false;
  page.on('dialog', async (d) => { dialogFired = true; await d.dismiss(); });

  await page.route('**/api/ask', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ answer: `Echo: ${PAYLOAD}` }),
  }));

  await page.goto('/');
  await page.fill('#ai-input', PAYLOAD);
  await page.click('#ask-btn');

  const chat = page.locator('#chat-window');
  await expect(chat.locator('.chat-bubble.assistant .bubble-text')).toBeVisible();

  // The payload survives as literal text the reader can see...
  await expect(chat.locator('.chat-bubble.user .bubble-text')).toHaveText(PAYLOAD);
  await expect(chat.locator('.chat-bubble.assistant .bubble-text')).toContainText(PAYLOAD);

  // ...and never becomes markup. Asserting on innerHTML would not work here:
  // correct escaping leaves the literal characters "onerror" in the serialized
  // HTML as &lt;img src=x onerror=alert(1)&gt;. What distinguishes escaped from
  // executed is whether an element was created at all.
  await expect(chat.locator('img')).toHaveCount(0);
  const injected = await page.evaluate(() =>
    document.querySelectorAll('#chat-window [onerror], #chat-window script, #chat-window img').length);
  expect(injected, 'payload created DOM nodes instead of being escaped').toBe(0);
  expect(dialogFired, 'an alert() fired — the payload executed').toBe(false);
});

test('answer feedback — a failed vote is not shown as recorded, and can be retried', async ({ page }) => {
  let feedbackStatus = 500;
  // The chat call and the feedback call hit the same endpoint; tell them apart
  // by payload so the answer always arrives and only the vote fails.
  await page.route('**/api/ask', (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.type === 'feedback') {
      return route.fulfill({ status: feedbackStatus, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ answer: 'Test answer.' }),
    });
  });

  await page.goto('/');
  await page.fill('#ai-input', 'What is the village budget?');
  await page.click('#ask-btn');

  const row = page.locator('.feedback-row').first();
  const thumbsUp = row.locator('.btn-up');
  const note = row.locator('.feedback-thanks');
  await expect(thumbsUp).toBeVisible();

  await thumbsUp.click();
  await expect(note).toContainText("Couldn't save");
  await expect(note).toHaveClass(/is-error/);
  // Not marked as cast, and clickable again — the old version disabled the
  // buttons immediately, so a dropped vote could never be retried.
  await expect(thumbsUp).not.toHaveClass(/selected-up/);
  await expect(thumbsUp).toBeEnabled();

  feedbackStatus = 200;
  await thumbsUp.click();
  await expect(note).toContainText('Thanks');
  await expect(note).not.toHaveClass(/is-error/);
  await expect(thumbsUp).toHaveClass(/selected-up/);
  await expect(thumbsUp).toBeDisabled();
});

/* ── About page forms ──────────────────────────────────────────────────── */

test('error correction form — reports failure on a rejected write, success on a stored one', async ({ page }) => {
  let status = 500;
  await page.route('**/api/ask', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: '{}' }),
  );

  await page.goto('/about');
  await page.selectOption('#error-section', 'Who Governs');
  await page.fill('#error-desc', 'Test: the trustee list is missing a name.');
  await page.fill('#error-source', 'https://www.pelhamny.gov');
  await page.click('.btn-submit-correction');

  const confirm = page.locator('#error-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('was not saved');
  await expect(confirm).toHaveClass(/is-error/);
  // The form must stay editable so "try again" is actually possible.
  await expect(page.locator('#error-form')).not.toHaveCSS('opacity', '0.5');

  status = 200;
  await page.click('.btn-submit-correction');
  await expect(confirm).toContainText('Correction received');
  await expect(confirm).not.toHaveClass(/is-error/);
});

test('civic engagement form — reports failure on a rejected write, success on a stored one', async ({ page }) => {
  let status = 500;
  await page.route('**/api/ask', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: '{}' }),
  );

  await page.goto('/about');
  await page.check('#fb-attended');
  await page.click('#fb-share-btn');

  const confirm = page.locator('#fb-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('was not saved');
  await expect(confirm).toHaveClass(/is-error/);

  status = 200;
  await page.click('#fb-share-btn');
  await expect(confirm).toContainText('Thanks for sharing');
  await expect(confirm).not.toHaveClass(/is-error/);
});

/* ── Animation ─────────────────────────────────────────────────────────── */

test('fade-in sections become visible on scroll', async ({ page }) => {
  await page.goto('/issues');
  const deep = page.locator('.fade-in').last();
  await expect(deep).toBeAttached();

  await page.evaluate(async () => {
    for (let y = 0; y <= document.body.scrollHeight; y += 300) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 25));
    }
    window.scrollTo(0, document.body.scrollHeight);
  });

  await expect(deep).toHaveClass(/(^|\s)visible(\s|$)/);
});
