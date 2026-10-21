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
  candidates: [
    { candidate_id: 'theresa-mohan', points: ['Says point one.', 'Says point two.'] },
    { candidate_id: 'scott-wolfgang', points: ['Says point three.'] },
  ],
};

test('debate summary — candidates in order with their points, under the AI disclaimer and recording link', () => {
  const { data, r, race } = setup();
  const html = build.generateDebateSummary({ ...race, debate_summary: [SAMPLE] }, data, r);

  expect(html).toContain('id="debate-summary-town-supervisor-and-clerk-1"');
  expect(html).toContain('Debate Summary · Town Supervisor');
  expect(html).toContain('October 26, 2026');
  expect(html).toContain(build.DEBATE_SUMMARY_DISCLAIMER);
  expect(build.DEBATE_SUMMARY_DISCLAIMER).toBe('AI-generated summary from the debate recording. May contain errors. Watch the full recording:');
  expect(html).toMatch(/<a href="https:\/\/example\.org\/recording" target="_blank" rel="noopener">/);

  const names = [...html.matchAll(/class="debate-summary-name">([^<]+?) </g)].map((m) => m[1]);
  expect(names).toEqual(['Theresa Mohan', 'Scott Wolfgang']);
  const points = [...html.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
  expect(points).toEqual(['Says point one.', 'Says point two.', 'Says point three.']);
});

test('debate summary — a candidate from another race is a build error, not a silent card', () => {
  const { data, r, race } = setup();
  const before = build.errors.length;
  const bad = { ...SAMPLE, candidates: [{ candidate_id: 'arthur-long', points: ['Says something.'] }] };
  const html = build.generateDebateSummary({ ...race, debate_summary: [bad] }, data, r);
  expect(build.errors.slice(before).join('\n')).toContain('arthur-long is not in race town-supervisor-and-clerk');
  expect(html).not.toContain('Arthur Long');
  build.errors.length = before;
});
