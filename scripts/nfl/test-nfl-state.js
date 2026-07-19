import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('https://www.nfl.com/schedules', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const nextData = await page.evaluate(() => {
      const nextDataEl = document.querySelector('#__NEXT_DATA__');
      if (nextDataEl) {
        return { found: true, text: nextDataEl.innerText.slice(0, 1000) };
      }
      return { found: false };
    });
    console.log('__NEXT_DATA__ Result:', nextData);

    const otherState = await page.evaluate(() => {
      // Find all script tags that have some state keyword
      const scripts = Array.from(document.querySelectorAll('script'));
      return scripts.map((s, idx) => ({
        idx,
        src: s.getAttribute('src'),
        textSnippet: s.innerText ? s.innerText.slice(0, 200) : ''
      })).filter(s => s.textSnippet.includes('state') || s.textSnippet.includes('window.') || s.textSnippet.includes('games'));
    });
    console.log('Other state script snippets:', otherState.length);
    console.log(otherState);

  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
})();
