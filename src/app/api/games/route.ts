import { createServerClient, getUserFromRequest } from "@/lib/supabase";

const PAGE_SIZE = 100;

type Platform = "lichess" | "chess.com" | "all";

export async function GET(request: Request): Promise<Response> {
  let supabase: ReturnType<typeof createServerClient>;
  try {
    supabase = createServerClient();
  } catch {
    return Response.json({ error: "Database not configured." }, { status: 503 });
  }

  const sessionUser = await getUserFromRequest(request);
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

  const cols = "id, lichess_game_id, white_username, black_username, white_rating, black_rating, played_at, time_control, result, status";

  let query = supabase
    .from("games")
    .select(cols)
    .eq("user_id", userId)
    .order("played_at", { ascending: false })
    .order("id", { ascending: false })          // stable tiebreaker
    .limit(PAGE_SIZE);

  if (cursorPlayedAt) {
    // Fetch rows strictly older than the cursor timestamp.
    query = query.lt("played_at", cursorPlayedAt);
  }

  if (platform === "chess.com") {
    query = query.like("lichess_game_id", "cc_%");
  } else if (platform === "lichess") {
    query = query.not("lichess_game_id", "like", "cc_%");
  }

  // Run page query + total count in parallel.
  const [{ data, error }, { count: totalCount }] = await Promise.all([
    query,
    supabase
      .from("games")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId),
  ]);

  if (error) {
    console.error("[games] fetch error:", error);
    return Response.json({ error: "Failed to load games." }, { status: 500 });
  }

  const games = data ?? [];
  const nextCursor = games.length === PAGE_SIZE
    ? games[games.length - 1].played_at
    : null;

  const stats = {
    total: totalCount ?? 0,
    pending: games.filter((g) => g.status === "pending").length,
    processing: games.filter((g) => g.status === "processing").length,
    analyzed: games.filter((g) => g.status === "analyzed").length,
    failed: games.filter((g) => g.status === "failed").length,
  };

  return Response.json({ games, stats, platform, nextCursor });
}
