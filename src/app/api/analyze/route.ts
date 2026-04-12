import { listAnalyzableGames, updateGameStatusByIds } from "@/lib/localDb";
import { getUserFromRequest } from "@/lib/supabase";
import { enqueueGameAnalysis, isRedisQueueAvailable } from "@/lib/queue";
import type { AnalyzeGameJobData } from "@/types";

const ENQUEUE_TIMEOUT_MS = 8000;
const ENQUEUE_CONCURRENCY = 20;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type Platform = "lichess" | "chess.com" | "all";

function normalizeUsername(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function inferPlayerColor(
  white: string,
  black: string,
  viewerUsernames: string[]
): "white" | "black" {
  const normalizedWhite = white.toLowerCase();
  const normalizedBlack = black.toLowerCase();
  if (viewerUsernames.some((name) => name === normalizedWhite)) return "white";
  if (viewerUsernames.some((name) => name === normalizedBlack)) return "black";
  return "white";
}

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

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const username = normalizeUsername(raw.username);
  const viewerUsernames = Array.isArray(raw.viewerUsernames)
    ? raw.viewerUsernames.map((value) => normalizeUsername(value)).filter(Boolean)
    : [];
  if (username) viewerUsernames.push(username);
  const normalizedViewerUsernames = Array.from(new Set(viewerUsernames));
  const rawPlatform = typeof raw.platform === "string" ? raw.platform.toLowerCase() : "all";
  const platform: Platform =
    rawPlatform === "chess.com" || rawPlatform === "lichess" || rawPlatform === "all"
      ? (rawPlatform as Platform)
      : "all";
  const order: "newest" | "oldest" = raw.order === "oldest" ? "oldest" : "newest";
  const requestedLimit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit)
      ? Math.floor(raw.limit)
      : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT));
  const gameIds = Array.isArray(raw.gameIds)
    ? raw.gameIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];

  const sessionUser = await getUserFromRequest(request);
  if (!sessionUser) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = sessionUser.id;

  const queueAvailable = await isRedisQueueAvailable(5000);
  if (!queueAvailable) {
    return Response.json({
      selected: 0,
      queued: 0,
      queueUnavailable: true,
      platform,
      limit,
    });
  }

  const rows = await listAnalyzableGames({
    userId,
    platform,
    limit,
    username,
    gameIds,
    order,
  });
  if (rows.length === 0) {
    return Response.json({
      selected: 0,
      queued: 0,
      queueUnavailable: false,
      platform,
      limit,
    });
  }

  const queuedIds: string[] = [];
  let failures = 0;

  for (let i = 0; i < rows.length; i += ENQUEUE_CONCURRENCY) {
    const batch = rows.slice(i, i + ENQUEUE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const playerColor: "white" | "black" =
          inferPlayerColor(row.white_username, row.black_username, normalizedViewerUsernames);

        const jobData: AnalyzeGameJobData = {
          gameId: row.id,
          userId: row.user_id,
          pgn: row.pgn,
          playerColor,
        };

        await enqueueWithTimeout(jobData);
        queuedIds.push(row.id);
      })
    );

    for (const result of results) {
      if (result.status === "rejected") failures++;
    }
  }

  if (queuedIds.length > 0) {
    await updateGameStatusByIds(queuedIds, "processing");
  }

  if (failures > 0) {
    console.error(`[analyze] enqueue failures: ${failures}`);
  }

  return Response.json({
    selected: rows.length,
    queued: queuedIds.length,
    queueMode: gameIds.length > 0 ? "selection" : "backlog",
    queueUnavailable: false,
    platform,
    limit,
    order,
  });
}
