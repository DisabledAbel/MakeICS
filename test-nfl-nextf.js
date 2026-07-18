import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('https://www.nfl.com/schedules', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const matches = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      const text = scripts.map(s => s.innerText).join('\n');
      // Look for game-related substrings or regexes like gameDate, gameTime, date, time
      // Let's find occurrences of strings like "a8fb0d78" (game ID) or "2026-09"
      const res = [];
      const gameIds = ['a8fb0d78-4feb-11f1-abca-2c54536568a9'];
      gameIds.forEach(id => {
        const idx = text.indexOf(id);
        if (idx !== -1) {
          res.push(text.slice(idx - 500, idx + 1500));
        }
      });
      return res;
    });

    console.log('Matches in script content:');
    console.log(matches);

  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
})();
