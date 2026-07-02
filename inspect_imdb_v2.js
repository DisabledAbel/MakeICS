import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
try {
    console.log('Navigating...');
    const response = await page.goto('https://www.imdb.com/calendar/?region=US', { waitUntil: 'networkidle', timeout: 30000 });
    console.log('Status:', response.status());

    await page.waitForTimeout(2000);

    const script = await page.$('#__NEXT_DATA__');
    if (script) {
        console.log('__NEXT_DATA__ found!');
        const text = await script.textContent();
        const data = JSON.parse(text);
        console.log('Data groups:', data.props?.pageProps?.groups?.length);
        if (data.props?.pageProps?.groups?.length > 0) {
            const firstEntry = data.props?.pageProps?.groups[0].entries[0];
            console.log('First entry sample:', JSON.stringify(firstEntry, null, 2));
        }
    } else {
        console.log('__NEXT_DATA__ NOT found.');
    }
} catch (e) {
    console.error('Error:', e);
} finally {
    await browser.close();
}
