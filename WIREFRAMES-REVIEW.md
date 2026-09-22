# Pelham Engagement Project — Wireframe Review Document
*September 2026 · For design review before multi-page restructure*

---

## Overview

This document summarizes the proposed 9-page structure for the Pelham Engagement Project multi-page restructure (Part 2). Wireframes were reviewed and approved iteratively. This document captures the key design decisions for each page before implementation begins.

**9 pages:**
1. Home
2. Current Issues
3. Elections
4. Meetings
5. Your Taxes
6. Pelham Government 101
7. Get Involved
8. Ask Pelham AI
9. About & Corrections

---

## Global Design Decisions

**Navigation:**
- Desktop: horizontal nav bar with "More ▾" dropdown for overflow (Gov 101, Get Involved, About)
- Mobile: hamburger icon → slide-in drawer from the right, all 9 pages listed with icons
- Active page highlighted in blue
- Elections page gets a "Nov 3" badge until after election day
- Footer disclaimer always visible in mobile drawer

**Consistent across all pages:**
- "Ask Pelham AI" CTA at the bottom of every content page
- "Have feedback?" one-line link routes to About & Corrections
- Vetted sources shown on AI and About pages

---

## Page 1 — Home

**Purpose:** First impression for new residents; quick scan for returning visitors.

**Layout:**
- Hero — tagline + 4 stat pills (residents, governing bodies [clickable → Gov 101], meetings summarized, Examiner articles tracked)
- Current Issues — max 4 cards, ordered by urgency + recency
- Elections banner — red callout strip with Nov 3 date and races summary
- Meeting Summaries preview — most recent meeting per board (4 cards)
- Ask Pelham AI entry point — search bar with 3 suggestion chips
- "Have feedback?" one-line link

**Key decisions:**
- Max 4 Current Issues on home — keeps page above the fold
- "5 distinct governing bodies" stat is clickable → activates Who Governs tab
- Elections banner stays prominent until Nov 3
- Meeting preview shows 1 per board, links to full Meetings page
- Hero stats will eventually be dynamic (pulled from Supabase at build time)

---

## Page 2 — Current Issues

**Purpose:** Full list of what's happening across all Pelham governing bodies.

**Layout:**
- Page header with last-updated date
- Filter bar: All / 🔴 Active / 🟡 Watch / Village of Pelham / Pelham Manor / Town / Schools
- "Show resolved" toggle (collapsed by default)
- Active issues — 2-column card grid with status dot, tag, description, governing body, last-updated date, Examiner source link
- Watch issues — same grid, muted
- Resolved toggle — expands 1–2 most recent; full archive at /issues/archive
- Ask Pelham AI CTA

**Key decisions:**
- Separate "Village of Pelham" and "Pelham Manor" filter buttons (not combined "Village")
- Last-updated date shown on each card
- 2-column grid (not 3)
- Resolved issues on separate archive page — toggle shows preview only
- Show resolved is collapsed by default

---

## Page 3 — Elections

**Purpose:** All races, candidates, voter info — one page.

**Layout:**
- Page header with election date (Nov 3, 2026) + voter registration pill
- Race 1: Village of Pelham (3 seats, most contested) — Democrats vs. Neighborhood Party, 3 cards each
- Race 2: Town of Pelham — Supervisor + Clerk (2 separate race cards)
- Race 3: Village of Pelham Manor — 2 seats, NP vs. Democrats
- Voter info row — registration deadline, polling hours, polling locations
- Ask Pelham AI CTA

**Key decisions:**
- Candidates grouped by party within each race
- Village of Pelham first (most contested, most relevant to most residents)
- shared_platforms field eliminates the 3× duplicated NP platform paragraph
- Voter info at the bottom of the page, not per-race
- November 3 confirmed election date

---

## Page 4 — Meetings

**Purpose:** Meeting summaries for all four boards with archive access.

**Layout:**
- Page header
- Board tabs: BOE · Town · Village of Pelham · Pelham Manor (BOE first — largest tax share)
- Left column: meeting list, most recent 3 per tab visible, year groups collapsed for older meetings (e.g. "2025 — 8 meetings")
- Right column: summary panel — loads when meeting selected
  - Executive / Detailed / Transcript tabs
  - "Residents Who Showed Up" block near top
  - Votes table (expandable)
  - Action items table
  - "▶ Watch recording" link
  - "Ask Pelham AI about this meeting" button
- "View all meetings →" link at bottom of left column

**Key decisions:**
- BOE first (largest share of property taxes ~60%, affects all residents)
- Town second (town-wide services), Village of Pelham third, Pelham Manor fourth
- Year groupings for archive — no infinite scroll, no pagination
- "Ask Pelham AI about this meeting" pre-populates meeting context (upgrades naturally when meeting RAG is live)
- Recording link on every panel for verification ("trust but verify")
- Future: municipality preference to reorder tabs per resident

---

## Page 5 — Your Taxes

**Purpose:** Help residents understand where their tax bill comes from and who controls it.

**Layout:**
- Page header
- Tax bar chart — 4 bars (school, village, county, town) with honest footnotes about unverified percentages
- Village vs. Manor comparison — apples-to-apples on same $1,045,204 assessed value ($6,807 vs $6,035)
- "Who decides what you pay" — 4 cards (BOE, Village, Town, County) each with budget figures and website link
- FAQ section (always open) — 3 questions: how to pay, why bill went up, what is the tax cap
- Receiver of Taxes contact box — phone number prominently placed
- Ask Pelham AI CTA

