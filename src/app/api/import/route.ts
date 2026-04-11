/**
 * /api/import — Game import endpoint
 *
 * POST { username: string, platform: "lichess" | "chess.com" }
 *   → fetches games, upserts to local storage, enqueues for analysis.
 *   → returns { imported: number, queued: number, username: string, platform: string }
 *
 * GET → returns { games: number, puzzles: number } counts for the placeholder userId.
 */

import {
  countChessComGamesForUserAndName,
  countGamesByUser,
  countPuzzlesByUser,
  getImportCooldownRemainingMs,
  latestPlayedAtForChessComUser,
  markImportSyncedNow,
  updateGameStatusByIds,
  upsertGames,
} from "@/lib/localDb";
import { getUserFromRequest } from "@/lib/supabase";
import { fetchUserGames, convertLichessGameToDbGame } from "@/lib/lichess";
import { fetchChessComGames, convertChessComGameToDbGame } from "@/lib/chessdotcom";
import { enqueueGameAnalysis, isRedisQueueAvailable } from "@/lib/queue";
import { encodePgn } from "@/lib/pgnCodec";
import type { AnalyzeGameJobData, Game } from "@/types";

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{1,25}$/;

type Platform = "lichess" | "chess.com";

const CHESSCOM_INITIAL_SYNC_CAP = 1000;
const CHESSCOM_MIN_GAMES_FOR_INCREMENTAL = 20;
const ENQUEUE_CONCURRENCY = 20;
const ENQUEUE_TIMEOUT_MS = 2500;
const DEFAULT_ANALYZE_QUEUE_LIMIT = 120;
const MAX_ANALYZE_QUEUE_LIMIT = 2000;
const IMPORT_COOLDOWN_MS = 5 * 60 * 1000;

