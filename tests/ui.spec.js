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


/* ── Shared page furniture ─────────────────────────────────────────────── */

test('every content page carries the Ask Pelham AI CTA, and only those that should', async ({ page }) => {
  // Home has the Ask box itself; the Ask page would be linking to itself.
  const EXPECTED = new Set(PAGES.map((p) => p.id).filter((id) => !['home', 'ask-ai'].includes(id)));

  for (const pg of PAGES) {
    await page.goto(pg.url);
    const cta = page.locator('.ask-cta');
    if (EXPECTED.has(pg.id)) {
      await expect(cta, `${pg.id} should have the CTA`).toHaveCount(1);
      await expect(cta.locator('a[href="/ask"]')).toContainText('Ask Pelham AI');
      // Last thing in main, above the footer.
      const ctaY = (await cta.boundingBox()).y;
      const footY = (await page.locator('footer').boundingBox()).y;
      expect(ctaY, `${pg.id}: CTA should sit above the footer`).toBeLessThan(footY);
    } else {
      await expect(cta, `${pg.id} should not link to itself`).toHaveCount(0);
    }
  }
});

test('every page footer offers the feedback link, and it lands on a real target', async ({ page }) => {
  for (const pg of PAGES) {
    await page.goto(pg.url);
    const link = page.locator('footer .footer-feedback a[href="/about#feedback"]');
    await expect(link, `${pg.id} footer should offer feedback`).toHaveCount(1);
    await expect(link).toContainText('Share feedback');
  }

  // The anchor has to exist, or the link silently lands at the top of /about.
  await page.goto('/about#feedback');
  await expect(page.locator('#feedback')).toBeVisible();
  await expect(page.locator('#feedback')).toContainText('Community Feedback');
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

// The issue cards in display order, computed here independently of the
// build: active, then watch, then resolved; within a status, last_updated
// newest first; issues.json order breaks ties. Hidden cards are dropped.
function displayedIssues() {
  const fs = require('fs');
  const path = require('path');
  const { issues } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'content/issues.json'), 'utf8'));
  const rank = { active: 0, watch: 1, resolved: 2 };
  return issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => issue.show_on_home !== false)
    .sort((a, b) => (rank[a.issue.status] - rank[b.issue.status])
      || (a.issue.last_updated < b.issue.last_updated ? 1 : a.issue.last_updated > b.issue.last_updated ? -1 : 0)
      || (a.index - b.index))
    .map(({ issue }) => issue);
}

test('issues — cards are ordered active, then watch, then resolved, newest update first', async ({ page }) => {
  await page.goto('/issues');
  const ids = await page.locator('.issue-card[id]').evaluateAll((els) => els.map((e) => e.id));
  expect(ids).toEqual(displayedIssues().map((i) => i.id));
  // Status runs never interleave: once a lower-priority status appears, a
  // higher one cannot follow it.
  const dots = await page.locator('.issue-card .status-dot').evaluateAll((els) =>
    els.map((e) => ({ 'dot-active': 0, 'dot-watch': 1, 'dot-resolved': 2 })[[...e.classList].find((c) => c.startsWith('dot-'))]));
  expect(dots).toEqual([...dots].sort((a, b) => a - b));
});

test('home — digest shows the same first three issues as the Issues page, in the same order', async ({ page }) => {
  await page.goto('/');
  const cards = page.locator('#home-issues .issue-card');
  expect(await cards.count(), 'the digest shows three in one row').toBe(3);
  const home = await cards.locator('h3').allTextContents();

  // The first three in display order, the same three that open /issues.
  expect(home).toEqual(displayedIssues().slice(0, 3).map((i) => i.title));

  await page.click('#home-issues .digest-more');
  await expect(page).toHaveURL(/\/issues$/);
  const issuesPage = await page.locator('.issue-card h3').allTextContents();
  expect(issuesPage.slice(0, 3)).toEqual(home);
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

test('home — hero mission text comes from hero.json, and says "site" not "guide"', async ({ page }) => {
  await page.goto('/');
  const lead = page.locator('.hero-lead');
  await expect(lead).toHaveCount(2);
  await expect(lead.first()).toHaveText(/^The Pelham Engagement Project exists to increase civic awareness/);
  await expect(lead.nth(1)).toContainText('This site cuts through the complexity');
  await expect(page.locator('body')).not.toContainText('This guide');
});

test('home — election banner: date headline, countdown, button through to /elections', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-02T10:00:00'));
  await page.goto('/');
  const banner = page.locator('#home-election.home-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-hide-after', '2026-11-03');
  // The date is the headline of the notice, not a phrase inside a sentence.
  await expect(banner.locator('h2.home-banner-date')).toHaveText('November 3, 2026');
  await expect(banner.locator('.home-banner-countdown')).toHaveText('32 days away');
  await expect(banner.locator('.home-banner-text')).toContainText('contested races · ');
  // Sits between Current Issues and Meeting Summaries.
  await expect(page.locator('#home-issues + #home-election + #home-meetings')).toHaveCount(1);
  await banner.locator('a.home-banner-cta').click();
  await expect(page).toHaveURL(/\/elections$/);
});

test('home — election banner stays up through the evening of election day, then clears itself', async ({ page }) => {
  // 9:30pm local on November 3 is already November 4 in UTC.
  await page.clock.setFixedTime(new Date('2026-11-03T21:30:00'));
  await page.goto('/');
  await expect(page.locator('#home-election .home-banner-countdown')).toHaveText('Today');

  await page.clock.setFixedTime(new Date('2026-11-04T09:00:00'));
  await page.reload();
  await expect(page.locator('#home-election')).toHaveCount(0);
  await expect(page.locator('.nav-badge')).toHaveCount(0);
});

test('home — independence band sits last, above the footer, and links to About', async ({ page }) => {
  await page.goto('/');
  const band = page.locator('main > .home-about-band');
  await expect(band).toContainText('not affiliated with any candidate, party, or governing body');
  await expect(page.locator('main > :last-child')).toHaveClass(/home-about-band/);
  await band.locator('a', { hasText: 'Learn more' }).click();
  await expect(page).toHaveURL(/\/about$/);
});

test('signup — home form reports failure, then success, and sends source "home"', async ({ page }) => {
  let status = 502;
  let sent = null;
  await page.route('**/api/subscribe', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status, contentType: 'application/json', body: status === 200 ? '{"ok":true}' : '{}' });
  });
  await page.goto('/');
  // Slim band directly under the hero, above Current Issues, and the only
  // signup form on the page.
  await expect(page.locator('.hero + #signup.signup-slim + #home-issues')).toHaveCount(1);
  await expect(page.locator('.signup-form')).toHaveCount(1);
  const section = page.locator('#signup');
  await expect(section.locator('h2')).toHaveText('Stay informed');
  // The label is for screen readers; the band shows only the field and button.
  await expect(page.getByLabel('Email address')).toBeVisible();

  await section.locator('#signup-email').fill('Reader@Example.com ');
  await section.locator('.signup-btn').click();
  const msg = section.locator('.signup-msg');
  await expect(msg).toHaveText('Something went wrong — please try again.');
  await expect(msg).toHaveClass(/is-error/);
  await expect(section.locator('.signup-form')).toBeVisible();
  expect(sent).toEqual({ email: 'Reader@Example.com', source: 'home', website: '' });

  status = 200;
  await section.locator('.signup-btn').click();
  await expect(msg).toHaveText("You're on the list — we'll keep you informed about Pelham civic life.");
  await expect(msg).not.toHaveClass(/is-error/);
  await expect(section.locator('.signup-form')).toBeHidden();
});

