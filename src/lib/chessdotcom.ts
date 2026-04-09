/**
 * Chess.com API client
 *
 * Docs: https://www.chess.com/news/view/published-data-api
 * All endpoints are public — no auth required.
 */

import type { Game } from "@/types";

// ── Chess.com API shape (subset we use) ─────────────────────────────

interface ChessComGame {
  url: string;
  pgn?: string;
  time_control?: string;
  end_time: number; // Unix seconds
  rated?: boolean;
  white?: { username?: string; rating?: number; result?: string };
  black?: { username?: string; rating?: number; result?: string };
}

interface ChessComArchiveResponse {
  games: ChessComGame[];
}

interface ChessComArchivesResponse {
  archives: string[]; // URLs like https://api.chess.com/.../2024/03
}

// ── Helpers ──────────────────────────────────────────────────────────

function mapResult(
  game: ChessComGame,
  username: string
): "win" | "loss" | "draw" {
  const whiteName = game.white?.username ?? "";
  const blackName = game.black?.username ?? "";
  const isWhite = whiteName.toLowerCase() === username.toLowerCase();
  const myResult = isWhite ? game.white?.result : game.black?.result;

  if (!myResult) return "draw";

  if (myResult === "win") return "win";
  if (["checkmated", "timeout", "resigned", "lose", "abandoned"].includes(myResult))
    return "loss";
  return "draw";
}

function isImportableGame(game: ChessComGame): boolean {
  return Boolean(
    game.url &&
      typeof game.end_time === "number" &&
      game.pgn &&
      game.white?.username &&
      game.black?.username
  );
}

function extractChessComId(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (last && /^\d+$/.test(last)) {
    return last;
  }
  return encodeURIComponent(trimmed);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Fetch Chess.com games by walking monthly archives from newest to oldest.
 *
 * Defaults to full-history import (all available games), while supporting
 * optional limits and incremental syncs via `sinceUnix`.
 */
export async function fetchChessComGames(
  username: string,
  options?: {
    maxGames?: number;
    sinceUnix?: number;
  }
): Promise<ChessComGame[]> {
  const maxGames = options?.maxGames;
  const sinceUnix = options?.sinceUnix;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000); // allow full-history imports

  try {
    // 1. Get list of archive URLs (oldest → newest)
    const archivesRes = await fetch(
      `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`,
      { headers: { "User-Agent": "ChessRecall/1.0" }, signal: controller.signal }
    );

    if (archivesRes.status === 404) {
      const err = new Error("Chess.com user not found") as Error & { status: number };
      err.status = 404;
      throw err;
    }
    if (archivesRes.status === 429) {
      const err = new Error("Chess.com rate limit") as Error & { status: number };
      err.status = 429;
      throw err;
    }
    if (!archivesRes.ok) {
      throw new Error(`Chess.com archives request failed: ${archivesRes.status}`);
    }

    const { archives } = (await archivesRes.json()) as ChessComArchivesResponse;

    if (!archives || archives.length === 0) return [];

    // 2. Fetch months from newest backwards in small batches.
    // Collect all importable games; keep rated/unrated distinction for future use,
    // but do not exclude unrated by default.
    const newestFirst = [...archives].reverse();
    const ratedCollected: ChessComGame[] = [];
    const unratedCollected: ChessComGame[] = [];
    const BATCH_SIZE = 6;

    for (let i = 0; i < newestFirst.length; i += BATCH_SIZE) {
      const batch = newestFirst.slice(i, i + BATCH_SIZE);
      const monthResponses = await Promise.all(
        batch.map((archiveUrl) =>
          fetch(archiveUrl, {
            headers: { "User-Agent": "ChessRecall/1.0" },
            signal: controller.signal,
          }).catch(() => null)
        )
      );

      for (const monthRes of monthResponses) {
        if (!monthRes || !monthRes.ok) continue;

        const { games } = (await monthRes.json()) as ChessComArchiveResponse;
        const clean = (games ?? []).filter(isImportableGame);

        // Newest-first within each monthly archive.
        const ordered = clean
          .filter((g) => (sinceUnix ? g.end_time > sinceUnix : true))
          .sort((a, b) => b.end_time - a.end_time);

        ratedCollected.push(...ordered.filter((g) => g.rated));
        unratedCollected.push(...ordered.filter((g) => !g.rated));
      }

      const totalCollected = ratedCollected.length + unratedCollected.length;
      if (typeof maxGames === "number" && totalCollected >= maxGames) {
        break;
      }
    }

    const merged = [...ratedCollected, ...unratedCollected].sort(
      (a, b) => b.end_time - a.end_time
    );

    if (typeof maxGames === "number") {
      return merged.slice(0, maxGames);
    }

    return merged;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convert a Chess.com game to our DB Game shape.
 */
export function convertChessComGameToDbGame(
  game: ChessComGame,
  userId: string,
  username: string
): Omit<Game, "id" | "created_at"> {
  // Extract game ID from URL: https://www.chess.com/game/live/12345678
  const chessComId = extractChessComId(game.url);

  return {
    user_id: userId,
    lichess_game_id: `cc_${chessComId}`, // prefix to namespace from Lichess IDs
    pgn: game.pgn ?? "",
    white_username: game.white?.username ?? "unknown",
    black_username: game.black?.username ?? "unknown",
    white_rating: game.white?.rating ?? null,
    black_rating: game.black?.rating ?? null,
    result: mapResult(game, username),
    played_at: new Date(game.end_time * 1000).toISOString(),
    time_control: game.time_control ?? "unknown",
    status: "pending",
  };
}
