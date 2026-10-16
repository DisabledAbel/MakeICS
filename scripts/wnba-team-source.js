// The 2026 WNBA has 15 franchises. Keep IDs already published by MakeICS
// stable; new teams use a separate numeric ESPN-based namespace.
export const WNBA_FRANCHISE_IDS = new Map([
  ['Atlanta Dream', '136447'],
  ['Chicago Sky', '136440'],
  ['Connecticut Sun', '136445'],
  ['Dallas Wings', '136441'],
  ['Golden State Valkyries', '150722'],
  ['Indiana Fever', '136439'],
  ['Las Vegas Aces', '136437'],
  ['Los Angeles Sparks', '136443'],
  ['Minnesota Lynx', '136442'],
  ['New York Liberty', '136438'],
  ['Phoenix Mercury', null],
  ['Portland Fire', '152565'],
  ['Seattle Storm', null],
  ['Toronto Tempo', null],
  ['Washington Mystics', null]
]);

export function teamsFromWNBASchedule(games) {
  const scheduleIds = new Map();

  for (const game of games) {
    for (const [name, rawId] of [[game.homeTeam, game.homeId], [game.awayTeam, game.awayId]]) {
      if (!WNBA_FRANCHISE_IDS.has(name)) continue;
      const id = String(rawId ?? '').trim();
      if (!/^\d+$/.test(id)) throw new Error(`Missing ESPN team ID for ${name}`);
      if (scheduleIds.has(name) && scheduleIds.get(name) !== id) {
        throw new Error(`Conflicting ESPN team IDs for ${name}`);
      }
      scheduleIds.set(name, id);
    }
  }

  const missing = [...WNBA_FRANCHISE_IDS.keys()].filter(name => !scheduleIds.has(name));
  if (missing.length) {
    throw new Error(`Incomplete WNBA schedule team list (${scheduleIds.size}/15); missing: ${missing.join(', ')}`);
  }

  const teams = [...WNBA_FRANCHISE_IDS].map(([strTeam, publishedId]) => ({
    strTeam,
    idTeam: publishedId ?? `9${scheduleIds.get(strTeam).padStart(8, '0')}`
  }));
  if (new Set(teams.map(team => team.idTeam)).size !== teams.length) {
    throw new Error('Duplicate WNBA team IDs');
  }
  return teams;
}
