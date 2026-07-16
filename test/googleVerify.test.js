import test from 'node:test';
import assert from 'node:assert/strict';

// Simple unit tests for formatDateVariants and matchVariant logic from scripts/google-verify.js
import { spawnSync } from 'node:child_process';

test('formatDateVariants returns proper objects with year markers', () => {
  // Rather than importing the script (which runs main automatically), we can replicate or test the matching logic
  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function formatDateVariants(dateStr) {
    if (!dateStr) return [];
    const d = new Date(dateStr + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return [{ text: dateStr.toLowerCase(), hasYear: true }];

    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const shortMonths = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];

    const year = d.getUTCFullYear();
    const monthIdx = d.getUTCMonth();
    const day = d.getUTCDate();

    const mName = months[monthIdx];
    const sName = shortMonths[monthIdx];

    return [
      { text: dateStr.toLowerCase(), hasYear: true },
      { text: `${mName} ${day}, ${year}`.toLowerCase(), hasYear: true },
      { text: `${sName} ${day}, ${year}`.toLowerCase(), hasYear: true },
      { text: `${mName} ${day}`.toLowerCase(), hasYear: false },
      { text: `${sName} ${day}`.toLowerCase(), hasYear: false }
    ];
  }

  function matchVariant(bodyText, variant) {
    if (variant.hasYear) {
      return bodyText.includes(variant.text);
    } else {
      const escaped = escapeRegExp(variant.text);
      const regex = new RegExp(escaped + '(?!\\d)');
      return regex.test(bodyText);
    }
  }

  const variants = formatDateVariants('2026-06-01');
  assert.equal(variants.length, 5);
  assert.equal(variants[0].text, '2026-06-01');
  assert.equal(variants[0].hasYear, true);
  assert.equal(variants[3].text, 'june 1');
  assert.equal(variants[3].hasYear, false);

  // June 1 should not match "June 15"
  assert.equal(matchVariant('release date is june 15', { text: 'june 1', hasYear: false }), false);
  // June 1 should match "June 1"
  assert.equal(matchVariant('release date is june 1', { text: 'june 1', hasYear: false }), true);
  // June 1 should match "June 1, 2026"
  assert.equal(matchVariant('release date is june 1, 2026', { text: 'june 1', hasYear: false }), true);
});

test('TVMaze schedule discovery parses show names correctly', () => {
  const mockSchedule = [
    {
      show: { name: 'Show A' }
    },
    {
      show: { name: 'Show B' }
    },
    {
      show: null
    }
  ];

  const showSet = new Set();
  const scheduleData = mockSchedule;
  if (Array.isArray(scheduleData)) {
    for (const item of scheduleData) {
      const name = item.show?.name;
      if (typeof name === 'string' && name.trim()) {
        showSet.add(name.trim());
      }
    }
  }

  assert.equal(showSet.size, 2);
  assert.ok(showSet.has('Show A'));
  assert.ok(showSet.has('Show B'));
});
