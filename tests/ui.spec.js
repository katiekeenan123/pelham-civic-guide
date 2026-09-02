// UI tests for the Pelham Civic Guide — run against the live deployed page.
//
// Covers: page load + title, the primary nav, the "Explore More" dropdown
// (hover + click, incl. clip-safe rendering), the Explore More tab switcher
// (incl. the Who Governs tab), the Meeting Summaries panel and its Detailed
// Summary tab, the Elections section, and the scroll fade-in animation.

const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('page loads and the title identifies the Pelham Engagement Project', async ({ page }) => {
  await expect(page).toHaveTitle(/Pelham Engagement Project/i);
});

test('all primary navigation links are present', async ({ page }) => {
  const nav = page.locator('nav.nav-bar');
  await expect(nav).toBeVisible();

  // "Who Governs" is no longer a top-level nav link — it lives inside the
  // Explore More dropdown / tabs.
  const expected = [
    'Nov 2026 Elections',
    'Explore More',
    'Ask Pelham AI',
    'Get Involved',
    'Meeting Schedule',
    'About',
  ];

  for (const name of expected) {
    // exact:false so emoji/decorations ("🗳 Nov 2026 Elections", "About &
    // Corrections", "Explore More ▾") still match on the meaningful label.
    await expect(nav.getByRole('link', { name, exact: false })).toBeVisible();
  }
});

test('Explore More dropdown opens on hover and on click, with its four sub-items', async ({ page }) => {
  const wrap = page.locator('.nav-dropdown-wrap');
  const trigger = page.locator('.nav-dropdown-trigger');
  const menu = page.locator('.nav-dropdown');

  await expect(menu).toBeHidden();

  // hover opens it
  await wrap.hover();
  await expect(menu).toBeVisible();

  const items = menu.locator('a');
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText('Meeting Summaries');
  await expect(items.nth(1)).toContainText('Your Taxes');
  await expect(items.nth(2)).toContainText('Current Issues');
  await expect(items.nth(3)).toContainText('Who Governs');

  // click also toggles it — independent of :hover (mouse parked in the corner)
  await page.mouse.move(0, 0);
  await expect(menu).toBeHidden();
  await trigger.click();
  await page.mouse.move(0, 0);
  await expect(menu).toBeVisible();
  await trigger.click();
  await page.mouse.move(0, 0);
  await expect(menu).toBeHidden();
});

test('Explore More tabs switch content — Your Taxes and Current Issues', async ({ page }) => {
  const taxes = page.locator('#explore-taxes');
  const issues = page.locator('#explore-issues');

  await page.getByRole('button', { name: 'Your Taxes' }).click();
  await expect(taxes).toBeVisible();
  await expect(
    taxes.getByRole('heading', { name: /Where Do Your Property Taxes Go\?/i }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Current Issues' }).click();
  await expect(issues).toBeVisible();
  await expect(issues.getByRole('heading', { name: 'Current Issues', exact: true })).toBeVisible();
  // Switching tabs hides the previously active panel.
  await expect(taxes).toBeHidden();
});

test('Meeting Summaries — July 14 2026 meeting, Detailed Summary tab, Ari Schwartz', async ({ page }) => {
  // Current Issues is the default Explore tab now — switch to Meeting Summaries first.
  await page.getByRole('button', { name: 'Meeting Summaries' }).click();

  const meetings = page.locator('#explore-meetings');
  await expect(meetings).toBeVisible();

  // Executive Summary is the default panel; the meeting date is shown up front.
  await expect(meetings.getByText('July 14, 2026').first()).toBeVisible();

  await page.getByRole('button', { name: 'Detailed Summary' }).click();

  const detailed = page.locator('#panel-detailed');
  await expect(detailed).toBeVisible();
  await expect(detailed.getByText('Ari Schwartz', { exact: false }).first()).toBeVisible();
});

test('Elections section — three race blocks and every candidate named', async ({ page }) => {
  const elections = page.locator('#elections');
  await expect(elections).toBeVisible();

  await expect(elections.locator('.race-block')).toHaveCount(3);

  for (const name of ['Solomon', 'Howell', 'Burke', 'Long', 'Speros', 'Anzilotti']) {
    await expect(elections).toContainText(name);
  }
});

test('fade-in sections become visible on scroll', async ({ page }) => {
  const deep = page.locator('#get-involved .fade-in').first();
  await expect(deep).toBeAttached();

  // Far below the fold on load — the IntersectionObserver has not fired yet.
  await expect(deep).not.toHaveClass(/(^|\s)visible(\s|$)/);

  // Walk the scroll position down the whole page to trip every observer.
  await page.evaluate(async () => {
    for (let y = 0; y <= document.body.scrollHeight; y += 300) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 25));
    }
    window.scrollTo(0, document.body.scrollHeight);
  });

  await expect(deep).toHaveClass(/(^|\s)visible(\s|$)/);
  // #explore-issues is the default-active Explore panel and sits near the top.
  await expect(page.locator('#explore-issues .fade-in').first()).toHaveClass(/(^|\s)visible(\s|$)/);
});

