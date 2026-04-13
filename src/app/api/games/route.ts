import { countGamesByUserForPlatform, countGamesByStatusForPlatform, listGamesPage } from "@/lib/localDb";
import { getUserFromRequest } from "@/lib/supabase";

const PAGE_SIZE = 100;

type Platform = "lichess" | "chess.com" | "all";

export async function GET(request: Request): Promise<Response> {
  let sessionUser;
  try {
    sessionUser = await getUserFromRequest(request);
  } catch {
    return Response.json({ error: "Auth service unavailable" }, { status: 500 });
  }
  if (!sessionUser) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = sessionUser.id;

  const url = new URL(request.url);
  const platformParam = (url.searchParams.get("platform") ?? "all").toLowerCase();
  const platform: Platform =
    platformParam === "chess.com" || platformParam === "lichess" || platformParam === "all"
      ? (platformParam as Platform)
      : "all";

  // Cursor: ISO timestamp of the oldest game on the previous page.
  // First page: no cursor. Subsequent pages: cursor = played_at of last item.
  const cursorPlayedAt = url.searchParams.get("cursor") ?? null;
  const searchQuery = (url.searchParams.get("q") ?? "").trim();

  const games = (await listGamesPage({
    userId,
    platform,
    cursorPlayedAt,
    limit: PAGE_SIZE,
    searchQuery,
  })).map((g) => ({
    id: g.id,
    lichess_game_id: g.lichess_game_id,
    white_username: g.white_username,
    black_username: g.black_username,
    white_rating: g.white_rating,
    black_rating: g.black_rating,
    played_at: g.played_at,
    time_control: g.time_control,
    result: g.result,
    status: g.status,
  }));

  const [totalCount, statusCounts] = await Promise.all([
    countGamesByUserForPlatform(userId, platform, searchQuery),
    countGamesByStatusForPlatform(userId, platform, searchQuery),
  ]);
  const nextCursor = games.length === PAGE_SIZE
    ? `${games[games.length - 1].played_at}|${games[games.length - 1].id}`
    : null;

  const stats = {
    total: totalCount ?? 0,
    pending: statusCounts.pending,
    processing: statusCounts.processing,
    analyzed: statusCounts.analyzed,
    failed: statusCounts.failed,
  };

  return Response.json({ games, stats, platform, nextCursor, q: searchQuery });
}
