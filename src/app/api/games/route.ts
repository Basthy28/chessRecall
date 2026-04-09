import { createServerClient } from "@/lib/supabase";

const PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000001";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type Platform = "lichess" | "chess.com" | "all";

export async function GET(request: Request): Promise<Response> {
  let supabase: ReturnType<typeof createServerClient>;
  try {
    supabase = createServerClient();
  } catch {
    return Response.json({ error: "Database not configured." }, { status: 503 });
  }

  // Resolve userId: use authenticated session user, fall back to placeholder for guests.
  const { data: { user: sessionUser } } = await supabase.auth.getUser();
  const userId = sessionUser?.id ?? PLACEHOLDER_USER_ID;

  const url = new URL(request.url);
  const username = (url.searchParams.get("username") ?? "").trim().toLowerCase();
  const platformParam = (url.searchParams.get("platform") ?? "all").toLowerCase();
  const platform: Platform =
    platformParam === "chess.com" || platformParam === "lichess" || platformParam === "all"
      ? (platformParam as Platform)
      : "all";

  const requestedLimit = Number(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT));
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.floor(requestedLimit), MAX_LIMIT))
    : DEFAULT_LIMIT;

  let query = supabase
    .from("games")
    .select(
      "id, lichess_game_id, white_username, black_username, white_rating, black_rating, played_at, time_control, result, status"
    )
    .eq("user_id", userId)
    .order("played_at", { ascending: false })
    .limit(limit);

  if (platform === "chess.com") {
    query = query.like("lichess_game_id", "cc_%");
  } else if (platform === "lichess") {
    query = query.not("lichess_game_id", "like", "cc_%");
  }

  if (username) {
    query = query.or(`white_username.ilike.${username},black_username.ilike.${username}`);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[games] fetch error:", error);
    return Response.json({ error: "Failed to load games." }, { status: 500 });
  }

  const games = data ?? [];

  const stats = {
    total: games.length,
    pending: games.filter((g) => g.status === "pending").length,
    processing: games.filter((g) => g.status === "processing").length,
    analyzed: games.filter((g) => g.status === "analyzed").length,
    failed: games.filter((g) => g.status === "failed").length,
  };

  return Response.json({ games, stats, platform, username, limit });
}
