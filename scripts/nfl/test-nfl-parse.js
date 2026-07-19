import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('https://www.nfl.com/schedules', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const parsedGames = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      const text = scripts.map(s => s.innerText).join('\n');

      // Let's find all chunks that look like game objects.
      // A game object has: "homeTeam":{"fullName":"..."} and "awayTeam":{"fullName":"..."} and "time":"..."
      // Let's find all occurrences of "homeTeam":{"fullName":"..."}
      // Wait, let's extract them using regex
      // First, clean up the text from escaping
      const cleanText = text
        .replace(/\\\\\\\\\\\\"/g, '"')
        .replace(/\\\\\\\\"/g, '"')
        .replace(/\\\\"/g, '"')
        .replace(/\\\\/g, '')
        .replace(/\\"/g, '"');

      // Let's match any substring that contains "homeTeam":{"id":"...","fullName":"..."} and "awayTeam" and "time"
      // We can use a regex to find all instances of game object patterns
      const gamesList = [];
      const gameRegex = /{"id":"[^"]+","homeTeam":{[^}]+},"awayTeam":{[^}]+},[^}]+"time":"[^"]+"/g;

      // Let's do a more robust find: we can look for `"gameId"` or `"carouselCardPropsList"` or `"queries"` array.
      // Wait! In the cleanText, can we find `"homeTeam":{"id":"`?
      let pos = 0;
      while (true) {
        const index = cleanText.indexOf('"homeTeam":{"id":', pos);
        if (index === -1) break;

        // Find the start of the enclosing object or array
        // Let's grab a chunk of 2000 characters around it
        const chunk = cleanText.slice(Math.max(0, index - 300), index + 1500);

        // Let's extract the game details using custom regexes from the chunk
        const idMatch = chunk.match(/"id":"([a-f0-9-]+)"/);
        const homeNameMatch = chunk.match(/"homeTeam":{[^}]*"fullName":"([^"]+)"/);
        const awayNameMatch = chunk.match(/"awayTeam":{[^}]*"fullName":"([^"]+)"/);
        const dateMatch = chunk.match(/"date":"([^"]+)"/);
        const timeMatch = chunk.match(/"time":"([^"]+)"/);
        const venueNameMatch = chunk.match(/"venue":{[^}]*"name":"([^"]+)"/);

        if (idMatch && homeNameMatch && awayNameMatch && timeMatch) {
          const game = {
            id: idMatch[1],
            homeTeam: homeNameMatch[1],
            awayTeam: awayNameMatch[1],
            date: dateMatch ? dateMatch[1] : null,
            time: timeMatch[1],
            venue: venueNameMatch ? venueNameMatch[1] : null
          };
          if (!gamesList.some(g => g.id === game.id)) {
            gamesList.push(game);
          }
        }

        pos = index + 17; // move past
      }

      return gamesList;
    });

    console.log('Parsed Games list from page state:', parsedGames.length);
    console.log(JSON.stringify(parsedGames, null, 2));

  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
})();
