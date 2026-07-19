import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('https://www.nfl.com/schedules/2026/by-week/week-1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const times = await page.evaluate(() => {
      const timeEls = Array.from(document.querySelectorAll('time'));
      return timeEls.map(el => ({
        parentTag: el.parentElement ? el.parentElement.tagName : null,
        parentText: el.parentElement ? el.parentElement.innerText.trim().replace(/\s+/g, ' ') : null,
        datetime: el.getAttribute('datetime'),
        text: el.innerText.trim()
      }));
    });

    console.log('Total time elements found:', times.length);
    console.log(times);

  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
})();
