import { createServerClient } from "@/lib/supabase";
import { enqueueGameAnalysis, isRedisQueueAvailable } from "@/lib/queue";
import type { AnalyzeGameJobData } from "@/types";

const PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000001";

const ENQUEUE_TIMEOUT_MS = 8000;
const ENQUEUE_CONCURRENCY = 20;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type Platform = "lichess" | "chess.com";

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
  const platform: Platform = raw.platform === "chess.com" ? "chess.com" : "lichess";
  const requestedLimit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit)
      ? Math.floor(raw.limit)
      : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT));
  const gameIds = Array.isArray(raw.gameIds)
    ? raw.gameIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const hasExplicitSelection = gameIds.length > 0;

  let supabase: ReturnType<typeof createServerClient>;
  try {
    supabase = createServerClient();
  } catch {
    return Response.json({ error: "Database not configured." }, { status: 503 });
  }

  // Resolve userId: use authenticated session user, fall back to placeholder for guests.
  const { data: { user: sessionUser } } = await supabase.auth.getUser();
  const userId = sessionUser?.id ?? PLACEHOLDER_USER_ID;

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

  let query = supabase
    .from("games")
    .select("id, user_id, pgn, white_username, black_username, status, played_at, lichess_game_id")
    .eq("user_id", userId)
    .order("played_at", { ascending: false })
    .limit(limit);

  if (gameIds.length > 0) {
    // Explicit selection: allow re-queuing any status (including stuck "processing" jobs)
    query = query.in("id", gameIds);
  } else {
    query = query.in("status", ["pending", "failed"]);
  }

  // When game IDs are explicitly selected from UI, enqueue exactly those rows.
  // Platform/username filtering only applies to backlog mode.
  if (!hasExplicitSelection) {
    if (platform === "chess.com") {
      query = query.like("lichess_game_id", "cc_%");
    } else {
      query = query.not("lichess_game_id", "like", "cc_%");
    }

    if (username) {
      query = query.or(`white_username.ilike.${username},black_username.ilike.${username}`);
    }
  }

  const { data, error } = await query;
  if (error) {
    console.error("[analyze] failed to fetch backlog:", error);
    return Response.json({ error: "Failed to fetch analyzable games." }, { status: 500 });
  }

  const rows = data ?? [];
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
    const { error: updateError } = await supabase
      .from("games")
      .update({ status: "processing" })
      .in("id", queuedIds);
    if (updateError) {
      console.error("[analyze] failed to set processing status:", updateError);
    }
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
  });
}
