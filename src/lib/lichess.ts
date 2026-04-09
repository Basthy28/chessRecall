/**
 * lichess.ts — Lichess API client
 *
 * Uses the native fetch API (Node 18+). No additional packages required.
 * Docs: https://lichess.org/api
 */

import type { Game, GameResult, LichessGame } from "@/types";

const LICHESS_BASE_URL = "https://lichess.org";

// ── Public API ────────────────────────────────────────────────────────

/**
 * Fetch up to `maxGames` recent games for a Lichess user.
 * The endpoint streams NDJSON (one JSON object per line).
 */
export async function fetchUserGames(
  username: string,
  maxGames: number = 50
): Promise<LichessGame[]> {
  const params = new URLSearchParams({
    max: String(maxGames),
    moves: "true",
    tags: "true",
    clocks: "false",
    evals: "false",
    opening: "false",
    pgnInJson: "true",
  });

  const url = `${LICHESS_BASE_URL}/api/games/user/${encodeURIComponent(username)}?${params}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000); // 45s max

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/x-ndjson" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    const err = new Error("Lichess user not found") as Error & { status: number };
    err.status = 404;
    throw err;
  }

  if (response.status === 429) {
    const err = new Error("Lichess rate limit hit, try again later") as Error & { status: number };
    err.status = 429;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`Lichess API error: ${response.status} ${response.statusText}`) as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const text = await response.text();

  // Parse NDJSON: one JSON object per line, skip blank lines
  const games: LichessGame[] = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LichessGame);

  return games;
}

/**
 * Map a LichessGame → our internal Game shape (minus id and created_at,
 * which are assigned by Supabase).
 */
export function convertLichessGameToDbGame(
  lichessGame: LichessGame,
  userId: string
): Omit<Game, "id" | "created_at"> {
  const result = deriveResult(lichessGame);
  const timeControl = deriveTimeControl(lichessGame);

  return {
    user_id: userId,
    lichess_game_id: lichessGame.id,
    // .user can be absent for deleted accounts or anonymous opponents
    pgn: lichessGame.pgn ?? "",
    white_username: lichessGame.players.white.user?.name ?? "anonymous",
    black_username: lichessGame.players.black.user?.name ?? "anonymous",
    white_rating: lichessGame.players.white.rating ?? null,
    black_rating: lichessGame.players.black.rating ?? null,
    result,
    played_at: new Date(lichessGame.createdAt).toISOString(),
    time_control: timeControl,
    status: "pending",
  };
}

// ── Private helpers ───────────────────────────────────────────────────

function deriveResult(game: LichessGame): GameResult {
  if (!game.winner) return "draw";
  return game.winner === "white" ? "win" : "loss";
}

function deriveTimeControl(game: LichessGame): string {
  if (game.clock) {
    return `${game.clock.initial}+${game.clock.increment}`;
  }
  // Fall back to speed/perf label when no clock data is present
  return game.speed ?? game.perf ?? "unknown";
}
