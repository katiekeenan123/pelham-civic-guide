// Unit tests for scripts/build.js generators that have no content to render
// yet, so the page tests cannot reach them. No browser: the generator is fed
// the real content files plus a sample entry.

const { test, expect } = require('@playwright/test');
const build = require('../scripts/build');

function setup() {
  const data = build.phase1();
  const r = build.makeResolver(data.facts);
  const race = data.elections.races.find((x) => x.id === 'town-supervisor-and-clerk');
  return { data, r, race };
}

const SAMPLE = {
  title: 'Town Supervisor',
  date: '2026-10-26',
  recording_url: 'https://example.org/recording',
  topics: [
    { topic: 'Taxes', positions: [
      { candidate_id: 'theresa-mohan', point: 'Says point one.' },
      { candidate_id: 'scott-wolfgang', point: 'Says point two.' },
    ] },
    { topic: 'Ambulance', positions: [
      { candidate_id: 'scott-wolfgang', point: 'Says point three.' },
    ] },
  ],
};

test('debate summary — collapsed, disclaimer and recording link first, then topics listing only the candidates who spoke', () => {
  const { data, r, race } = setup();
  const html = build.generateDebateSummary(race, SAMPLE, data, r);

  expect(html).toMatch(/^\s*<details class="debate-summary-fold" id="debate-summary-town-supervisor-and-clerk-2026-10-26">/);
  expect(html).not.toMatch(/<details[^>]* open/);
  expect(html).toContain('View debate summary <span aria-hidden="true">▾</span>');
  expect(build.DEBATE_SUMMARY_DISCLAIMER).toBe('AI-generated summary from the debate recording. May contain errors. Watch the full recording:');
  expect(html.indexOf(build.DEBATE_SUMMARY_DISCLAIMER)).toBeLessThan(html.indexOf('debate-topic-title'));
  expect(html).toMatch(/<a href="https:\/\/example\.org\/recording" target="_blank" rel="noopener">Town Supervisor debate, October 26, 2026 →<\/a>/);

  const topics = [...html.matchAll(/class="debate-topic-title">([^<]+)</g)].map((m) => m[1]);
  expect(topics).toEqual(['Taxes', 'Ambulance']);
  const ambulance = html.slice(html.indexOf('>Ambulance<'));
  expect(ambulance).toContain('Scott Wolfgang');
  expect(ambulance).not.toContain('Theresa Mohan');
  const points = [...html.matchAll(/class="debate-position-point">([^<]+)</g)].map((m) => m[1]);
  expect(points).toEqual(['Says point one.', 'Says point two.', 'Says point three.']);
});

test('debate summary — a candidate from another race is a build error, not a silent entry', () => {
  const { data, r, race } = setup();
  const before = build.errors.length;
  const bad = { ...SAMPLE, topics: [{ topic: 'Taxes', positions: [{ candidate_id: 'arthur-long', point: 'Says something.' }] }] };
  const html = build.generateDebateSummary(race, bad, data, r);
  expect(build.errors.slice(before).join('\n')).toContain('arthur-long is not in race town-supervisor-and-clerk');
  expect(html).not.toContain('Arthur Long');
  build.errors.length = before;
});