test('signup — every form carries a privacy note: full on Get Involved and /subscribe, short on home', async ({ page }) => {
  for (const url of ['/get-involved', '/subscribe']) {
    await page.goto(url);
    await expect(page.locator('#signup .signup-note'), url)
      .toHaveText('Your email address is used only to send you civic updates about Pelham. It is never shared or sold.');
  }
  await page.goto('/');
  await expect(page.locator('#signup .signup-note')).toHaveText('Monthly civic updates about Pelham. Never shared or sold.');
});

test('ask button — floats on every page except /ask, links there, and steps aside for the footer', async ({ page }) => {
  for (const pg of PAGES.filter((x) => x.id !== 'ask-ai')) {
    await page.goto(pg.url);
    const fab = page.locator('a.ask-fab');
    await expect(fab, pg.url).toHaveCount(1);
    await expect(fab, pg.url).toHaveAttribute('href', '/ask');
    await expect(fab, pg.url).toHaveCSS('position', 'fixed');
  }
  await page.goto('/ask');
  await expect(page.locator('.ask-fab')).toHaveCount(0);

  await page.goto('/issues');
  const fab = page.locator('a.ask-fab');
  await expect(fab).toBeInViewport();
  await expect(fab).toHaveText('Ask Pelham AI');
  await expect(fab).toHaveAttribute('aria-label', 'Ask Pelham AI');
  // Bottom left, clear of Netlify's toolbar in the bottom-right corner.
  const box = await fab.boundingBox();
  const vp = page.viewportSize();
  expect(box.x).toBeLessThan(vp.width / 4);
  expect(box.y + box.height).toBeGreaterThan(vp.height - 100);
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect(fab).toHaveClass(/is-tucked/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(fab).not.toHaveClass(/is-tucked/);
  await fab.click();
  await expect(page).toHaveURL(/\/ask$/);
});

test('ask button — icon only on a phone, with an accessible name', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const fab = page.locator('a.ask-fab');
  await expect(fab).toHaveAttribute('aria-label', 'Ask Pelham AI');
  const box = await fab.boundingBox();
  expect(Math.round(box.width)).toBe(52);
  expect(Math.round(box.height)).toBe(52);
});

test('subscribe — standalone page: one document, the form as its h1, source "subscribe", in no menu', async ({ page }) => {
  let sent = null;
  await page.route('**/api/subscribe', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const res = await page.goto('/subscribe');
  expect(res.status()).toBeLessThan(400);
  await expect(page).toHaveTitle(/Stay informed about Pelham/);
  await expect(page.locator('main#main')).toHaveCount(1);
  await expect(page.locator('footer')).toHaveCount(1);
  const dupes = await page.evaluate(() => {
    const c = new Map();
    for (const el of document.querySelectorAll('[id]')) c.set(el.id, (c.get(el.id) || 0) + 1);
    return [...c].filter(([, n]) => n > 1).map(([id]) => id);
  });
  expect(dupes).toEqual([]);
  await expect(page.locator('h1')).toHaveText('Stay informed about Pelham');
  await expect(page.locator('#signup .section-intro')).toHaveText('Get monthly updates on local government, meetings, and civic issues — delivered to your inbox.');
  await expect(page.locator('#signup .signup-note')).toContainText('never shared or sold');
  // Reached by a shared link only: neither the desktop nav nor the drawer lists it.
  await expect(page.locator('nav.nav-bar a[href="/subscribe"], #nav-drawer a[href="/subscribe"]')).toHaveCount(0);

  await page.fill('#signup-email', 'reader@example.com');
  await page.click('#signup .signup-btn');
  await expect(page.locator('#signup .signup-msg')).toContainText("You're on the list");
  expect(sent.source).toBe('subscribe');
});

test('signup — submitting through the script does not reload the page', async ({ page }) => {
  await page.route('**/api/subscribe', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto('/');
  let navigations = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
  await page.fill('#signup-email', 'reader@example.com');
  await page.click('#signup .signup-btn');
  await expect(page.locator('#signup .signup-msg')).toContainText("You're on the list");
  expect(navigations).toBe(0);
  expect(page.url()).not.toContain('email=');
});

test('signup — the honeypot stays off screen even if the stylesheet fails to load', async ({ page }) => {
  await page.route('**/styles.css*', (route) => route.abort());
  await page.goto('/');
  const box = await page.locator('#signup-website').boundingBox();
  expect(box === null || box.x + box.width <= 0).toBe(true);
});

test('signup — without JavaScript the form still posts and gets a confirmation page', async ({ browser }) => {
  // The real function code, against a stub database, answers the native POST.
  const { createHandler } = require('../netlify/functions/subscribe');
  const inserted = [];
  const handler = createHandler(() => ({ from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; } }) }));
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.route('**/api/subscribe', async (route) => {
    const req = route.request();
    const res = await handler({ httpMethod: req.method(), headers: req.headers(), body: req.postData() });
    await route.fulfill({ status: res.statusCode, headers: res.headers, body: res.body });
  });
  await page.goto('/get-involved');
  await page.fill('#signup-email', 'nojs@example.com');
  // Enter submits natively. (A click needs Playwright's stability check,
  // which is unreliable with page JavaScript disabled.)
  await page.press('#signup-email', 'Enter');
  await expect(page.locator('body')).toContainText("You're on the list");
  expect(inserted).toEqual([{ email: 'nojs@example.com', source: 'get-involved' }]);
  await context.close();
});

test('assets — styles.css and app.js are linked with a hash of their current contents', async ({ page }) => {
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.resolve(__dirname, '..', f))).digest('hex').slice(0, 10);
  await page.goto('/');
  await expect(page.locator('link[rel="stylesheet"][href^="/styles.css"]')).toHaveAttribute('href', `/styles.css?v=${hash('styles.css')}`);
  await expect(page.locator('script[src^="/app.js"]')).toHaveAttribute('src', `/app.js?v=${hash('app.js')}`);
});

test('signup — an invalid address is stopped in the browser and never sent', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/subscribe', (route) => { calls++; return route.fulfill({ status: 200, body: '{"ok":true}' }); });
  await page.goto('/');
  await page.fill('#signup-email', 'not-an-email');
  await page.click('#signup .signup-btn');
  await expect(page.locator('#signup .signup-msg')).toBeHidden();
  expect(calls).toBe(0);
});

