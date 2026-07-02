import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
try {
    await page.goto('https://www.imdb.com/calendar/?region=US', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const data = await page.evaluate(() => {
        const script = document.getElementById('__NEXT_DATA__');
        return script ? JSON.parse(script.textContent) : 'No script found';
    });
    console.log(JSON.stringify(data, null, 2).slice(0, 10000));
} catch (e) {
    console.error(e);
} finally {
    await browser.close();
}
