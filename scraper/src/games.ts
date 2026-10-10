// A game on CubeCraft; id is what game_id holds in every table.
export type Game = {
  id: number;
  name: string;
  displayName: string;
  scoreType: string;
  // On the network, so its player count is expected in the Games menu every run.
  active: boolean;
  // Its Statistics screen has a leaderboard to scrape.
  hasLeaderboard: boolean;
  // The name the Games menu shows, minus decorations; null for a game that is not on the network.
  menuName: string | null;
};

export async function loadGames(): Promise<Game[]> {
  const rows = await Bun.sql`
    SELECT id, name, display_name, score_type, active, has_leaderboard, menu_name
    FROM games
    ORDER BY id
  `;

  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    scoreType: r.score_type,
    active: r.active,
    hasLeaderboard: r.has_leaderboard,
    menuName: r.menu_name,
  }));
}

const normalize = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

// CubeCraft decorates names in the Games menu ("BedWars -UPDATE!").
const undecorated = (name: string) => name.replace(/\s+-.*$/, "");

export function gameMatcher(games: Game[]): (menuName: string) => Game | undefined {
  const byMenuName = new Map(games.flatMap((g) => (g.menuName ? [[normalize(g.menuName), g] as const] : [])));
  const find = (name: string) => byMenuName.get(normalize(name));

  return (menuName) => find(menuName) ?? find(undecorated(menuName));
}