test('signup — Get Involved carries the form just before the Ask Pelham AI CTA, with source "get-involved"', async ({ page }) => {
  let sent = null;
  await page.route('**/api/subscribe', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto('/get-involved');
  await expect(page.locator('main > #signup + .ask-cta')).toHaveCount(1);
  await page.fill('#signup-email', 'neighbor@example.org');
  await page.click('#signup .signup-btn');
  await expect(page.locator('#signup .signup-msg')).toContainText("You're on the list");
  expect(sent.source).toBe('get-involved');
});

test('home — Get Involved teaser links to the full page', async ({ page }) => {
  await page.goto('/');
  await page.click('#home-involved .digest-more');
  await expect(page).toHaveURL(/\/get-involved$/);
});


test('nav — the active item is visibly marked, not just semantically', async ({ page }) => {
  await page.goto('/elections');
  const active = page.locator('nav.nav-bar .nav-link.is-active');
  await expect(active).toHaveText(/Elections/);
  // aria-current was emitted from the start but nothing rendered it, so the
  // bar looked identical on every page. Guard the styling, not just the class.
  await expect(active).toHaveCSS('font-weight', '700');
  const plain = page.locator('nav.nav-bar .nav-link', { hasText: 'Issues' });
  await expect(plain).not.toHaveCSS('font-weight', '700');
});

test('nav — Learn More trigger lines up with the other items', async ({ page }) => {
  await page.goto('/');
  const trigger = page.locator('#nav-more');
  await expect(trigger).toHaveText(/Learn More/);
  // It is a <button> among <a>s; if it misses the shared rules it sits at a
  // different height, which is what "visually consistent" means here.
  const a = await page.locator('nav.nav-bar .nav-link[href="/issues"]').boundingBox();
  const b = await trigger.boundingBox();
  expect(Math.abs(a.height - b.height), 'trigger height should match the links').toBeLessThan(2);
  expect(Math.abs(a.y - b.y), 'trigger should sit on the same baseline').toBeLessThan(2);
});

test('home — issue previews route by topic where one is set', async ({ page }) => {
  await page.goto('/');
  const hrefs = await page.locator('#home-issues .issue-card .issue-source-link')
    .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  // Every route resolves somewhere real: a topic page, or the issue's anchor.
  for (const h of hrefs) expect(h).toMatch(/^\/(taxes|elections|issues#[a-z0-9-]+)$/);
  // And each follows its card's link_to, where null means the card's own anchor.
  const expected = displayedIssues().slice(0, 3).map((i) => i.link_to || `/issues#${i.id}`);
  expect(hrefs).toEqual(expected);
});

test('issues — a /issues#<id> link scrolls to that card and highlights it', async ({ page }) => {
  // The last card on the page, so reaching it takes a real scroll. Taken from
  // issues.json rather than from a home preview: the previews may all route
  // to topic pages (/taxes, /elections) and carry no /issues# link at all.
  const id = displayedIssues().at(-1).id;
  await page.goto(`/issues#${id}`);
  const card = page.locator(`.issue-card#${id}`);
  await expect(card).toHaveCount(1);
  await expect(card).toHaveClass(/is-target/);
  await expect(card).toBeInViewport();
  // The glow is brief: the class comes off when the animation ends.
  await expect(card).not.toHaveClass(/is-target/, { timeout: 5000 });
});

test('issues — context strip sits at the top and links out', async ({ page }) => {
  await page.goto('/issues');
  const strip = page.locator('.context-strip');
  await expect(strip).toBeVisible();
  for (const href of ['/taxes', '/gov-101', '/ask']) {
    await expect(strip.locator(`a[href="${href}"]`)).toBeVisible();
  }
  // Between the page header and the cards: below the heading, above the
  // first card. A filter bar, when one exists, goes between it and the cards.
  const headingBox = await page.locator('h2.section-title').first().boundingBox();
  const stripBox = await strip.boundingBox();
  const cardBox = await page.locator('.issue-card').first().boundingBox();
  expect(stripBox.y, 'strip should sit below the heading').toBeGreaterThan(headingBox.y);
  expect(stripBox.y, 'strip should sit above the cards').toBeLessThan(cardBox.y);
});

test('elections — candidates with no published statement say so, muted, in the "why running" slot', async ({ page }) => {
  const fs = require('fs');
  const path = require('path');
  const { candidates } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'content/elections.json'), 'utf8'));
  const flagged = candidates.filter((c) => c.no_statement_as_of).map((c) => c.name);
  // Bennett and Liberatore were filled in from the August 19 announcement,
  // Kurtz from his October 7 statement; no candidate is flagged today.
  expect(flagged.sort()).toEqual([]);

  await page.goto('/elections');
  for (const c of candidates) {
    const card = page.locator('.candidate-card', { has: page.locator('.candidate-name', { hasText: c.name }) });
    const slot = card.locator('.profile-slot', { has: page.locator('.profile-label', { hasText: 'Why they say' }) });
    if (c.no_statement_as_of) {
      const note = slot.locator('.profile-value.profile-empty');
      await expect(note, c.name).toHaveText('No campaign statement has been published as of October 5, 2026.');
      await expect(note, c.name).toHaveCSS('font-style', 'italic');
    } else {
      await expect(slot, c.name).not.toContainText('No campaign statement has been published');
    }
  }
});

test('elections — each race collapses and expands', async ({ page }) => {
  await page.goto('/elections');
  const toggles = page.locator('.race-toggle');
  await expect(toggles).toHaveCount(3);

  const first = toggles.first();
  const body = page.locator('.race-panel').first();
  // Expanded by default, so the content is there without JS.
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(body).toBeVisible();

  await first.click();
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toBeHidden();

  await first.click();
  await expect(body).toBeVisible();
});

// check_digest.py (companion repo) links /elections#race-panel-<race id>.
// The id is on the race block, so the link lands on the race heading, and
// scroll-margin keeps that heading clear of the sticky nav.
test('elections — digest links land on each race heading, below the nav', async ({ page }) => {
  const fs = require('fs');
  const path = require('path');
  const { races } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'content/elections.json'), 'utf8'));
  expect(races).toHaveLength(3);
  for (const race of races) {
    // A fresh load each time, as a click from the digest email is. Changing
    // only the hash in the same tab would smooth-scroll from the previous
    // race instead, which is slower and not what readers do.
    await page.goto('about:blank');
    await page.goto(`/elections#race-panel-${race.id}`);
    const block = page.locator(`.race-block#race-panel-${race.id}`);
    await expect(block).toHaveCount(1);
    // The toggle controls the panel inside the block, under its own id.
    await expect(block.locator('.race-toggle')).toHaveAttribute('aria-controls', `race-content-${race.id}`);
    await expect(block.locator(`.race-panel#race-content-${race.id}`)).toBeVisible();
    // Smooth scrolling animates the jump, so wait for it to settle.
    const navBottom = (await page.locator('.nav-bar').boundingBox()).height;
    await expect.poll(async () => Math.round((await block.boundingBox()).y), { timeout: 5000 })
      .toBeGreaterThanOrEqual(Math.floor(navBottom));
    await expect.poll(async () => Math.round((await block.boundingBox()).y), { timeout: 5000 })
      .toBeLessThan(120);
    await expect(block.locator('.race-header')).toBeInViewport();
  }
});

test('elections — race context sits under the header, above the candidates', async ({ page }) => {
  await page.goto('/elections');
  const block = page.locator('.race-block').first();
  const ctx = await block.locator('.race-context').boundingBox();
  const cards = await block.locator('.candidate-card').first().boundingBox();
  expect(ctx.y, 'context should frame the race before the candidates').toBeLessThan(cards.y);
});

