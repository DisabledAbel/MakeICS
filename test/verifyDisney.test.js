import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateVariants, matchVariant, verifyEpisodeOnGoogle } from '../scripts/verify-disney.js';

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

test('verifyEpisodeOnGoogle in verify-disney matches correct date using mocked page', async () => {
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

test('Disney network filtering works as expected', () => {
  const mockSchedule = [
    { show: { name: 'SuperKitties', network: { name: 'Disney Junior' } } },
    { show: { name: 'Wizards Beyond Waverly Place', network: { name: 'Disney Channel' } } },
    { show: { name: 'Bluey', webChannel: { name: 'Disney+' } } },
    { show: { name: 'Spongebob', network: { name: 'Nickelodeon' } } }
  ];

  const filtered = mockSchedule.filter(item => {
    const net = item.show?.network?.name || item.show?.webChannel?.name || '';
    return net.toLowerCase().includes('disney channel') || net.toLowerCase().includes('disney junior');
  });

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].show.name, 'SuperKitties');
  assert.equal(filtered[1].show.name, 'Wizards Beyond Waverly Place');
});
