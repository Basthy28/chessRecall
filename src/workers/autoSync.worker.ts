/**
 * autoSync.worker.ts
 *
 * Background auto-sync loop — runs inside the same process as analyzeGame.worker.ts.
 *
 * Every hour, queries Supabase for all users with linked chess accounts and imports
 * any new games since the last sync, then queues them for analysis.
 *
 * Uses the same import_sync_cooldowns table as the manual import route, so a recent
 * manual import counts against the auto-sync cooldown (no double-fetching).
 */

import { createClient } from "@supabase/supabase-js";
import { fetchUserGames, convertLichessGameToDbGame } from "@/lib/lichess";
import { fetchChessComGames, convertChessComGameToDbGame } from "@/lib/chessdotcom";
import { encodePgn } from "@/lib/pgnCodec";
import {
  upsertGames,
  getImportCooldownRemainingMs,
  markImportSyncedNow,
  updateGameStatusByIds,
  countChessComGamesForUserAndName,
  latestPlayedAtForChessComUser,
} from "@/lib/localDb";
import { enqueueGameAnalysis, isRedisQueueAvailable } from "@/lib/queue";
import type { AnalyzeGameJobData, Game } from "@/types";

const AUTO_SYNC_COOLDOWN_MS = 12 * 60 * 60 * 1000;  // 12 hours between syncs per user/platform
const AUTO_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;  // poll loop cadence
const STARTUP_DELAY_MS      = 2 * 60 * 1000;        // wait before first run (let analysis worker warm up)
const CHESSCOM_INITIAL_CAP  = 500;
const CHESSCOM_MIN_FOR_INCR = 20;

type SyncPlatform = "lichess" | "chess.com";

interface LinkedUser {
  id: string;
  lichess_username: string | null;
  chess_com_username: string | null;
}

function makeSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("[autoSync] Missing Supabase env vars");
  return createClient(url, key);
}

async function fetchLinkedUsers(): Promise<LinkedUser[]> {
  const supabase = makeSupabaseAdmin();
  // admin.listUsers() returns all auth users; we join with public.users for linked accounts.
  // Fetch all rows — filter in JS because Supabase OR with IS NOT NULL
  // is verbose and version-dependent. User count is small.
  const { data, error } = await (supabase
    .from("users")
    .select("id, lichess_username, chess_com_username") as unknown as Promise<{
      data: LinkedUser[] | null;
      error: { message: string } | null;
    }>);

  if (error) throw new Error(`[autoSync] Supabase query failed: ${error.message}`);
  return (data ?? []).filter(
    (u) => u.lichess_username || u.chess_com_username
  );
}

async function importForUser(
  userId: string,
  username: string,
  platform: SyncPlatform,
): Promise<{ imported: number; queued: number }> {
  let gameRows: Omit<Game, "id" | "created_at">[] = [];

  if (platform === "lichess") {
    const games = await fetchUserGames(username, 50);
    gameRows = games.map((g) => convertLichessGameToDbGame(g, userId));
  } else {
    const normalizedUsername = username.toLowerCase();
    const existingCount = await countChessComGamesForUserAndName(userId, normalizedUsername);
    const latestPlayedAt = await latestPlayedAtForChessComUser(userId, normalizedUsername);
    const sinceUnix =
      existingCount >= CHESSCOM_MIN_FOR_INCR && latestPlayedAt
        ? Math.floor(new Date(latestPlayedAt).getTime() / 1000)
        : undefined;
    const maxGames = sinceUnix ? undefined : CHESSCOM_INITIAL_CAP;
    const games = await fetchChessComGames(username, { sinceUnix, maxGames });
    gameRows = games.map((g) => convertChessComGameToDbGame(g, userId, username));
  }

  await markImportSyncedNow(userId, platform, username);

  if (gameRows.length === 0) return { imported: 0, queued: 0 };

  gameRows = gameRows.map((g) => ({ ...g, pgn: encodePgn(g.pgn) }));
  const upserted = await upsertGames(gameRows);

  const queueAvailable = await isRedisQueueAvailable();
  if (!queueAvailable) return { imported: upserted.length, queued: 0 };

  // Only queue games that are still pending — upsertGames preserves analyzed/processing status,
  // so this correctly skips games the worker already handled.
  const candidates = upserted
    .filter((g) => g.status === "pending")
    .sort((a, b) => b.played_at.localeCompare(a.played_at));

  const queuedIds: string[] = [];
  await Promise.allSettled(
    candidates.map(async (row) => {
      const playerColor: "white" | "black" =
        row.white_username.toLowerCase() === username.toLowerCase() ? "white" : "black";
      const jobData: AnalyzeGameJobData = { gameId: row.id, userId, pgn: row.pgn, playerColor };
      try {
        await enqueueGameAnalysis(jobData);
        queuedIds.push(row.id);
      } catch { /* individual enqueue failures are non-fatal */ }
    })
  );

  if (queuedIds.length > 0) {
    await updateGameStatusByIds(queuedIds, "processing");
  }

  return { imported: upserted.length, queued: queuedIds.length };
}

async function syncAllUsers(): Promise<void> {
  console.log("[autoSync] Starting sync cycle…");
  let users: LinkedUser[];
  try {
    users = await fetchLinkedUsers();
  } catch (err) {
    console.error("[autoSync] Failed to fetch users:", err instanceof Error ? err.message : err);
    return;
  }

  console.log(`[autoSync] Found ${users.length} user(s) with linked accounts`);

  for (const user of users) {
    const platforms: Array<{ platform: SyncPlatform; username: string }> = [];
    if (user.lichess_username) platforms.push({ platform: "lichess", username: user.lichess_username });
    if (user.chess_com_username) platforms.push({ platform: "chess.com", username: user.chess_com_username });

    for (const { platform, username } of platforms) {
      try {
        const remaining = await getImportCooldownRemainingMs(
          user.id, platform, username, AUTO_SYNC_COOLDOWN_MS
        );
        if (remaining > 0) {
          console.log(`[autoSync] Skipping ${username} (${platform}) — cooldown ${Math.ceil(remaining / 60000)}min remaining`);
          continue;
        }

        console.log(`[autoSync] Syncing ${username} (${platform})…`);
        const result = await importForUser(user.id, username, platform);
        console.log(`[autoSync] ${username} (${platform}): imported=${result.imported} queued=${result.queued}`);
      } catch (err) {
        console.error(`[autoSync] Error syncing ${username} (${platform}):`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log("[autoSync] Sync cycle complete");
}

export function startAutoSync(): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[autoSync] Supabase env vars missing — auto-sync disabled");
    return;
  }

  console.log(`[autoSync] Scheduled — first run in ${STARTUP_DELAY_MS / 60000}min, then every ${AUTO_SYNC_INTERVAL_MS / 3600000}h`);

  setTimeout(() => {
    void syncAllUsers();
    setInterval(() => void syncAllUsers(), AUTO_SYNC_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}
