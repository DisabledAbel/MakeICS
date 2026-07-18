import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('https://www.nfl.com/schedules/2026/by-week/week-1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const structure = await page.evaluate(() => {
      // Find h3 elements that represent date headers
      const headings = Array.from(document.querySelectorAll('h3.header-2-sans'));
      return headings.map(h => {
        // Let's find the parent or container that holds this heading and the list of games
        // We can traverse up or find sibling elements
        let container = h.parentElement;
        while (container && !container.querySelector('ul, li')) {
          container = container.parentElement;
        }

        const cards = container ? Array.from(container.querySelectorAll('li[class*="flex-none"]')) : [];
        return {
          header: h.innerText.trim(),
          cardsCount: cards.length,
          cardTexts: cards.map(c => c.innerText.trim().replace(/\s+/g, ' '))
        };
      });
    });

    console.log('Hierarchy extraction result:');
    console.log(JSON.stringify(structure, null, 2));

  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
})();