test('Explore More — Who Governs tab reveals the governing-bodies content', async ({ page }) => {
  const governs = page.locator('#explore-governs');

  // Not the default tab — hidden until selected.
  await expect(governs).toBeHidden();

  await page.getByRole('button', { name: 'Who Governs' }).click();

  await expect(governs).toBeVisible();
  await expect(
    governs.getByRole('heading', { name: /Who Actually Governs Pelham\?/i }),
  ).toBeVisible();
  await expect(governs).toContainText('Village of Pelham Manor');
  await expect(governs).toContainText('Westchester County');
});

test('Explore More ▾ nav link: dropdown opens on click and its items drive the tabs', async ({ page }) => {
  const trigger = page.getByRole('link', { name: /Explore More/ });
  const menu = page.locator('.nav-dropdown');

  // Start from a non-default Explore tab so the dropdown click has a visible effect.
  await page.getByRole('button', { name: 'Meeting Summaries' }).click();
  await expect(page.locator('#explore-meetings')).toHaveClass(/(^|\s)active-panel(\s|$)/);
  await expect(page.locator('#explore-issues')).not.toHaveClass(/(^|\s)active-panel(\s|$)/);

  // Click (not hover) the nav trigger, mouse parked away from the nav.
  await page.mouse.move(0, 0);
  await expect(menu).toBeHidden();
  await trigger.click();
  await page.mouse.move(0, 0);
  await expect(menu).toBeVisible();

  // All four items present, in order.
  const items = menu.getByRole('link');
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText('Meeting Summaries');
  await expect(items.nth(1)).toContainText('Your Taxes');
  await expect(items.nth(2)).toContainText('Current Issues');
  await expect(items.nth(3)).toContainText('Who Governs');

  // Guard the original bug: `.nav-inner { overflow-x: hidden }` made overflow-y
  // compute to `auto`, clipping the dropdown away below the bar. Every on-screen
  // item must be the element actually painted at its own centre (not the section
  // showing through the clipped-away menu).
  const hitTest = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.nav-dropdown a')];
    const onScreen = links.filter((a) => {
      const r = a.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    return {
      checked: onScreen.length,
      allHit: onScreen.every((a) => {
        const r = a.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top && (top === a || a.contains(top));
      }),
    };
  });
  expect(hitTest.checked).toBeGreaterThanOrEqual(2);
  expect(hitTest.allHit).toBe(true);

  // Clicking a dropdown item drives the Explore More tabs.
  await menu.getByRole('link', { name: /Current Issues/ }).click();
  await page.mouse.move(0, 0);

  // The Explore More section's Current Issues tab/panel is now active; menu closed.
  await expect(page.locator('#explore-issues')).toHaveClass(/(^|\s)active-panel(\s|$)/);
  await expect(page.locator('#explore-issues')).toBeVisible();
  await expect(
    page.locator('.explore-tab', { hasText: 'Current Issues' }),
  ).toHaveClass(/(^|\s)active-explore-tab(\s|$)/);
  await expect(menu).toBeHidden();
});

// The two About-section forms POST their payload to /api/ask fire-and-forget.
// These tests care about the UI acknowledgement, not the write, so they stub
// /api/ask — that keeps every run from inserting a junk row into Supabase.
test('error correction form — submit shows a success message, not the old false one', async ({ page }) => {
  await page.route('**/api/ask', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );

  await page.selectOption('#error-section', 'Who Governs');
  await page.fill('#error-desc', 'Test: the trustee list is missing a name.');
  await page.fill('#error-source', 'https://www.pelhamny.gov');
  await page.click('.btn-submit-correction');

  const confirm = page.locator('#error-confirm');
  await expect(confirm).toBeVisible();
  // Guard against the old always-on false success copy ever returning.
  await expect(confirm).not.toContainText("Thanks — we'll review this within a week");
});

test('civic engagement form — submit shows a success message', async ({ page }) => {
  await page.route('**/api/ask', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );

  await page.check('#fb-attended');
  await page.click('#fb-share-btn');

  await expect(page.locator('#fb-confirm')).toBeVisible();
});
