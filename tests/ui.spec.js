// UI tests for the Pelham Civic Guide — run against the live deployed page.
//
// Covers: page load + title, the primary nav, the "Explore More" hover
// dropdown, the Explore More tab switcher, the Meeting Summaries panel and its
// Detailed Summary tab, the Elections section, and the scroll fade-in animation.

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

  const expected = [
    'Who Governs',
    'Nov 2026 Elections',
    'Ask Pelham AI',
    'Explore More',
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

test('Explore More dropdown appears on hover with its three sub-items', async ({ page }) => {
  const wrap = page.locator('.nav-dropdown-wrap');
  const menu = page.locator('.nav-dropdown');

  await expect(menu).toBeHidden();

  await wrap.hover();
  await expect(menu).toBeVisible();

  const items = menu.locator('a');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Meeting Summaries');
  await expect(items.nth(1)).toContainText('Your Taxes');
  await expect(items.nth(2)).toContainText('Current Issues');
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
  await expect(page.locator('#who-governs .fade-in').first()).toHaveClass(/(^|\s)visible(\s|$)/);
});