test('elections — voter info covers registration, early voting and lookup', async ({ page }) => {
  await page.goto('/elections');
  const boxes = page.locator('.voter-info-box');
  await expect(boxes).toHaveCount(4);

  const main = page.locator('main');
  // The deadline is a date, not "25 days before" — and the mail postmark is
  // five days earlier than the in-person cutoff, which is the part residents
  // get wrong.
  await expect(main).toContainText('October 24');
  await expect(main).toContainText('postmarked by October 19');
  await expect(main, 'the old relative deadline should be gone').not.toContainText('25 days');

  await expect(main).toContainText('Early voting');
  await expect(main).toContainText('November 1');

  // Polling places move, so the page sends people to the lookup rather than
  // naming a building that may be wrong by November.
  await expect(main.locator('a[href*="voterlookup.elections.ny.gov"]')).toHaveCount(1);
  await expect(main, 'no hard-coded polling address').not.toContainText('Fowler Ave');
  // Absentee / mail ballots get a route too.
  await expect(main).toContainText('absentee');
});

test('elections — Neighborhood Party candidates each have their own profile', async ({ page }) => {
  await page.goto('/elections');
  const np = page.locator('.party-column', { hasText: 'Neighborhood Party · Republican' }).first();
  const summaries = await np.locator('.candidate-summary').allTextContents();
  expect(summaries.length).toBe(3);
  // They previously shared one identical paragraph appended to each card.
  expect(new Set(summaries).size, 'each challenger needs their own text').toBe(3);
  // And of comparable weight to the Democratic profiles beside them.
  for (const t of summaries) expect(t.length).toBeGreaterThan(400);
});

test('elections — every candidate is rendered through the same six slots', async ({ page }) => {
  await page.goto('/elections');
  const cards = page.locator('.candidate-card');
  await expect(cards).toHaveCount(14);

  // The template is the fairness claim: identical labels, identical order, on
  // all fourteen candidates across all three races. Depth varies with the
  // public record, but shape must not.
  const LABELS = ['Background', 'Why they say they’re running', 'Prior public service',
    'Stated priorities', 'Relevant quotes', 'Source'];
  for (let i = 0; i < 14; i++) {
    const card = cards.nth(i);
    const name = await card.locator('.candidate-name').innerText();
    // textContent, not innerText: the labels are display-uppercased in CSS.
    expect(await card.locator('.profile-label').allTextContents(), `${name} slots`).toEqual(LABELS);
    const href = await card.locator('a.examiner-link').getAttribute('href');
    expect(href, `${name} cites a front page, not an article`)
      .not.toMatch(/^https:\/\/(www\.)?pelhamexaminer\.com\/?$/);
  }

  // A slot the record does not fill is stated, not quietly dropped — that is
  // what stops a thin profile reading as a verdict on the campaign.
  // (Some empty "why running" slots carry a dated no-statement note instead;
  // see the next test.)
  await expect(page.locator('.profile-empty', { hasText: 'Not found in the public record' }).first())
    .toBeVisible();
  await expect(page.locator('.profile-methodology'))
    .toContainText('does not indicate the importance, quality, or strength');
});

test('about — leads with the independence statement, above the fold', async ({ page }) => {
  await page.goto('/about');
  const ind = page.locator('.independence');
  await expect(ind).toBeVisible();
  await expect(ind).toContainText('independent and resident-created');
  await expect(ind).toContainText('does not endorse candidates');

  // "Above the fold" is the claim, so check it rather than assume it.
  const box = await ind.boundingBox();
  expect(box.y, 'independence statement should be visible without scrolling').toBeLessThan(900);

  // And ahead of everything else on the page.
  for (const sel of ['.works-grid', '.about-project', '.about-form-card']) {
    expect(box.y).toBeLessThan((await page.locator(sel).first().boundingBox()).y);
  }
});

test('about — how this site works covers all eight disclosures', async ({ page }) => {
  await page.goto('/about');
  const items = page.locator('.works-item');
  await expect(items).toHaveCount(8);
  const text = await page.locator('.works-grid').innerText();
  for (const claim of ['Pelham Examiner', 'All candidates in each race are presented',
                       'AI-generated', 'Corrections are logged publicly',
                       'does not endorse candidates', 'Self-funded',
                       'used only to send you civic updates about Pelham. It is never shared or sold',
                       // How a topic earns a card, and how many sources it carries.
                       'appeared at least twice', 'two most recent sources']) {
    expect(text, `missing disclosure: ${claim}`).toContain(claim);
  }
});

test('about — the perspective callout invites rather than deflects', async ({ page }) => {
  await page.goto('/about');
  const callout = page.locator('.editorial-callout');
  await expect(callout).toContainText('Add your voice');
  // The old wording told readers their absence was their own fault.
  await expect(callout).not.toContainText('not a failure of this site');
  await expect(callout.locator('a[href="/about#feedback"]')).toHaveCount(1);
});

test('elections — nonpartisan statement appears before the first race', async ({ page }) => {
  await page.goto('/elections');
  const note = page.locator('main').getByText('does not endorse any candidate or party').first();
  await expect(note).toBeVisible();
  expect((await note.boundingBox()).y)
    .toBeLessThan((await page.locator('.race-block').first().boundingBox()).y);
  await expect(page.locator('main')).toContainText('All candidates in each race are presented');
  // The deadline sentence was left ungrammatical when the fact became a date.
  await expect(page.locator('main')).not.toContainText('typically October');
});

test('home — Current Issues leads, elections is one section among several', async ({ page }) => {
  await page.goto('/');
  const issuesY = (await page.locator('#home-issues').boundingBox()).y;
  const bannerY = (await page.locator('.home-banner').boundingBox()).y;
  const meetingsY = (await page.locator('#home-meetings').boundingBox()).y;
  expect(issuesY, 'issues should come before the election banner').toBeLessThan(bannerY);
  expect(bannerY, 'the banner sits between issues and meetings').toBeLessThan(meetingsY);
});

test('branding and canonical host', async ({ page }) => {
  for (const pg of PAGES) {
    await page.goto(pg.url);
    await expect(page.locator('footer')).toContainText('The Pelham Engagement Project');
    await expect(page.locator('footer'), 'old name retired').not.toContainText('Pelham Civic Guide');
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute('href', `https://pelhamengagementproject.org${pg.url}`);
    await expect(page.locator('meta[property="og:url"]'))
      .toHaveAttribute('content', `https://pelhamengagementproject.org${pg.url}`);
  }
});

test('no page links to a URL that does not exist', async ({ page, request }) => {
  const seen = new Set();
  for (const pg of PAGES) {
    await page.goto(pg.url);
    const hrefs = await page.locator('a[href^="/"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('href')));
    hrefs.forEach((h) => seen.add(h.split('#')[0]));
  }
  for (const href of [...seen].filter(Boolean)) {
    const res = await request.get(href);
    expect(res.status(), `${href} is linked but does not resolve`).toBeLessThan(400);
  }
});

/* ── Content pages ─────────────────────────────────────────────────────── */

test('issues — every tracked issue is listed, each with a source', async ({ page }) => {
  await page.goto('/issues');
  const cards = page.locator('.issue-card');
  // More than the homepage digest shows — that is the point of the page.
  expect(await cards.count()).toBeGreaterThan(4);
  await expect(page.locator('.issue-card .issue-source-link').first()).toBeVisible();
});

// Follows the data: every card with last_meeting_update shows the line and
// links to that meeting, and no card without one shows it. Until entries are
// filled in, only the second half has anything to check.
test('issues — latest meeting coverage links to the meeting summary', async ({ page }) => {
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '..');
  const { issues } = JSON.parse(fs.readFileSync(path.join(root, 'content/issues.json'), 'utf8'));
  const { meetings } = JSON.parse(fs.readFileSync(path.join(root, 'content/meetings.json'), 'utf8'));

  await page.goto('/issues');
  const shown = issues.filter((i) => i.show_on_home !== false);
  for (const i of shown) {
    const line = page.locator(`.issue-card[id="${i.id}"] .issue-meeting-update`);
    if (!i.last_meeting_update) {
      await expect(line, i.id).toHaveCount(0);
      continue;
    }
    const m = meetings.find((x) => x.id === i.last_meeting_update.meeting_id);
    await expect(line, i.id).toContainText('Latest meeting coverage:');
    await expect(line.locator('a'), i.id).toHaveAttribute('href', `/meetings#${m.id}`);
    await expect(line.locator('a'), i.id).toContainText(m.title);
  }

  const linked = shown.find((i) => i.last_meeting_update);
  if (linked) {
    await page.locator(`.issue-card[id="${linked.id}"] .issue-meeting-link`).click();
    await expect(page.locator(`.mtg-set[data-meeting="${linked.last_meeting_update.meeting_id}"]`)).toBeVisible();
  }
});

