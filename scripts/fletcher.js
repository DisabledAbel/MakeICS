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
    const COMPLETED_STATUSES = ['FT', 'AET', 'PEN', 'AOT'];
    const now = new Date();

    for (const event of data.events) {
      // 1. Check for strVenue specifically to handle fallback and completed games
      const status = event.strStatus?.toUpperCase();
      const isCompleted = COMPLETED_STATUSES.includes(status);

      for (const field of FIELDS_TO_CHECK) {
        let value = event[field];

        // Special handling for strEvent to replace variants inline
        if (field === 'strEvent' && typeof value === 'string') {
          const originalValue = value;
          for (const variant of TBD_VARIANTS) {
            if (variant === '') continue;
            const regex = new RegExp(`\\b${variant}\\b`, 'gi');
            value = value.replace(regex, 'TBD');
          }
          if (value !== originalValue) {
            event[field] = value;
            modified = true;
          }
        }

        const normalizedValue = typeof value === 'string' ? value.trim() : value;
        const isMissing = value === null || value === undefined || normalizedValue === '';
        const isTbaVariant = typeof normalizedValue === 'string' && TBD_VARIANTS.includes(normalizedValue.toUpperCase());

        if (isMissing || isTbaVariant) {
          if (value === 'TBD') continue;

          // Skip setting TBD for venue if game is completed or if it's potentially a home game fallback candidate
          if (field === 'strVenue') {
            if (isCompleted) continue;

            // If game is in the past and venue is still TBD/TBA/Missing, it shouldn't be TBD if we don't want it to show up as upcoming
            const eventDate = new Date(event.strTimestamp || `${event.dateEvent}T${event.strTime || '00:00:00'}Z`);
            if (!isNaN(eventDate.getTime()) && eventDate < now) {
              // For past games with missing venue, leave it empty or null to avoid "TBD" which looks like an upcoming game
              if (value !== null && value !== '') {
                event[field] = '';
                modified = true;
              }
              continue;
            }

            // If it's a home game and strVenue is missing, leave it empty to allow fallback in lib/sports.js
            if (isMissing) continue;
            if (isTbaVariant) {
              event[field] = '';
              modified = true;
              continue;
            }
          }

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
