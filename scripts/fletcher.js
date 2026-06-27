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
    const isSupplemental = !!data.teamId;
    const trackedTeamId = data.teamId;
    const trackedTeamName = (data.teamName || '').toLowerCase().trim();
    const COMPLETED_STATUSES = ['FT', 'AET', 'PEN', 'AOT'];
    const now = new Date();

    for (const event of data.events) {
      const status = event.strStatus?.toUpperCase();
      const isCompleted = COMPLETED_STATUSES.includes(status);

      // Determine if it's a home game for the tracked team (if in a supplemental file)
      // For league-wide files, we skip TBD enforcement for missing venues to allow fallback logic in lib/sports.js
      const isHomeGame = isSupplemental && (
        (trackedTeamId && event.idHomeTeam === trackedTeamId) ||
        (trackedTeamName && event.strHomeTeam?.toLowerCase().trim() === trackedTeamName)
      );

      for (const field of FIELDS_TO_CHECK) {
        let value = event[field];

        // 1. Special handling for strEvent to replace variants inline
        if (field === 'strEvent' && typeof value === 'string') {
          const originalValue = value;
          const TO_REPLACE = ['TBA', 'To Be Determined'];
          for (const variant of TO_REPLACE) {
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
        const isTbaVariant = typeof normalizedValue === 'string' && ['TBA', 'TBD', 'TO BE DETERMINED'].includes(normalizedValue.toUpperCase());

        if (isMissing || isTbaVariant) {
          // 2. Special handling for strVenue
          if (field === 'strVenue') {
            if (isCompleted) continue;

            const eventDate = new Date(event.strTimestamp || `${event.dateEvent}T${event.strTime || '00:00:00'}Z`);
            if (!isNaN(eventDate.getTime()) && eventDate < now) {
              if (value !== '' && value !== null) {
                event[field] = '';
                modified = true;
              }
              continue;
            }

            // Leave blank for home games (supplemental) or ANY game in league files to allow fallback to home stadium
            if (isHomeGame || !isSupplemental) {
              if (value !== '' && value !== null) {
                event[field] = '';
                modified = true;
              }
              continue;
            }
          }

          // 3. Default: ensure "TBD"
          if (value !== 'TBD') {
            event[field] = 'TBD';
            modified = true;
          }
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