test('elections — three race blocks and every candidate named', async ({ page }) => {
  await page.goto('/elections');
  await expect(page.locator('.race-block')).toHaveCount(3);
  for (const name of ['Solomon', 'Howell', 'Burke', 'Long', 'Speros', 'Anzilotti']) {
    await expect(page.locator('main')).toContainText(name);
  }  // The candidate's own spelling (statement, Examiner Oct 5 2026). The old
  // "Dlutkowski" survives only in an Examiner URL, never in visible text.
  await expect(page.locator('main')).toContainText('Chris Dlutowski');
  await expect(page.locator('main')).not.toContainText('Dlutkowski');
});

test('taxes — sourced shares for every body, then the village comparison', async ({ page }) => {
  await page.goto('/taxes');
  await expect(page.getByRole('heading', { name: /Where Do Your Property Taxes Go/i })).toBeVisible();

  // Like-for-like: both villages on the same assessed value, side by side.
  const compare = page.locator('.tax-compare');
  await expect(compare).toContainText('$1,045,204');
  await expect(compare.locator('[data-body="village-of-pelham"] .tax-compare-amount')).toHaveText('~$6,493');
  await expect(compare.locator('.tax-compare-note')).toContainText('7.6% higher than Manor');
  await expect(compare).not.toContainText('12.8%');
  await expect(compare.locator('[data-body="village-of-pelham-manor"] .tax-compare-amount')).toHaveText('~$6,035');

  // One row per body, shares derived from the county's published rates.
  // Never a combined "Village (Pelham or Manor)" row.
  const rows = page.locator('.tax-bar-row');
  await expect(rows).toHaveCount(5);
  const pct = rows.locator('.tax-bar-pct');
  await expect(pct).toHaveText(['~68% ✓', '~27% ✓', '~26% ✓', '~3-4% ✓', '~1-2% est.']);
  await expect(rows.nth(0)).toContainText('$15.88 per $1,000');
  await expect(rows.nth(1)).toContainText('Village of Pelham');
  await expect(rows.nth(2)).toContainText('Village of Pelham Manor');
  await expect(page.locator('.tax-bar-name', { hasText: /Pelham or Manor/ })).toHaveCount(0);

  // Real figures now, so nothing may still call itself illustrative.
  await expect(page.locator('main')).not.toContainText(/illustrative/i);
  await expect(page.locator('.tax-note')).toContainText('derived from 2025/2026 Westchester County published tax rates');

  // The overall breakdown comes first; the village comparison follows it.
  const breakdownFirst = await page.evaluate(() => {
    const bars = document.querySelector('.tax-layout');
    const cmp = document.querySelector('.tax-compare');
    return !!(bars.compareDocumentPosition(cmp) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(breakdownFirst, 'the comparison should sit below the breakdown').toBe(true);
});


test('taxes — the two village explainers share one structure and one kind of link', async ({ page }) => {
  await page.goto('/taxes');
  const block = (id) => page.locator(`.tax-explainer-block[data-body="${id}"]`);
  const shape = /^Village taxes fund .+\. FY2026–27 Budget: \$[\d.]+M\. Tax change: [\d.]+% .+ increase, (over|within) the state tax cap\.$/;
  for (const [id, short] of [['village-of-pelham', 'Village of Pelham'], ['village-of-pelham-manor', 'Pelham Manor']]) {
    await expect(block(id).locator('.teb-desc'), id).toHaveText(shape);
    await expect(block(id).locator('a'), id).toHaveText(`${short} budget documents`);
  }
  // Same services named for both villages.
  const services = async (id) => (await block(id).locator('.teb-desc').textContent()).split('.')[0];
  expect(await services('village-of-pelham-manor')).toBe(await services('village-of-pelham'));
});

test('taxes — Learn more sits last and points at the primary sources', async ({ page }) => {
  await page.goto('/taxes');
  const box = page.locator('.learn-more');
  await expect(box).toBeVisible();

  const links = box.locator('a');
  await expect(links).toHaveText([
    /How Pelham property taxes work/,
    /Four biggest property tax myths/,
    /Ins and outs of property tax assessment and filing grievances/,
    /Westchester County official tax rates/,
    /2025\/2026 School District Tax Rates \(PDF\)/,
    /2025-2026 Village Tax Rates \(PDF\)/,
    /2026 City\/Town Tax Rates \(PDF\)/,
  ]);
  await expect(links.nth(4)).toHaveAttribute('href', /2025-2026-school-district-tax-rates\.pdf$/);
  // External, so they should not swallow the reader's place on the page.
  for (let i = 0; i < 7; i++) await expect(links.nth(i)).toHaveAttribute('target', '_blank');

  // Last thing in the section, below the explainers and the comparison.
  const lmY = (await box.boundingBox()).y;
  for (const sel of ['.tax-explainer-block', '.tax-compare']) {
    const other = page.locator(sel).last();
    if (await other.count()) {
      expect(lmY, `Learn more should sit below ${sel}`).toBeGreaterThan((await other.boundingBox()).y);
    }
  }
});

test('gov-101 — the two village cards carry the same rows; the Town lists its shared services', async ({ page }) => {
  await page.goto('/gov-101');
  const rows = (name) => page.locator('.gov-card', { has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) })
    .locator('.detail-key').allTextContents();
  const pelham = await rows('Village of Pelham');
  const manor = await rows('Village of Pelham Manor');
  expect(pelham).toEqual(['Governing Body', 'FY2026–27 Budget', 'Area', 'Meetings', 'Village Hall', 'Clerk']);
  expect(manor, 'Manor card rows match the Village of Pelham card').toEqual(pelham);
  // The Village of Pelham budgets through one general fund; Manor splits ops/capital.
  await expect(page.locator('.gov-card', { has: page.locator('h3', { hasText: /^Village of Pelham$/ }) }))
    .toContainText('$20.5M general fund (↑10.1%) — no separate capital budget; capital items funded within the general fund');

  const town = page.locator('.gov-card', { has: page.locator('h3', { hasText: /^Town of Pelham$/ }) });
  await expect(town).toContainText('The Town provides services shared by all residents: EMS, tax assessment and collection, and the town courts.');
  await expect(page.locator('main')).not.toContainText(/wasteful/i);
  await expect(town).toContainText('EMS, tax collection, courts');
  await expect(page.locator('#officials-village-of-pelham-manor')).toContainText('Lindsey Luft');
});

test('gov-101 — the five governing bodies plus the quick-reference card', async ({ page }) => {
  await page.goto('/gov-101');
  await expect(page.locator('.gov-card')).toHaveCount(6);
  await expect(page.locator('main')).toContainText('Westchester County');
  await expect(page.locator('main')).toContainText('Who to call for what?');
});


test('gov-101 — layer diagram shows five bodies and the village split', async ({ page }) => {
  await page.goto('/gov-101');
  const diagram = page.locator('.layer-diagram');
  await expect(diagram).toBeVisible();
  await expect(diagram.locator('.layer')).toHaveCount(5);

  // The split is the point of the diagram: the two villages sit side by side
  // on one tier, not stacked in a chain under the Town.
  const split = diagram.locator('.layer-row.is-split');
  await expect(split).toHaveCount(1);
  await expect(split.locator('.layer')).toHaveCount(2);
  const both = await split.locator('.layer').all();
  const boxA = await both[0].boundingBox();
  const boxB = await both[1].boundingBox();
  expect(Math.abs(boxA.y - boxB.y), 'the two villages share a tier').toBeLessThan(4);

  // Scope is stated in words, not by colour alone.
  await expect(diagram.locator('.layer-scope.is-partial')).toHaveCount(2);
  await expect(diagram.locator('.layer-scope.is-everyone')).toHaveCount(3);
  await expect(diagram).toHaveAttribute('role', 'img');

  // Drawn as a diagram: a fork into the two villages, and
  // colour by scope — amber headers for the villages, navy for the rest.
  await expect(diagram.locator('.layer-link.is-fork')).toHaveCount(1);
  await expect(diagram.locator('.layer-link.is-join')).toHaveCount(0);

  // Order: the three bodies every resident shares, then the village split.
  const order = await diagram.locator('.layer').evaluateAll((els) =>
    els.map((e) => [...e.classList].find((c) => c.startsWith('layer-'))));
  expect(order).toEqual(['layer-county', 'layer-town', 'layer-school', 'layer-village', 'layer-village']);
  const school = await diagram.locator('.layer-school').boundingBox();
  const village = await diagram.locator('.layer-village').first().boundingBox();
  expect(school.y, 'school district sits above the villages').toBeLessThan(village.y);
  const head = (sel) => diagram.locator(`${sel} .layer-head`).first()
    .evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await head('.layer-village')).toBe('rgb(200, 151, 58)');
  for (const sel of ['.layer-county', '.layer-town', '.layer-school']) {
    expect(await head(sel), `${sel} should be navy`).toBe('rgb(26, 39, 68)');
  }
});

test('gov-101 — officials cards name officeholders and flag contested bodies', async ({ page }) => {
  await page.goto('/gov-101');
  // Title and name must not run together in the page text ("MayorChance
  // Mullen") — that is what screen readers and CSS-less views read.
  const first = page.locator('#officials-village-of-pelham .officials-list li').first();
  expect((await first.textContent()).replace(/s+/g, ' ').trim()).toBe('Mayor: Chance Mullen');
  await expect(page.locator('.officials-sep').first()).not.toBeInViewport();
  const cards = page.locator('.officials-card');
  // Four bodies have a local roster; the county does not.
  await expect(cards).toHaveCount(4);

  const main = page.locator('main');
  for (const name of ['Chance Mullen', 'Theresa Mohan', 'Jennifer Monachino Lapey', 'Dr. Cheryl H. Champ']) {
    await expect(main, `${name} should appear in the roster`).toContainText(name);
  }
  // The vacancy is shown as vacant rather than quietly omitted.
  await expect(page.locator('.officials-vacant')).toHaveCount(1);

  // Every body with a race this November links to it — three, not two: the
  // Town Supervisor and Clerk are on the ballot as well as the two villages.
  const contested = page.locator('.officials-contested');
  await expect(contested).toHaveCount(3);
  await expect(contested.first()).toHaveAttribute('href', '/elections');
});

test('get-involved — three parts: raise a concern, vote, run for office', async ({ page }) => {
  await page.goto('/get-involved');
  const parts = page.locator('.involved-part');
  await expect(parts).toHaveCount(3);
  await expect(parts.nth(0)).toHaveAttribute('id', 'raise-a-concern');
  await expect(parts.nth(1)).toHaveAttribute('id', 'vote');
  await expect(parts.nth(2)).toHaveAttribute('id', 'run-for-office');

  // 1 — the four-step ladder, the public comment guide and where to show up.
  const concern = parts.nth(0);
  await expect(concern.locator('.ladder-step')).toHaveCount(4);
  await expect(concern.locator('.ladder-step').first()).toContainText('Start with a conversation');
  await expect(concern).toContainText('Simple Comment Template');
  await expect(concern.locator('.meeting-chip')).toHaveCount(4);

  // 2 — the date, generated from facts.json, and a way to register.
  const vote = parts.nth(1);
  await expect(vote.locator('.vote-fact-value').first()).toHaveText('November 3, 2026');
  await expect(vote.locator('a[href*="elections.ny.gov"]').first()).toBeVisible();

  // 3 — every elected body, from the roster.
  const run = parts.nth(2);
  await expect(run.locator('.office-list li')).toHaveCount(4);
  await expect(run).toContainText('Board of Education');
  await expect(run).toContainText('All elected positions in Pelham are part-time.');

  await page.click('.involved-jump a[href="#vote"]');
  await expect(page).toHaveURL(/#vote$/);
});

/* ── Meetings page: board, then meeting ────────────────────────────────── */

const bodyTab = (page, body) => page.locator(`.mtg-body-tab[data-body="${body}"]`);
const summary = (page, id) => page.locator(`.mtg-set[data-meeting="${id}"]`);
const fold = (set, key) => set.locator(`details.mtg-fold[data-section="${key}"]`);

const VILLAGE_LATEST = 'pelham-board-sep22-2026';
const VILLAGE_SEP8 = 'pelham-board-sep2026';
const TOWN_AUG = 'town-council-aug2026';

test('meetings — four board tabs, each opening on its latest meeting with earlier ones as dates', async ({ page }) => {
  await page.goto('/meetings');
  await expect(page.locator('.mtg-body-tab')).toHaveCount(4);
  await expect(bodyTab(page, 'village-of-pelham')).toHaveAttribute('aria-selected', 'true');
  await expect(summary(page, VILLAGE_LATEST)).toBeVisible();
  await expect(summary(page, VILLAGE_SEP8)).toBeHidden();

  // Every published meeting is reachable: the latest per board by its tab,
  // the rest from that board's date list.
  let reached = 0;
  for (const body of ['village-of-pelham', 'village-of-pelham-manor', 'town-of-pelham', 'pelham-schools']) {
    await bodyTab(page, body).click();
    const panel = page.locator(`.mtg-body-panel[data-body="${body}"]`);
    await expect(panel).toBeVisible();
    await expect(panel.locator('.mtg-set:visible')).toHaveCount(1);
    reached++;
    const ids = await panel.locator('.mtg-date-list li:not([hidden]) .mtg-date-link')
      .evaluateAll((els) => els.map((e) => e.dataset.meeting));
    for (const id of ids) {
      await panel.locator(`.mtg-date-link[data-meeting="${id}"]`).click();
      await expect(summary(page, id)).toBeVisible();
      await expect(panel.locator('.mtg-set:visible')).toHaveCount(1);
      reached++;
    }
  }
  expect(reached).toBeGreaterThanOrEqual(8);
});

test('meetings — summary sections: exec and residents open, the rest folded', async ({ page }) => {
  await page.goto('/meetings');
  await bodyTab(page, 'town-of-pelham').click();
  await page.locator(`.mtg-date-link[data-meeting="${TOWN_AUG}"]`).click();
  const set = summary(page, TOWN_AUG);

  await expect(set.locator('[data-section="exec"] .exec-summary')).toBeVisible();
  const residents = set.locator('[data-section="residents"]');
  await expect(residents).toBeVisible();
  await expect(residents).toContainText('Edward Filby');

  for (const key of ['votes', 'actions', 'detailed', 'transcript']) {
    await expect(fold(set, key), `${key} should start collapsed`).not.toHaveAttribute('open', '');
  }
  await expect(set.locator('.vote-row').first()).toBeHidden();
  await fold(set, 'votes').locator('summary').click();
  await expect(set.locator('.vote-row').first()).toBeVisible();

  await fold(set, 'detailed').locator('summary').click();
  await expect(fold(set, 'detailed')).toContainText('Bruno Barbosa');
  // Opening one meeting's section must not open another meeting's.
  await expect(fold(summary(page, VILLAGE_LATEST), 'detailed')).not.toHaveAttribute('open', '');
});

test('meetings — a hash deep-links to a meeting', async ({ page }) => {
  // The home digest links /meetings#<id>; that must open the right board.
  await page.goto('/meetings#' + VILLAGE_SEP8);
  await expect(bodyTab(page, 'village-of-pelham')).toHaveAttribute('aria-selected', 'true');
  await expect(summary(page, VILLAGE_SEP8)).toBeVisible();
  await expect(summary(page, VILLAGE_LATEST)).toBeHidden();
  // The date list now offers the latest meeting to go back to.
  await expect(page.locator(`.mtg-date-link[data-meeting="${VILLAGE_LATEST}"]`)).toBeVisible();

});

// Checked against the real transcript files, not padded content. Today every
// transcript is a short excerpt (8–14 lines), so none should show "Load
// more". The assertion follows the data: if a transcript ever runs past 50
// lines — full transcripts are on ROADMAP.md — the same test requires the
// button instead.
test('meetings — transcript excerpts: labelled, linked to the recording, paged only past 50 real lines', async ({ page }) => {
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '..');
  const { meetings } = JSON.parse(fs.readFileSync(path.join(root, 'content/meetings.json'), 'utf8'));
  const PAGE = 50;

  await page.goto('/meetings');
  const published = meetings.filter((m) => m.status === 'published');
  expect(published.length).toBeGreaterThanOrEqual(8);

  for (const m of published) {
    const file = fs.readFileSync(path.join(root, m.transcript_file), 'utf8');
    const lines = (file.match(/class="transcript-block"/g) || []).length;
    const set = summary(page, m.id);
    const f = fold(set, 'transcript');

    await expect(f.locator('.mtg-fold-title'), m.id).toHaveText('Transcript excerpt');
    const link = f.locator('.transcript-note a');
    await expect(f.locator('.transcript-note'), m.id).toContainText('This is a short excerpt.');
    await expect(link, m.id).toHaveAttribute('href', m.recording_url);

    // Every line in the file reaches the page — nothing is cut in the build.
    await expect(set.locator('.transcript-block:not(.ts-ellipsis)'), m.id).toHaveCount(lines);
    if (lines > PAGE) {
      await expect(set.locator('.transcript-more'), `${m.id}: ${lines} lines should page`).toHaveCount(1);
    } else {
      await expect(set.locator('.transcript-more'), `${m.id}: ${lines} lines, no Load more`).toHaveCount(0);
      await expect(set.locator('.transcript-block[hidden]'), m.id).toHaveCount(0);
    }
  }
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

/* The Q&A log groups follow-up questions onto the exchange that started them,
 * which only works if the browser actually sends a session id and sends the
 * SAME one twice. Nothing on the page surfaces this, so without a test it
 * would fail silently and the log would read as one-off questions. */
test('ask — every request carries one stable session id', async ({ page }) => {
  const sent = [];
  await page.route('**/api/ask', (route) => {
    sent.push(JSON.parse(route.request().postData() || '{}').session_id);
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ answer: 'Test answer.' }),
    });
  });
  await page.goto('/');

  for (const q of ['Who is the mayor?', 'How do I email them?']) {
    await page.fill('#ai-input', q);
    await page.click('#ask-btn');
    await expect(page.locator('#ask-btn')).toBeEnabled();
  }

  expect(sent.length).toBe(2);
  expect(sent[0], 'session id missing from the request body').toBeTruthy();
  expect(sent[1], 'a follow-up must reuse the page-load id').toBe(sent[0]);
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
  let sent = null;
  // The chat call and the feedback call hit the same endpoint; tell them apart
  // by payload so the answer always arrives and only the vote fails.
  await page.route('**/api/ask', (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.type === 'feedback') {
      sent = body;
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

  // The payload must carry exactly the feedback table's columns — vote,
  // question, answer_snippet — which ask-pelham.js inserts as-is.
  expect(Object.keys(sent).sort()).toEqual(['answer_snippet', 'question', 'type', 'vote']);
  expect(sent).toMatchObject({ type: 'feedback', vote: 'up', question: 'What is the village budget?' });
  expect(sent.answer_snippet).toContain('Test answer.');
});

/* ── About page: the project story, then the forms ─────────────────────── */

test('about — project story card, then the lead-in to the forms', async ({ page }) => {
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'Mission', exact: true })).toBeVisible();
  // The four-item "How it works" list became the six-disclosure
  // "How this site works" grid; that has its own test.
  await expect(page.getByRole('heading', { name: 'How this site works' })).toBeVisible();

  // Editorial copy uses no we/our — the signed note and the form invitation
  // are the only places first person belongs. Checked across every editorial
  // block rather than just the first, so a new section cannot slip past.
  const FIRST_PERSON = new RegExp(String.raw`(we|our|us)`, 'i');
  for (const sel of ['.independence', '.works-grid', '.about-cols']) {
    const copy = await page.locator(sel).innerText();
    expect(copy, `${sel} should use no we/our`).not.toMatch(FIRST_PERSON);
  }
  const story = page.locator('.about-project');
  await expect(story.getByRole('heading', { name: 'About this project' })).toBeVisible();
  await expect(story).toContainText('Bloomberg LP');
  await expect(story.locator('.about-signoff')).toHaveText('— Katie Keenan');

  // Order: story, "Want to get involved?", then the forms it leads into.
  const ys = await page.evaluate(() => ['.about-project', '.about-involve', '#error-form']
    .map((sel) => document.querySelector(sel).getBoundingClientRect().top));
  expect(ys, 'story → lead-in → forms').toEqual([...ys].sort((a, b) => a - b));
  // The card is self-contained, so the gap after it stays modest.
  const gap = await page.evaluate(() => document.querySelector('.about-involve').getBoundingClientRect().top
    - document.querySelector('.about-project').getBoundingClientRect().bottom);
  expect(gap).toBeLessThanOrEqual(48);
  await expect(page.locator('.about-involve')).toContainText('Use the forms below');

  // Signed at the foot of the note, not under the heading.
  const last = await story.evaluate((el) => el.lastElementChild.className);
  expect(last).toBe('about-signoff');

  // No personal address anywhere in the page, visible or in the source.
  expect(await page.content()).not.toContain('katherine.e.keenan@gmail.com');
});

