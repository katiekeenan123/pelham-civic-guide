// UI tests for the Pelham Civic Guide — run against the live deployed page.
//
// Covers: page load + title, document structural integrity, the primary nav,
// the "Explore More" dropdown (hover + click, incl. clip-safe rendering), the
// Explore More tab switcher (incl. the Who Governs tab), the Meeting Summaries
// panel and its Detailed Summary tab, the meeting switcher across the two
// processed meetings, the Elections section, and the scroll fade-in animation.

const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('page loads and the title identifies the Pelham Engagement Project', async ({ page }) => {
  await expect(page).toHaveTitle(/Pelham Engagement Project/i);
});

// Structural integrity. A bad paste once spliced a second copy of the whole
// document into the middle of this page — two <head> blocks, two <body> tags,
// and a duplicated id="elections" that pointed the "See full candidate
// profiles" anchor at a truncated copy of the section. Browsers recover from
// that silently and every selector below still matched the first hit, so the
// suite stayed green across two commits while the live page rendered its hero
// twice. These two guard that blind spot.
// Note on <body>: the HTML parser merges duplicate <body>/<head> tags into a
// single node, so counting them can never detect a spliced document — verified
// against the broken revision, which served two <body> tags and still parsed to
// exactly one. The assertion is kept as a cheap malformed-serve guard, but the
// singleton landmarks below are what actually catch duplication: on that same
// revision they came back 2, 2 and 2.
test('page is a single document — one body, title, hero and nav', async ({ page }) => {
  await expect(page.locator('body')).toHaveCount(1);
  await expect(page.locator('title')).toHaveCount(1);
  await expect(page.locator('section.hero')).toHaveCount(1);
  await expect(page.locator('nav.nav-bar')).toHaveCount(1);
});

