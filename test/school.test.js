import test from 'node:test';
import assert from 'node:assert/strict';
import { getCountries, getSubdivisions, getSchoolHolidays, toIcs } from '../lib/school.js';

const countriesPayload = [{ code: 'DE', name: [{ text: 'Germany' }] }];
const subdivisionsPayload = [{ code: 'DE-BE', shortName: 'Berlin', name: [{ text: 'Berlin' }] }];
const holidaysPayload = [
  {
    id: '1',
    name: [{ text: 'Summer Break' }],
    startDate: '2026-07-20',
    endDate: '2026-08-30',
    type: 'School'
  }
];

function createFetchMock() {
  return async (url) => {
    if (url.includes('/Countries')) {
      return Response.json(countriesPayload);
    }
    if (url.includes('/Subdivisions')) {
      return Response.json(subdivisionsPayload);
    }
    if (url.includes('/SchoolHolidays')) {
      return Response.json(holidaysPayload);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test('getCountries returns countries', async () => {
  const countries = await getCountries({ fetchImpl: createFetchMock() });
  assert.equal(countries.length, 1);
  assert.equal(countries[0].code, 'DE');
});

test('getSchoolHolidays returns holidays', async () => {
  const result = await getSchoolHolidays({
    countryCode: 'DE',
    subdivisionCode: 'DE-BE',
    fetchImpl: createFetchMock()
  });

  assert.equal(result.holidays.length, 1);
  assert.equal(result.holidays[0].name, 'Summer Break');
});

test('toIcs creates ICS for school holidays', async () => {
  const result = await getSchoolHolidays({
    countryCode: 'DE',
    fetchImpl: createFetchMock()
  });
  result.generatedAt = '2026-01-01T00:00:00Z';

  const ics = toIcs(result);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:Summer Break/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260720/);
  // End date should be exclusive: 2026-08-30 + 1 day = 2026-08-31
  assert.match(ics, /DTEND;VALUE=DATE:20260831/);
});
