import { Chess } from "chess.js";
import { createServerClient } from "@/lib/supabase";

const PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000001";


function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  const gameId = typeof raw.gameId === "string" ? raw.gameId : "";
  const viewerUsernames = Array.isArray(raw.viewerUsernames)
    ? raw.viewerUsernames.map((name) => normalizeName(name)).filter(Boolean)
    : [];
  if (!gameId) {
    return Response.json({ error: "Missing gameId" }, { status: 400 });
  }

  let supabase: ReturnType<typeof createServerClient>;
  try {
    supabase = createServerClient();
  } catch {
    return Response.json({ error: "Database not configured." }, { status: 503 });
  }

  // Resolve userId: use authenticated session user, fall back to placeholder for guests.
  const { data: { user: sessionUser } } = await supabase.auth.getUser();
  const userId = sessionUser?.id ?? PLACEHOLDER_USER_ID;

  const [{ data, error }, { data: annotations }] = await Promise.all([
    supabase
      .from("games")
      .select("id, pgn, white_username, black_username, white_rating, black_rating, time_control, played_at, result, status")
      .eq("id", gameId)
      .eq("user_id", userId)
      .single(),
    supabase
      .from("move_annotations")
      .select("ply, move_uci, classification, win_before, win_after, is_miss, opening_name, opening_eco")
      .eq("game_id", gameId)
      .order("ply", { ascending: true }),
  ]);

  if (error || !data) {
    return Response.json({ error: "Game not found." }, { status: 404 });
  }

  const chess = new Chess();
  try {
    chess.loadPgn(data.pgn, { strict: false });
  } catch {
    return Response.json({ error: "Could not parse PGN for this game." }, { status: 422 });
  }

  // Parse %clk annotations from PGN comments.
  // chess.js exposes comments per move via history({ verbose: true }) — they live in
  // the raw PGN as { [FEN]: "comment" }. We extract them directly from the PGN text.
  const clkRegex = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/g;
  const clkTimes: number[] = []; // seconds remaining after each ply
  let m: RegExpExecArray | null;
  // chess.js doesn't expose comments in verbose history, so parse raw PGN
  const pgnText: string = data.pgn ?? "";
  clkRegex.lastIndex = 0;
  while ((m = clkRegex.exec(pgnText)) !== null) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const sec = parseFloat(m[3]);
    clkTimes.push(h * 3600 + min * 60 + sec);
  }

  // Also try Lichess-style { [%clk h:mm:ss] } in move comments embedded in history
  // (already covered by the regex above since we scan the full PGN text)

  const verboseMoves = chess.history({ verbose: true });
  const replay = new Chess();
  const positions: string[] = [replay.fen()];
  const moves: Array<{ ply: number; san: string; from: string; to: string; timeSpentMs: number | null }> = [];

  for (let i = 0; i < verboseMoves.length; i++) {
    const mv = verboseMoves[i];
    replay.move(mv.san);
    positions.push(replay.fen());

    // Time spent = clock before move − clock after move.
    // clkTimes[i] is remaining time right after move i (0-indexed).
    // Clock before first move of each color = initial clock (we don't know it here,
    // so we can only compute diff between consecutive same-color moves).
    // Simplest: diff between previous clock for same color and current clock.
    let timeSpentMs: number | null = null;
    if (clkTimes.length > 0) {
      const clkAfter = clkTimes[i] ?? null;
      // Previous clock for the same color is clkTimes[i - 2] (two plies back)
      const clkBefore = i >= 2 ? (clkTimes[i - 2] ?? null) : null;
      if (clkAfter !== null && clkBefore !== null) {
        timeSpentMs = Math.round((clkBefore - clkAfter) * 1000);
      }
    }

    moves.push({
      ply: i + 1,
      san: mv.san,
      from: mv.from,
      to: mv.to,
      timeSpentMs,
    });
  }

  const whiteName = data.white_username.toLowerCase();
  const blackName = data.black_username.toLowerCase();
  const playerColor = viewerUsernames.some((name) => name === whiteName)
    ? "white"
    : viewerUsernames.some((name) => name === blackName)
      ? "black"
      : null;

  return Response.json({
    game: {
      id: data.id,
      white: data.white_username,
      black: data.black_username,
      whiteRating: data.white_rating,
      blackRating: data.black_rating,
      timeControl: data.time_control,
      playedAt: data.played_at,
      result: data.result,
      status: data.status,
      playerColor,
    },
    positions,
    moves,
    annotations: annotations ?? [],
  });
}