async function enqueueWithTimeout(jobData: AnalyzeGameJobData): Promise<void> {
  await Promise.race([
    enqueueGameAnalysis(jobData),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Queue enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms`));
      }, ENQUEUE_TIMEOUT_MS);
    }),
  ]);
}

// ── POST /api/import ─────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;

  if (typeof raw.username !== "string") {
    return Response.json({ error: "Missing required field: username" }, { status: 400 });
  }

  const username = raw.username.trim();
  const platform: Platform =
    raw.platform === "chess.com" ? "chess.com" : "lichess";
  const fullSync = raw.fullSync === true;
  const requestedAnalyzeLimit =
    typeof raw.analyzeLimit === "number" && Number.isFinite(raw.analyzeLimit)
      ? Math.floor(raw.analyzeLimit)
      : DEFAULT_ANALYZE_QUEUE_LIMIT;
  const analyzeLimit = Math.max(
    0,
    Math.min(requestedAnalyzeLimit, MAX_ANALYZE_QUEUE_LIMIT)
  );

  if (!USERNAME_REGEX.test(username)) {
    return Response.json(
      { error: "Invalid username format." },
      { status: 400 }
    );
  }

  const sessionUser = await getUserFromRequest(request);
  if (!sessionUser) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = sessionUser.id;

  const cooldownRemainingMs = await getImportCooldownRemainingMs(
    userId,
    platform,
    username,
    IMPORT_COOLDOWN_MS
  );
  if (cooldownRemainingMs > 0) {
    return Response.json(
      {
        error: `Sync cooldown active. Try again in ${Math.ceil(cooldownRemainingMs / 1000)}s.`,
        cooldownRemainingMs,
      },
      { status: 429 }
    );
  }

  // ── Fetch games from the chosen platform ───────────────────────────
  let gameRows: Omit<Game, "id" | "created_at">[] = [];

  try {
    if (platform === "lichess") {
      const games = await fetchUserGames(username, 50);
      gameRows = games.map((g) => convertLichessGameToDbGame(g, userId));
    } else {
      // Default behavior is incremental sync to avoid long-pending HTTP requests.
      // `fullSync: true` can be used for explicit full-history pulls.
      let sinceUnix: number | undefined;
      let maxGames: number | undefined;

      if (!fullSync) {
        const normalizedUsername = username.toLowerCase();
        const existingCount = await countChessComGamesForUserAndName(userId, normalizedUsername);
        const latestPlayedAt = await latestPlayedAtForChessComUser(userId, normalizedUsername);
        const candidateSinceUnix = latestPlayedAt
          ? Math.floor(new Date(latestPlayedAt).getTime() / 1000)
          : undefined;

        // Only use incremental mode when we already have a meaningful local base
        // for this specific Chess.com username.
        if (existingCount >= CHESSCOM_MIN_GAMES_FOR_INCREMENTAL && candidateSinceUnix) {
          sinceUnix = candidateSinceUnix;
        } else {
          maxGames = CHESSCOM_INITIAL_SYNC_CAP;
        }
      }

      const games = await fetchChessComGames(username, { sinceUnix, maxGames });
      gameRows = games.map((g) =>
        convertChessComGameToDbGame(g, userId, username)
      );
    }
  } catch (err) {
    const apiErr = err as Error & { status?: number };
    if (apiErr.status === 404) {
      return Response.json(
        { error: `${platform} user "${username}" not found.` },
        { status: 404 }
      );
    }
    if (apiErr.status === 429) {
      return Response.json(
        { error: `${platform} rate limit hit. Try again in a minute.` },
        { status: 429 }
      );
    }
    console.error(`[import] ${platform} fetch error:`, apiErr);
    return Response.json(
      { error: `Failed to fetch games from ${platform}.` },
      { status: 500 }
    );
  }

  if (gameRows.length === 0) {
    await markImportSyncedNow(userId, platform, username);
    return Response.json({ imported: 0, queued: 0, username, platform, fullSync });
  }

  // Compress PGN before storing — strips headers (already in columns) + gzip.
  // Legacy rows without the "gz2:" prefix are decoded transparently at read time.
  gameRows = gameRows.map((g) => ({ ...g, pgn: encodePgn(g.pgn) }));

  let imported = 0;
  let queued = 0;

  // ── Bulk upsert for speed ─────────────────────────────────────────
  const upserted = await upsertGames(gameRows);
  imported = upserted.length;

  // Analyze recent games first to keep local runs manageable.
  const enqueueCandidates = [...upserted]
    .sort((a, b) => b.played_at.localeCompare(a.played_at))
    .slice(0, analyzeLimit);
  const skippedQueue = Math.max(0, imported - enqueueCandidates.length);

  // ── Enqueue analysis jobs in bounded concurrent batches ───────────
  const queueAvailable = await isRedisQueueAvailable();
  if (queueAvailable) {
    let enqueueFailures = 0;
    const queuedIds: string[] = [];

    for (let i = 0; i < enqueueCandidates.length; i += ENQUEUE_CONCURRENCY) {
      const batch = enqueueCandidates.slice(i, i + ENQUEUE_CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map(async (row) => {
          const playerColor: "white" | "black" =
            row.white_username.toLowerCase() === username.toLowerCase()
              ? "white"
              : "black";

          const jobData: AnalyzeGameJobData = {
            gameId: row.id,
            userId,
            pgn: row.pgn,
            playerColor,
          };

          await enqueueWithTimeout(jobData);
          return row.id;
        })
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          queued++;
          queuedIds.push(result.value);
        } else {
          enqueueFailures++;
        }
      }
    }

    if (enqueueFailures > 0) {
      console.error(`[import] BullMQ enqueue failures: ${enqueueFailures}`);
    }

    if (queuedIds.length > 0) {
      await updateGameStatusByIds(queuedIds, "processing");
    }
  }

  const queueUnavailable = queued < imported;
  await markImportSyncedNow(userId, platform, username);
  return Response.json({
    imported,
    queued,
    skippedQueue,
    analyzeLimit,
    username,
    platform,
    fullSync,
    queueUnavailable,
  });
}

// ── GET /api/import ──────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  try {
    const sessionUser = await getUserFromRequest(request);
    if (!sessionUser) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = sessionUser.id;

    return Response.json({
      games: await countGamesByUser(userId),
      puzzles: await countPuzzlesByUser(userId),
    });
  } catch (err) {
    console.error("[import] GET error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
