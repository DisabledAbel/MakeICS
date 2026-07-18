import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('https://www.nfl.com/schedules/2026/by-week/week-18', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const result = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      const text = scripts.map(s => s.innerText).join('\n');

      const clean = text
        .replace(/\\\\\\\\\\\\"/g, '"')
        .replace(/\\\\\\\\"/g, '"')
        .replace(/\\\\"/g, '"')
        .replace(/\\"/g, '"')
        .replace(/\\\\u0022/g, '"')
        .replace(/\\\\u002f/g, '/')
        .replace(/\\\\/g, '');

      const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
      const games = [];
      let match;

      while ((match = uuidRegex.exec(clean)) !== null) {
        const gameId = match[0];
        if (gameId.startsWith('1040')) continue; // Skip team/venue profiles!

        const idx = match.index;
        const chunk = clean.slice(idx, idx + 1500);

        if (chunk.includes('homeTeam') && chunk.includes('awayTeam')) {
          const extractProp = (subChunk, key) => {
            const keyIdx = subChunk.indexOf('"' + key + '"');
            if (keyIdx === -1) return null;
            const sub = subChunk.slice(keyIdx + key.length + 2);
            const m = sub.match(/[:"\s]+([^"{}]+)/);
            return m ? m[1].trim() : null;
          };

          const homeIdx = chunk.indexOf('homeTeam');
          const awayIdx = chunk.indexOf('awayTeam');

          const homeSub = chunk.slice(homeIdx, homeIdx + 300);
          const homeNameMatch = homeSub.match(/"fullName"\s*:\s*"([^"]+)"/) || homeSub.match(/"nickName"\s*:\s*"([^"]+)"/);
          const homeName = homeNameMatch ? homeNameMatch[1].trim() : null;

          const awaySub = chunk.slice(awayIdx, awayIdx + 300);
          const awayNameMatch = awaySub.match(/"fullName"\s*:\s*"([^"]+)"/) || awaySub.match(/"nickName"\s*:\s*"([^"]+)"/);
          const awayName = awayNameMatch ? awayNameMatch[1].trim() : null;

          const timeVal = extractProp(chunk, 'gameTime') || extractProp(chunk, 'time');
          const dateVal = extractProp(chunk, 'date');

          const venueIdx = chunk.indexOf('venue');
          let venueName = null;
          if (venueIdx !== -1) {
            const venueSub = chunk.slice(venueIdx, venueIdx + 300);
            const venueMatch = venueSub.match(/"name"\s*:\s*"([^"]+)"/);
            venueName = venueMatch ? venueMatch[1].trim() : null;
          }

          games.push({
            id: gameId,
            homeTeam: homeName,
            awayTeam: awayName,
            date: dateVal,
            time: timeVal,
            venue: venueName,
            hasT: timeVal ? timeVal.includes('T') : false
          });
        }
      }

      return games;
    });

    console.log(result);

  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
})();
