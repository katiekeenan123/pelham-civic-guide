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

test('home — digest shows at most four issues and links to the full list', async ({ page }) => {
  await page.goto('/');
  const cards = page.locator('#home-issues .issue-card');
  const n = await cards.count();
  expect(n).toBeGreaterThan(0);
  expect(n, 'the digest shows three in one row').toBe(3);

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

test('home — hero mission text comes from hero.json, and says "site" not "guide"', async ({ page }) => {
  await page.goto('/');
  const lead = page.locator('.hero-lead');
  await expect(lead).toHaveCount(2);
  await expect(lead.first()).toHaveText(/^The Pelham Engagement Project exists to increase civic awareness/);
  await expect(lead.nth(1)).toContainText('This site cuts through the complexity');
  await expect(page.locator('body')).not.toContainText('This guide');
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
});

test('issues — a /issues#<id> link scrolls to that card and highlights it', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('#home-issues .issue-source-link[href^="/issues#"]').first().getAttribute('href');
  const id = href.split('#')[1];
  await page.goto(href);
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
  await expect(page.locator('.profile-empty').first())
    .toContainText('Not found in the public record');
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

test('about — how this site works covers all six disclosures', async ({ page }) => {
  await page.goto('/about');
  const items = page.locator('.works-item');
  await expect(items).toHaveCount(6);
  const text = await page.locator('.works-grid').innerText();
  for (const claim of ['Pelham Examiner', 'All candidates in each race are presented',
                       'AI-generated', 'Corrections are logged publicly',
                       'does not endorse candidates', 'Self-funded']) {
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

test('elections — three race blocks and every candidate named', async ({ page }) => {
  await page.goto('/elections');
  await expect(page.locator('.race-block')).toHaveCount(3);
  for (const name of ['Solomon', 'Howell', 'Burke', 'Long', 'Speros', 'Anzilotti']) {
    await expect(page.locator('main')).toContainText(name);
  }
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
    /Westchester County official tax rates/,
    /2025\/2026 School District Tax Rates \(PDF\)/,
    /2025-2026 Village Tax Rates \(PDF\)/,
    /2026 City\/Town Tax Rates \(PDF\)/,
  ]);
  await expect(links.nth(2)).toHaveAttribute('href', /2025-2026-school-district-tax-rates\.pdf$/);
  // External, so they should not swallow the reader's place on the page.
  for (let i = 0; i < 5; i++) await expect(links.nth(i)).toHaveAttribute('target', '_blank');

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
  expect(pelham).toEqual(['Governing Body', 'FY2026–27 Budget', 'Area', 'Meetings', 'Village Hall']);
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

  await page.click('.involved-jump a[href="#vote"]');
  await expect(page).toHaveURL(/#vote$/);
});

/* ── Meetings page: board, then meeting ────────────────────────────────── */

const bodyTab = (page, body) => page.locator(`.mtg-body-tab[data-body="${body}"]`);
const summary = (page, id) => page.locator(`.mtg-set[data-meeting="${id}"]`);
const fold = (set, key) => set.locator(`details.mtg-fold[data-section="${key}"]`);

const VILLAGE_SEP = 'pelham-board-sep2026';
const VILLAGE_JUL = 'pelham-board-jul2026';
const TOWN_AUG = 'town-council-aug2026';

test('meetings — four board tabs, each opening on its latest meeting with earlier ones as dates', async ({ page }) => {
  await page.goto('/meetings');
  await expect(page.locator('.mtg-body-tab')).toHaveCount(4);
  await expect(bodyTab(page, 'village-of-pelham')).toHaveAttribute('aria-selected', 'true');
  await expect(summary(page, VILLAGE_SEP)).toBeVisible();
  await expect(summary(page, VILLAGE_JUL)).toBeHidden();

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
  await expect(fold(summary(page, VILLAGE_SEP), 'detailed')).not.toHaveAttribute('open', '');
});

test('meetings — a hash deep-links to a meeting', async ({ page }) => {
  // The home digest links /meetings#<id>; that must open the right board.
  await page.goto('/meetings#' + VILLAGE_JUL);
  await expect(bodyTab(page, 'village-of-pelham')).toHaveAttribute('aria-selected', 'true');
  await expect(summary(page, VILLAGE_JUL)).toBeVisible();
  await expect(summary(page, VILLAGE_SEP)).toBeHidden();
  // The date list now offers the latest meeting to go back to.
  await expect(page.locator(`.mtg-date-link[data-meeting="${VILLAGE_SEP}"]`)).toBeVisible();

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
