import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateVariants, matchVariant, verifyEpisodeOnGoogle, isDisneyNetwork } from '../scripts/verify-disney.js';

test('formatDateVariants in verify-disney returns correct variant shapes', () => {
  const variants = formatDateVariants('2026-06-01');
  assert.equal(variants.length, 5);
  assert.equal(variants[0].text, '2026-06-01');
  assert.equal(variants[0].hasYear, true);
  assert.equal(variants[3].text, 'june 1');
  assert.equal(variants[3].hasYear, false);
});

test('matchVariant in verify-disney correctly matches dates', () => {
  // June 1 should not match "June 15"
  assert.equal(matchVariant('release date is june 15', { text: 'june 1', hasYear: false }), false);
  // June 1 should match "June 1"
  assert.equal(matchVariant('release date is june 1', { text: 'june 1', hasYear: false }), true);
  // June 1 should match "June 1, 2026"
  assert.equal(matchVariant('release date is june 1, 2026', { text: 'june 1', hasYear: false }), true);
});

test('verifyEpisodeOnGoogle in verify-disney matches correct date using mocked page - TVMaze match only', async () => {
  const mockPage = {
    goto: async () => {},
    waitForTimeout: async () => {},
    innerText: async () => 'body content with june 11, 2026 release date'
  };

  const verifiedDate = await verifyEpisodeOnGoogle(
    mockPage,
    'SuperKitties',
    2,
    3,
    '2026-06-11',
    '2026-06-12'
  );

  // TVMaze date was 2026-06-11, which matches "june 11, 2026"
  // IMDb date was 2026-06-12, which does not match
  // Hence Google should match TVMaze date
  assert.equal(verifiedDate, '2026-06-11');
});

test('verifyEpisodeOnGoogle in verify-disney matches correct date using mocked page - IMDb match only', async () => {
  const mockPage = {
    goto: async () => {},
    waitForTimeout: async () => {},
    innerText: async () => 'body content with june 12, 2026 release date'
  };

  const verifiedDate = await verifyEpisodeOnGoogle(
    mockPage,
    'SuperKitties',
    2,
    3,
    '2026-06-11',
    '2026-06-12'
  );

  // TVMaze date was 2026-06-11, which does not match
  // IMDb date was 2026-06-12, which matches
  // Hence Google should match IMDb date
  assert.equal(verifiedDate, '2026-06-12');
});

test('verifyEpisodeOnGoogle in verify-disney matches correct date using mocked page - both match (IMDb takes precedence)', async () => {
  const mockPage = {
    goto: async () => {},
    waitForTimeout: async () => {},
    innerText: async () => 'body content mentions both june 11, 2026 and june 12, 2026'
  };

  const verifiedDate = await verifyEpisodeOnGoogle(
    mockPage,
    'SuperKitties',
    2,
    3,
    '2026-06-11',
    '2026-06-12'
  );

  // Both match, so IMDb date (2026-06-12) should take precedence
  assert.equal(verifiedDate, '2026-06-12');
});

test('verifyEpisodeOnGoogle in verify-disney matches correct date using mocked page - neither matches (falls back to TVMaze)', async () => {
  const mockPage = {
    goto: async () => {},
    waitForTimeout: async () => {},
    innerText: async () => 'body content has no matching dates whatsoever'
  };

  const verifiedDate = await verifyEpisodeOnGoogle(
    mockPage,
    'SuperKitties',
    2,
    3,
    '2026-06-11',
    '2026-06-12'
  );

  // Neither matches, fallback to TVMaze date
  assert.equal(verifiedDate, '2026-06-11');
});

test('verifyEpisodeOnGoogle in verify-disney falls back to TVMaze date on block/CAPTCHA', async () => {
  const mockPage = {
    goto: async () => {},
    waitForTimeout: async () => {},
    innerText: async () => 'unusual traffic detected from your system'
  };

  const verifiedDate = await verifyEpisodeOnGoogle(
    mockPage,
    'SuperKitties',
    2,
    3,
    '2026-06-11',
    '2026-06-12'
  );

  assert.equal(verifiedDate, '2026-06-11');
});

test('Disney network filtering works as expected using the isDisneyNetwork helper', () => {
  const mockSchedule = [
    { name: 'SuperKitties', network: { name: 'Disney Junior' } },
    { name: 'Wizards Beyond Waverly Place', network: { name: 'Disney Channel' } },
    { name: 'Bluey', webChannel: { name: 'Disney+' } },
    { name: 'Spongebob', network: { name: 'Nickelodeon' } }
  ];

  const filtered = mockSchedule.filter(isDisneyNetwork);

  assert.equal(filtered.length, 3);
  assert.equal(filtered[0].name, 'SuperKitties');
  assert.equal(filtered[1].name, 'Wizards Beyond Waverly Place');
  assert.equal(filtered[2].name, 'Bluey');

  // Test individual checks
  assert.equal(isDisneyNetwork({ name: 'SuperKitties' }), true); // statically known
  assert.equal(isDisneyNetwork({ name: 'Spongebob' }), false);
});
