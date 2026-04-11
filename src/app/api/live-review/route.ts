import { Chess } from "chess.js";
import { getGameByIdForUser } from "@/lib/localDb";
import { getUserFromRequest } from "@/lib/supabase";
import { decodePgn } from "@/lib/pgnCodec";

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

  const sessionUser = await getUserFromRequest(request);
  if (!sessionUser) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = sessionUser.id;

  const data = await getGameByIdForUser(gameId, userId);
  if (!data) {
    return Response.json({ error: "Game not found." }, { status: 404 });
  }

  const chess = new Chess();
  const decodedPgn = decodePgn(data.pgn);
  try {
    chess.loadPgn(decodedPgn, { strict: false });
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
  const pgnText: string = decodedPgn;
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
  });
}
