import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPORTS_DATA_DIR = path.join(__dirname, '../lib/data/sports');
const SUPPLEMENTAL_DATA_DIR = path.join(SPORTS_DATA_DIR, 'supplemental');

const FIELDS_TO_CHECK = ['strVenue', 'strHomeTeam', 'strAwayTeam', 'strEvent', 'strLeague'];

async function processFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);

    if (!data.events || !Array.isArray(data.events)) {
      return;
    }

    let modified = false;
    const TBD_VARIANTS = ['', 'TBA', 'TO BE DETERMINED'];

    for (const event of data.events) {
      for (const field of FIELDS_TO_CHECK) {
        const value = event[field];
        const normalizedValue = typeof value === 'string' ? value.trim() : value;

        const isMissing = value === null || value === undefined || normalizedValue === '';
        const isTbaVariant = typeof normalizedValue === 'string' && TBD_VARIANTS.includes(normalizedValue.toUpperCase());

        if ((isMissing || isTbaVariant) && value !== 'TBD') {
          event[field] = 'TBD';
          modified = true;
        }
      }
    }

    if (modified) {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      console.log(`Updated ${filePath}`);
    }
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error.message);
  }
}

async function main() {
  const directories = [SPORTS_DATA_DIR, SUPPLEMENTAL_DATA_DIR];

  for (const dir of directories) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await processFile(path.join(dir, file));
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Error reading directory ${dir}:`, error.message);
      }
    }
  }
}

main().catch(console.error);