/* ── About page forms ──────────────────────────────────────────────────── */

test('error correction form — reports failure on a rejected write, success on a stored one', async ({ page }) => {
  let status = 500;
  let sent = null;
  await page.route('**/api/ask', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status, contentType: 'application/json', body: '{}' });
  });

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

  // Payload matches the corrections table: section, description, source and
  // the optional contact, empty here because the reader left it blank.
  expect(sent).toEqual({
    type: 'correction',
    section: 'Who Governs',
    description: 'Test: the trustee list is missing a name.',
    source: 'https://www.pelhamny.gov',
    contact: '',
  });
  await page.fill('#error-contact', 'reader@example.com');
  await page.click('.btn-submit-correction');
  await expect.poll(() => sent.contact).toBe('reader@example.com');
});

test('civic engagement form — reports failure on a rejected write, success on a stored one', async ({ page }) => {
  let status = 500;
  let sent = null;
  await page.route('**/api/ask', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/about');
  await expect(page.locator('#feedback')).toContainText('want to help with this project');
  // "I want to help" is offered second, right after "Missing topic or issue".
  const options = await page.locator('#fb-type option').allTextContents();
  expect(options.slice(1, 3)).toEqual(['Missing topic or issue', 'I want to help with this project']);
  await page.selectOption('#fb-type', 'I want to help with this project');
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
  expect(sent).toMatchObject({
    type: 'civic_engagement',
    feedback_type: 'I want to help with this project',
    actions: ['attended'],
  });
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

/* ── Sanitation, Recreation Commission, corrections, press ─────────────── */

test('gov 101 — sanitation and Recreation Commission routes, details collapsed until opened', async ({ page }) => {
  await page.goto('/gov-101');
  const tile = page.locator('.qr-list');
  await expect(tile).toContainText('Garbage, recycling or bulk pickup in the Village of Pelham?');
  await expect(tile).toContainText('Garbage, recycling or leaf pickup in Pelham Manor?');
  await expect(tile).toContainText('Want to serve on the Recreation Commission?');
  await expect(tile).toContainText('914-738-2015, option 2');

  const pelham = tile.locator('details.qr-details').first();
  await expect(pelham.locator('li').first()).toBeHidden();
  await pelham.locator('summary').click();
  await expect(pelham).toContainText('Area A: October 19, November 2 and 16, December 7 and 28');
  await expect(pelham.locator('a.qr-link')).toHaveAttribute('href', 'https://www.pelhamny.gov/164/Sanitation-Schedule-Information');
  await expect(tile.locator('a.qr-link', { hasText: 'Apply' })).toHaveAttribute('href', /forms\.cloud\.microsoft/);
});

test('get involved — Recreation Commission call for applications, with apply link', async ({ page }) => {
  await page.goto('/get-involved');
  const block = page.locator('#serve-on-a-commission + p');
  await expect(block).toContainText('Join the Town of Pelham Recreation Commission');
  await expect(block).toContainText('November 6, 2026');
  await expect(page.locator('a.involved-cta', { hasText: 'Apply to the Recreation Commission' }))
    .toHaveAttribute('href', /^https:\/\/forms\.cloud\.microsoft\//);
});

test('about — corrections log leads with the Feeney Park fix; press link to the Examiner letter', async ({ page }) => {
  await page.goto('/about');
  await expect(page.locator('#corrections-log > div').first()).toContainText('Feeney Park');
  await expect(page.locator('.about-press a')).toHaveAttribute('href', /pelhamexaminer\.com\/85015\//);
});

test('feeney park — the old transcription "Fini Park" survives only in the corrections log', async ({ page }) => {
  for (const url of ['/issues', '/meetings', '/', '/gov-101']) {
    await page.goto(url);
    expect(await page.locator('body').textContent(), url).not.toMatch(/\bFini Park\b/);
  }
  await page.goto('/issues');
  await expect(page.locator('#fini-park-fireworks')).toContainText('Feeney Park, in New Rochelle');
});

/* ── Ask page questions ────────────────────────────────────────────────── */

test('ask — the six questions, two drafts and two explores; no school bond questions', async ({ page }) => {
  await page.goto('/ask');
  const plain = page.locator('#suggestion-chips .suggestion-chip:not(.draft-chip):not(.opinion-chip)');
  await expect(plain).toHaveText([
    'Why did the Village of Pelham override the tax cap?',
    'When is bulk trash pickup in Pelham Manor?',
    'How does my property tax get divided between school, village, and town?',
    'How do I dispute my property tax assessment?',
    "What's happening with the EMS station site?",
    'What did the Board of Education discuss at its last meeting?',
  ]);
  await expect(page.locator('#suggestion-chips .draft-chip')).toHaveText([
    'Help me write a letter to the editor about a local issue',
    'Help me write a public comment for an upcoming board meeting',
  ]);
  await expect(page.locator('#suggestion-chips .opinion-chip')).toHaveText([
    'What should I know before voting on November 3?',
    'What questions should I ask at the next Board of Education meeting?',
  ]);
  await expect(page.locator('#suggestion-chips')).not.toContainText(/bond/i);
});

test('ask — a plain question submits on click; a draft chip only fills the box', async ({ page }) => {
  const asked = [];
  await page.route('**/api/ask', (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answer: 'Stub answer.' }) });
  });
  await page.goto('/ask');
  await page.locator('#suggestion-chips .draft-chip').first().click();
  await expect(page.locator('#ai-input')).toHaveValue('Help me write a letter to the editor about a local issue');
  expect(asked).toHaveLength(0);

  await page.locator('#suggestion-chips .suggestion-chip', { hasText: 'When is bulk trash pickup in Pelham Manor?' }).click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0].messages.at(-1).content).toBe('When is bulk trash pickup in Pelham Manor?');
  await expect(page.locator('#chat-window')).toContainText('Stub answer.');
});

test('taxes — Learn more lists both Town Assessor articles', async ({ page }) => {
  await page.goto('/taxes');
  const list = page.locator('.learn-more-list');
  await expect(list.locator('a[href*="pelhamexaminer.com/66859/"]')).toContainText('Four biggest property tax myths');
  await expect(list.locator('a[href*="pelhamexaminer.com/56461/"]')).toContainText('Ins and outs of property tax assessment and filing grievances');
});

test('gov 101 — the library is described as Town-appointed and Town-funded, independently run', async ({ page }) => {
  await page.goto('/gov-101');
  const body = await page.locator('main').innerText();
  expect(body).toContain('The Town of Pelham appoints the Pelham Public Library Board of Trustees and funds the library.');
  expect(body).not.toMatch(/Pelham Public Library \(Town-run\)/);
});

test('elections — Eileen Miller is quoted from her cited statement', async ({ page }) => {
  await page.goto('/elections');
  const card = page.locator('.candidate-card', { has: page.locator('.candidate-name', { hasText: 'Eileen Miller' }) });
  await expect(card.locator('.profile-quote')).toHaveText('Better communication helps keep residents engaged, strengthens transparency, and builds community.');
});

