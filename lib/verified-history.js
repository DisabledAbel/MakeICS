import fs from 'node:fs/promises';

export const VERIFIED_FILE = 'lib/data/tv/google-verified.json';
export const VERIFIED_ARCHIVE_FILE = 'lib/data/archive/google-verified.json';

/** Merge permanent TV date/name verifications with current corrections taking precedence. */
export async function loadVerifiedOverrides(fsImpl = fs) {
  async function read(relativePath) {
    try {
      return JSON.parse(await fsImpl.readFile(new URL(relativePath, import.meta.url), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }
  const archived = await read('./data/archive/google-verified.json');
  const active = await read('./data/tv/google-verified.json');
  return { ...archived, ...active };
}