test('page has no duplicate ids', async ({ page }) => {
  const duplicates = await page.evaluate(() => {
    const counts = new Map();
    for (const el of document.querySelectorAll('[id]')) {
      counts.set(el.id, (counts.get(el.id) || 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([id, n]) => `${id} (${n}x)`);
  });
  expect(duplicates, `duplicate ids found: ${duplicates.join(', ') || '(none)'}`).toEqual([]);
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
  await expect(items.nth(0)).toContainText('Current Issues');
  await expect(items.nth(1)).toContainText('Meeting Summaries');
  await expect(items.nth(2)).toContainText('Your Taxes');
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

// The governing-bodies hero stat is a shortcut into Who Governs. It is a real
// <a href="#explore">, so it still navigates with JS disabled; the script
// upgrades it to also activate the tab.
test('hero stat "5 governing bodies" opens the Who Governs tab', async ({ page }) => {
  const stat = page.locator('a.stat[data-panel="explore-governs"]');
  await expect(stat).toBeVisible();
  await expect(stat).toContainText('5');
  await expect(stat).toHaveAttribute('href', '#explore');

  // Current Issues is the default tab; Who Governs starts hidden.
  await expect(page.locator('#explore-governs')).toBeHidden();

  await stat.click();

  await expect(page.locator('#explore-governs')).toBeVisible();
  await expect(page.locator('.explore-tab[data-panel="explore-governs"]'))
    .toHaveClass(/active-explore-tab/);
  await expect(page.locator('#explore-issues')).toBeHidden();
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

// Panel ids are generated as panel-<meeting-id>-<tab> by scripts/build.js.
// Before the build script they were hand-written and inconsistent (panel-exec,
// panel-town-sep-exec, panel-boeaug-exec); addressing them through this helper
// keeps the tests tied to the meeting they mean rather than to that history.
const panel = (page, meeting, tab) => page.locator(`#panel-${meeting}-${tab}`);
// The Village of Pelham meeting reachable in this tab is September 8; the
// July 14 meeting has been superseded and is archive-only.
const VILLAGE_SEP = 'pelham-board-sep2026';
// The Meeting Summaries tab shows only the most recent meeting per board,
// so the Town of Pelham meeting reachable here is September, not August.
const TOWN_SEP = 'town-council-sep2026';

test('Meeting Summaries — default meeting renders, Detailed Summary tab shows its content', async ({ page }) => {
  // Current Issues is the default Explore tab now — switch to Meeting Summaries first.
  await page.getByRole('button', { name: 'Meeting Summaries' }).click();

  const meetings = page.locator('#explore-meetings');
  await expect(meetings).toBeVisible();

  // Executive Summary is the default panel; the meeting date is shown up front.
  await expect(meetings.getByText('September 8, 2026').first()).toBeVisible();

  await page.getByRole('button', { name: 'Detailed Summary' }).click();

  const detailed = panel(page, VILLAGE_SEP, 'detailed');
  await expect(detailed).toBeVisible();
  await expect(detailed.getByText('Pelhamwood', { exact: false }).first()).toBeVisible();
});

/* --- Meeting switcher ------------------------------------------------------
 * Each processed meeting ships its own .mtg-set of three panels, shown and
 * hidden by data-meeting; bodies with nothing processed yet fall back to
 * #mtg-placeholder. Before that restructure the July panels were snapshotted at
 * load and swapped in via innerHTML, which only ever supported one real
 * meeting — these guard the switching now that there are two.
 *
 * Selector buttons are addressed by data-meeting rather than getByRole: their
 * accessible name concatenates the body and the date, and "Board of Education"
 * also appears on an Ask Pelham suggestion chip, so a name match is ambiguous.
 */
const meetingButton = (page, id) => page.locator(`.mtg-selector[data-meeting="${id}"]`);
const detailTab = (page, label) => page.locator('.detail-tab', { hasText: label });

async function openMeetings(page) {
  await page.getByRole('button', { name: 'Meeting Summaries' }).click();
  await expect(page.locator('#explore-meetings')).toBeVisible();
}

test('Meeting switcher — Town of Pelham panels render when that meeting is selected', async ({ page }) => {
  await openMeetings(page);
  await meetingButton(page, TOWN_SEP).click();

  const exec = panel(page, TOWN_SEP, 'exec');
  await expect(exec).toBeVisible();
  await expect(exec).toContainText('September 14, 2026');
  // Council names are published from the verified roster, not the pipeline's
  // ASR spellings (Rohan / Berg / McLaughlin / Jennings).
  await expect(exec).toContainText('Theresa Mohan');
  await expect(page.locator('#mtg-placeholder')).toBeHidden();
});

test('Meeting switcher — detail tabs scope to the selected meeting, not the July panels', async ({ page }) => {
  await openMeetings(page);
  await meetingButton(page, TOWN_SEP).click();

  await detailTab(page, 'Detailed Summary').click();
  const townDetailed = panel(page, TOWN_SEP, 'detailed');
  await expect(townDetailed).toBeVisible();
  await expect(townDetailed).toContainText('Greg Farrell');
  // The July set stays hidden: a tab click must not reveal the other meeting's
  // panel of the same name.
  await expect(panel(page, VILLAGE_SEP, 'detailed')).toBeHidden();
  await expect(panel(page, TOWN_SEP, 'exec')).toBeHidden();

  await detailTab(page, 'Full Transcript').click();
  await expect(panel(page, TOWN_SEP, 'transcript')).toBeVisible();
  await expect(panel(page, VILLAGE_SEP, 'transcript')).toBeHidden();
});

test('Meeting switcher — returning to the default meeting resets to Executive Summary', async ({ page }) => {
  await openMeetings(page);
  await meetingButton(page, TOWN_SEP).click();
  await detailTab(page, 'Full Transcript').click();
  await expect(panel(page, TOWN_SEP, 'transcript')).toBeVisible();

  await meetingButton(page, VILLAGE_SEP).click();

  // Back on the Village meeting, and reset to the first tab rather than holding
  // the transcript tab the previous meeting was left on.
  await expect(panel(page, VILLAGE_SEP, 'exec')).toBeVisible();
  await expect(panel(page, VILLAGE_SEP, 'transcript')).toBeHidden();
  await expect(panel(page, TOWN_SEP, 'exec')).toBeHidden();
  await expect(detailTab(page, 'Executive Summary')).toHaveClass(/active-tab/);
});

// Every governing body now has a real meeting, so there is no "coming soon"
// button left to click — this used to select the last placeholder and assert
// the fallback text. Inverted instead: walk every selector and require each to
// open a real panel set, never the placeholder. That catches the failure the
// old test could not, a selector added without matching .mtg-set markup, which
// would silently show a reader "will appear here once processed" for a meeting
// that has in fact been published.
test('Meeting switcher — every selector opens a real panel set, never the placeholder', async ({ page }) => {
  await openMeetings(page);

  const ids = await page.locator('.mtg-selector').evaluateAll((els) =>
    els.map((el) => el.dataset.meeting),
  );
  expect(ids.length).toBeGreaterThanOrEqual(4);

  for (const id of ids) {
    await meetingButton(page, id).click();
    const set = page.locator(`.mtg-set[data-meeting="${id}"]`);
    await expect(set, `no .mtg-set markup for selector "${id}"`).toBeVisible();
    // Default tab, and the fallback never surfaces for a published meeting.
    await expect(set.locator('.mtg-panel[data-tab="exec"]')).toBeVisible();
    await expect(page.locator('#mtg-placeholder')).toBeHidden();
  }
});

// The tab shows the most recent meeting per board, not every processed
// meeting. Superseded meetings are still generated into the DOM so the future
// archive page can reach them — they simply have no selector here.
test('Meeting Summaries — one selector per board, each its most recent meeting', async ({ page }) => {
  await openMeetings(page);

  const ids = await page.locator('.mtg-selector').evaluateAll((els) =>
    els.map((el) => el.dataset.meeting),
  );
  expect(ids).toEqual([
    'pelham-board-sep2026',   // Village of Pelham — Sept supersedes July
    'town-council-sep2026',   // Town of Pelham — Sept supersedes Aug
    'manor-board-sep2026',    // Pelham Manor — Sept supersedes Aug
    'board-of-ed-aug2026',    // Board of Education — Aug supersedes June
  ]);

  for (const superseded of [
    'pelham-board-jul2026', 'town-council-aug2026',
    'manor-board-aug2026', 'board-of-ed-jun2026',
  ]) {
    await expect(
      page.locator(`.mtg-set[data-meeting="${superseded}"]`),
      `${superseded} should still be in the DOM for the archive page`,
    ).toBeAttached();
    await expect(
      page.locator(`.mtg-selector[data-meeting="${superseded}"]`),
      `${superseded} should not be selectable from this tab`,
    ).toHaveCount(0);
  }

  await expect(page.getByRole('link', { name: /View all meetings/ })).toBeVisible();
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
  await expect(items.nth(0)).toContainText('Current Issues');
  await expect(items.nth(1)).toContainText('Meeting Summaries');
  await expect(items.nth(2)).toContainText('Your Taxes');
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
