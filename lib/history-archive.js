import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const archivePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/archive/events.json');

/** Load immutable raw records archived by the fetch quality gate. */
export async function loadArchivedEvents(kind, predicate = () => true, fsImpl = fs) {
  try {
    const data = JSON.parse(await fsImpl.readFile(archivePath, 'utf8'));
    return data.events.filter(entry => entry.kind === kind && predicate(entry.record, entry)).map(entry => ({ ...entry.record, __archived: true }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Unable to load calendar history archive: ${error.message}`);
  }
}