**Key decisions:**
- No tax calculator
- FAQ stays open (may collapse if page gets longer)
- Bar widths are illustrative — honest footnote required
- $6,807 vs $6,035 is the correct apples-to-apples comparison (not $7,387 median vs $6,035)
- $7,387 median figure shown separately with explanation

---

## Page 6 — Pelham Government 101

**Purpose:** Answer "wait, how many governments does Pelham have?" for new residents.

**Layout:**
- Page header
- "How it's structured" — vertical layer diagram: County → Town → Villages (split) → BOE
  - Color-coded by scope (blue = all residents, yellow = village-only, red = all/BOE)
  - Shows which residents each body affects
- "What does each body control" — 4 cards (County, Town, Villages, Schools)
- "Who's in charge right now" — 4 cards with current officials, links to Elections page where races are contested
- Ask Pelham AI CTA

**Key decisions:**
- Page name: "Pelham Government 101" (playful, specific to Pelham)
- Officials section links to Elections page rather than duplicating candidate info
- Layer diagram is the most important visual — makes the "two villages, one town" structure immediately clear
- Full officials roster lives here (generated from officials.json) not just on the prompt

---

## Page 7 — Get Involved

**Purpose:** Help residents engage with their local government — promoted from section to full page.

**Layout:**
- Page header: "Your neighbors are running your local government"
- 4-step engagement ladder (numbered cards):
  1. Start with a conversation (officials are neighbors — direct outreach first)
  2. Attend a public meeting
  3. Write a letter to the editor
  4. Organize with neighbors
- Meeting schedule table — all 4 boards, cadence, location, live stream link
- Public comment guide — 2-column format (public comment structure vs. letter structure)
  - Key tip: "Respectful doesn't mean weak — your argument does the work"
- Ask Pelham AI CTA — "Want help preparing for a meeting or writing a comment?"

**Key decisions:**
- Step 1 is conversation, not meeting attendance — neighbors talking to neighbors first
- This is NOT an escalation ladder — it's a natural progression
- Public comment guide is the full text from the system prompt, now surfaced on the page
- Meeting schedule table is the single source for what's currently in 4 places

---

## Page 8 — Ask Pelham AI

**Purpose:** Full AI interface as its own page.

**Layout:**
- Page header
- 8 suggestion chips ("Try asking about...")
- Chat interface with example welcome message
- Each AI response has: answer, sources footnote, 👍 👎 ⚑ feedback buttons
- "About these answers" disclaimer below chat
- Vetted sources chips
- "See something wrong? Submit a correction →" link

**Key decisions:**
- Chat starts blank (no pre-loaded example conversation)
- Feedback buttons on every response (like Claude.ai)
- Disclaimer below the chat, not in the way
- Correction link routes to About & Corrections page
- Future: "Ask about this meeting" button on Meetings page pre-populates context

---

## Page 9 — About & Corrections

**Purpose:** Mission statement, sources, corrections form, feedback form, corrections log.

**Layout:**
- Page header
- 2-column: Mission statement (left) + How it works (right, as bullet principles)
- Vetted sources — 6 cards in 3-column grid
- Two forms side by side:
  - Left: Submit a correction (primary — blue button) — section dropdown, what's wrong, what's correct, optional contact
  - Right: Share feedback (secondary) — type dropdown, open text, optional contact
- Corrections log — public, dated, "Fixed" badge
- Footer: "Independent · Not affiliated with any candidate, party, or governing body"

**Key decisions:**
- Two distinct forms: corrections (factual errors) vs. feedback (suggestions, missing topics)
- Corrections log is public — builds trust
- Get Involved moved to its own page — About stays focused on mission + accountability
- CONTACT_EMAIL is interim (katherine.e.keenan@gmail.com) — update before Examiner handoff

---

## Mobile Navigation

**Closed:** Hamburger icon (top right) + brand name (top left). Clean, no nav items visible.

**Open (slide-in from right):**
- All 9 pages listed with icons
- Active page highlighted in blue
- Elections shows "Soon" badge until Nov 3
- Footer disclaimer at bottom of drawer
- ✕ close button top right

**Desktop:**
- Horizontal nav bar
- Primary items: Home · Issues · Elections · Meetings · Taxes
- "More ▾" dropdown: Gov 101 · Get Involved · Ask AI · About

---

## Implementation Notes

**Build order (recommended):**
1. Shell template + nav (desktop + mobile) + routing
2. Home page (most visible, tests hero + issues + meetings preview)
3. Current Issues page (JSON-driven, straightforward)
4. Elections page (already well-tested in current site)
5. Meetings page (most complex — archive + panel system)
6. Your Taxes page (mostly static, some JSON tokens)
7. Pelham Government 101 (new content, officials roster)
8. Get Involved (new content)
9. Ask Pelham AI (AI interface extraction)
10. About & Corrections (forms extraction)

**Test strategy:**
- After each page: run npm run test:local (UI suite)
- After elections and meetings pages: run full npm test (AI suite too)
- Before deploying: full suite must pass
- Visual check on mobile after each page

**Prerequisites before building:**
- Reviewer sign-off on wireframes (this document)
- Reviewer sign-off on code quality (three fixes from today)
- Decision on URL structure (hash-based SPA vs. separate HTML files)

---

*Ready for review — September 2026*
