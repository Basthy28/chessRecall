import { Pool } from "pg";
import type { Game, GameStatus, Puzzle, PuzzleProgressStats, PuzzleTrainingMode } from "@/types";

type Platform = "lichess" | "chess.com" | "all";
type SrsChoice = "hard" | "good" | "easy";
type SyncPlatform = "lichess" | "chess.com";

let poolSingleton: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function getPool(): Pool {
  if (poolSingleton) return poolSingleton;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("Missing DATABASE_URL for Postgres storage");
  }

  poolSingleton = new Pool({
    connectionString,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  return poolSingleton;
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        lichess_game_id text NOT NULL UNIQUE,
        pgn text NOT NULL,
        white_username text NOT NULL,
        black_username text NOT NULL,
        white_rating integer,
        black_rating integer,
        result text NOT NULL CHECK (result IN ('win','loss','draw')),
        played_at timestamptz NOT NULL,
        time_control text NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','analyzed','failed')),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS puzzles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_id uuid NOT NULL,
        user_id uuid NOT NULL,
        fen text NOT NULL,
        blunder_move text NOT NULL,
        solution_move text NOT NULL,
        solution_san text NOT NULL,
        eval_before integer NOT NULL,
        eval_after integer NOT NULL,
        eval_best integer NOT NULL,
        eval_second_best integer,
        eval_drop integer NOT NULL,
        move_number integer NOT NULL,
        player_color text NOT NULL CHECK (player_color IN ('white','black')),
        phase text NOT NULL CHECK (phase IN ('opening','middlegame','endgame')),
        training_kind text NOT NULL DEFAULT 'strict',
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validated','rejected')),
        times_seen integer NOT NULL DEFAULT 0,
        times_correct integer NOT NULL DEFAULT 0,
        srs_due_at timestamptz,
        srs_ease numeric NOT NULL DEFAULT 2.5,
        last_reviewed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        solution_line_uci text[] NOT NULL DEFAULT '{}',
        solution_line_san text[] NOT NULL DEFAULT '{}',
        is_brilliant boolean NOT NULL DEFAULT false,
        CONSTRAINT puzzles_game_fk FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS games_user_played_at_idx ON games (user_id, played_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS games_user_id_status_idx ON games (user_id, status);
      CREATE INDEX IF NOT EXISTS puzzles_user_id_srs_due_at_idx ON puzzles (user_id, srs_due_at);
      CREATE INDEX IF NOT EXISTS puzzles_game_id_idx ON puzzles (game_id);

      CREATE TABLE IF NOT EXISTS import_sync_cooldowns (
        user_id uuid NOT NULL,
        platform text NOT NULL CHECK (platform IN ('lichess','chess.com')),
        username text NOT NULL,
        last_synced_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, platform, username)
      );

      CREATE INDEX IF NOT EXISTS import_sync_cooldowns_last_synced_at_idx
      ON import_sync_cooldowns (last_synced_at DESC);
    `);
    await pool.query(`
      ALTER TABLE puzzles
      ADD COLUMN IF NOT EXISTS training_kind text NOT NULL DEFAULT 'strict'
    `);
  })();

  return schemaReady;
}

function platformPredicate(platform: Platform): string {
  if (platform === "chess.com") return "g.lichess_game_id LIKE 'cc_%'";
  if (platform === "lichess") return "g.lichess_game_id NOT LIKE 'cc_%'";
  return "TRUE";
}

function mapGame(row: Record<string, unknown>): Game {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    lichess_game_id: String(row.lichess_game_id),
    pgn: String(row.pgn),
    white_username: String(row.white_username),
    black_username: String(row.black_username),
    white_rating: row.white_rating as number | null,
    black_rating: row.black_rating as number | null,
    result: row.result as Game["result"],
    played_at: new Date(String(row.played_at)).toISOString(),
    time_control: String(row.time_control),
    status: row.status as GameStatus,
    created_at: new Date(String(row.created_at)).toISOString(),
  };
}

function mapPuzzle(row: Record<string, unknown>): Puzzle {
  return {
    id: String(row.id),
    game_id: String(row.game_id),
    user_id: String(row.user_id),
    fen: String(row.fen),
    blunder_move: String(row.blunder_move),
    solution_move: String(row.solution_move),
    solution_san: String(row.solution_san),
    solution_line_uci: (row.solution_line_uci as string[]) ?? [],
    solution_line_san: (row.solution_line_san as string[]) ?? [],
    is_brilliant: Boolean(row.is_brilliant),
    training_kind: row.training_kind === "practice" ? "practice" : "strict",
    eval_before: Number(row.eval_before),
    eval_after: Number(row.eval_after),
    eval_best: Number(row.eval_best),
    eval_second_best: (row.eval_second_best as number | null) ?? null,
    eval_drop: Number(row.eval_drop),
    move_number: Number(row.move_number),
    player_color: row.player_color as "white" | "black",
    phase: row.phase as Puzzle["phase"],
    status: row.status as Puzzle["status"],
    times_seen: Number(row.times_seen),
    times_correct: Number(row.times_correct),
    srs_due_at: row.srs_due_at ? new Date(String(row.srs_due_at)).toISOString() : null,
    srs_ease: Number(row.srs_ease),
    last_reviewed_at: row.last_reviewed_at ? new Date(String(row.last_reviewed_at)).toISOString() : null,
    game_lichess_id: row.game_lichess_id ? String(row.game_lichess_id) : null,
    game_white_username: row.game_white_username ? String(row.game_white_username) : null,
    game_black_username: row.game_black_username ? String(row.game_black_username) : null,
    game_played_at: row.game_played_at ? new Date(String(row.game_played_at)).toISOString() : null,
    game_time_control: row.game_time_control ? String(row.game_time_control) : null,
    game_result: (row.game_result as Puzzle["game_result"]) ?? null,
    created_at: new Date(String(row.created_at)).toISOString(),
  };
}

export async function upsertGames(rows: Array<Omit<Game, "id" | "created_at">>): Promise<Game[]> {
  if (rows.length === 0) return [];
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out: Game[] = [];

    for (const row of rows) {
      const result = await client.query(
        `INSERT INTO games
          (user_id, lichess_game_id, pgn, white_username, black_username, white_rating, black_rating, result, played_at, time_control, status)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (lichess_game_id)
         DO UPDATE SET
          user_id = EXCLUDED.user_id,
          pgn = EXCLUDED.pgn,
          white_username = EXCLUDED.white_username,
          black_username = EXCLUDED.black_username,
          white_rating = EXCLUDED.white_rating,
          black_rating = EXCLUDED.black_rating,
          result = EXCLUDED.result,
          played_at = EXCLUDED.played_at,
          time_control = EXCLUDED.time_control
          -- status intentionally omitted: preserves analyzed/processing/failed state on re-sync
         RETURNING *`,
        [
          row.user_id,
          row.lichess_game_id,
          row.pgn,
          row.white_username,
          row.black_username,
          row.white_rating,
          row.black_rating,
          row.result,
          row.played_at,
          row.time_control,
          row.status,
        ]
      );
      out.push(mapGame(result.rows[0] as Record<string, unknown>));
    }

    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function countGamesByUser(userId: string): Promise<number> {
  await ensureSchema();
  const pool = getPool();
  const { rows } = await pool.query("SELECT count(*)::int AS count FROM games WHERE user_id = $1", [userId]);
  return Number(rows[0]?.count ?? 0);
}

export async function countGamesByUserForPlatform(
  userId: string,
  platform: Platform,
  searchQuery?: string
): Promise<number> {
  await ensureSchema();
  const pool = getPool();
  const where: string[] = ["g.user_id = $1", platformPredicate(platform)];
  const values: Array<string | number> = [userId];
  buildPlayerSearchClause(searchQuery, where, values);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count
     FROM games g
     WHERE ${where.join(" AND ")}`,
    values
  );
  return Number(rows[0]?.count ?? 0);
}

function buildPlayerSearchClause(
  searchQuery: string | undefined,
  where: string[],
  values: Array<string | number>
): void {
  const normalized = searchQuery?.trim().toLowerCase() ?? "";
  if (!normalized) return;
  values.push(`%${normalized}%`);
  const idx = values.length;
  where.push(`(lower(g.white_username) LIKE $${idx} OR lower(g.black_username) LIKE $${idx})`);
}

export async function countGamesByStatusForPlatform(
  userId: string,
  platform: Platform,
  searchQuery?: string
): Promise<{ pending: number; processing: number; analyzed: number; failed: number }> {
  await ensureSchema();
  const pool = getPool();
  const where: string[] = ["g.user_id = $1", platformPredicate(platform)];
  const values: Array<string | number> = [userId];
  buildPlayerSearchClause(searchQuery, where, values);
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS count
     FROM games g
     WHERE ${where.join(" AND ")}
     GROUP BY status`,
    values
  );
  const out = { pending: 0, processing: 0, analyzed: 0, failed: 0 };
  for (const row of rows) {
    const s = String(row.status) as keyof typeof out;
    if (s in out) out[s] = Number(row.count ?? 0);
  }
  return out;
}

export async function countPuzzlesByUser(userId: string): Promise<number> {
  await ensureSchema();
  const pool = getPool();
  const { rows } = await pool.query("SELECT count(*)::int AS count FROM puzzles WHERE user_id = $1", [userId]);
  return Number(rows[0]?.count ?? 0);
}

export async function countChessComGamesForUserAndName(userId: string, username: string): Promise<number> {
  await ensureSchema();
  const pool = getPool();
  const needle = username.trim().toLowerCase();
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count
     FROM games g
     WHERE g.user_id = $1
       AND g.lichess_game_id LIKE 'cc_%'
       AND (lower(g.white_username) = $2 OR lower(g.black_username) = $2)`,
    [userId, needle]
  );
  return Number(rows[0]?.count ?? 0);
}

export async function latestPlayedAtForChessComUser(userId: string, username: string): Promise<string | null> {
  await ensureSchema();
  const pool = getPool();
  const needle = username.trim().toLowerCase();
  const { rows } = await pool.query(
    `SELECT played_at
     FROM games g
     WHERE g.user_id = $1
       AND g.lichess_game_id LIKE 'cc_%'
       AND (lower(g.white_username) = $2 OR lower(g.black_username) = $2)
     ORDER BY played_at DESC, id DESC
     LIMIT 1`,
    [userId, needle]
  );
  return rows[0]?.played_at ? new Date(String(rows[0].played_at)).toISOString() : null;
}

export async function listGamesPage(params: {
  userId: string;
  platform: Platform;
  cursorPlayedAt: string | null;
  limit: number;
  searchQuery?: string;
}): Promise<Game[]> {
  await ensureSchema();
  const pool = getPool();
  const where: string[] = ["g.user_id = $1", platformPredicate(params.platform)];
  const values: Array<string | number> = [params.userId];
  buildPlayerSearchClause(params.searchQuery, where, values);
  if (params.cursorPlayedAt) {
    const [cursorPlayedAt, cursorId] = params.cursorPlayedAt.split("|");
    if (cursorPlayedAt && cursorId) {
      values.push(cursorPlayedAt);
      const playedAtIdx = values.length;
      values.push(cursorId);
      const idIdx = values.length;
      where.push(
        `(g.played_at < $${playedAtIdx} OR (g.played_at = $${playedAtIdx} AND g.id < $${idIdx}::uuid))`
      );
    } else {
      values.push(params.cursorPlayedAt);
      where.push(`g.played_at < $${values.length}`);
    }
  }
  values.push(params.limit);

  const query = `
    SELECT *
    FROM games g
    WHERE ${where.join(" AND ")}
    ORDER BY g.played_at DESC, g.id DESC
    LIMIT $${values.length}
  `;
  const { rows } = await pool.query(query, values);
  return rows.map((row) => mapGame(row as Record<string, unknown>));
}

export async function listAnalyzableGames(params: {
  userId: string;
  platform: Platform;
  limit: number;
  username: string;
  gameIds: string[];
  order?: "newest" | "oldest";
}): Promise<Array<Pick<Game, "id" | "user_id" | "pgn" | "white_username" | "black_username" | "status" | "played_at" | "lichess_game_id">>> {
  await ensureSchema();
  const pool = getPool();
  const values: Array<string | number | string[]> = [params.userId];
  const where: string[] = ["g.user_id = $1"];
  const hasSelection = params.gameIds.length > 0;

  if (hasSelection) {
    values.push(params.gameIds);
    where.push(`g.id = ANY($${values.length}::uuid[])`);
  } else {
    where.push("g.status IN ('pending','failed')");
    where.push(platformPredicate(params.platform));
    const normalized = params.username.trim().toLowerCase();
    if (normalized) {
      values.push(normalized);
      where.push(`(lower(g.white_username) = $${values.length} OR lower(g.black_username) = $${values.length})`);
    }
  }

  values.push(params.limit);
  const orderDirection = params.order === "oldest" ? "ASC" : "DESC";
  const { rows } = await pool.query(
    `SELECT g.id, g.user_id, g.pgn, g.white_username, g.black_username, g.status, g.played_at, g.lichess_game_id
     FROM games g
     WHERE ${where.join(" AND ")}
     ORDER BY g.played_at ${orderDirection}, g.id ${orderDirection}
     LIMIT $${values.length}`,
    values
  );

  return rows.map((row) => ({
    id: String(row.id),
    user_id: String(row.user_id),
    pgn: String(row.pgn),
    white_username: String(row.white_username),
    black_username: String(row.black_username),
    status: row.status as GameStatus,
    played_at: new Date(String(row.played_at)).toISOString(),
    lichess_game_id: String(row.lichess_game_id),
  }));
}

export async function updateGameStatusByIds(ids: string[], status: GameStatus): Promise<void> {
  if (ids.length === 0) return;
  await ensureSchema();
  const pool = getPool();
  await pool.query("UPDATE games SET status = $1 WHERE id = ANY($2::uuid[])", [status, ids]);
}

export async function updateGameStatus(gameId: string, status: GameStatus): Promise<void> {
  await updateGameStatusByIds([gameId], status);
}

export async function getGameByIdForUser(gameId: string, userId: string): Promise<Game | null> {
  await ensureSchema();
  const pool = getPool();
  const { rows } = await pool.query("SELECT * FROM games WHERE id = $1 AND user_id = $2 LIMIT 1", [gameId, userId]);
  if (rows.length === 0) return null;
  return mapGame(rows[0] as Record<string, unknown>);
}

export async function insertPuzzle(row: Omit<Puzzle, "id" | "created_at">): Promise<Puzzle> {
  await ensureSchema();
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO puzzles
      (game_id, user_id, fen, blunder_move, solution_move, solution_san, eval_before, eval_after, eval_best, eval_second_best,
       eval_drop, move_number, player_color, phase, training_kind, status, times_seen, times_correct, srs_due_at, srs_ease, last_reviewed_at,
       solution_line_uci, solution_line_san, is_brilliant)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     RETURNING *`,
    [
      row.game_id,
      row.user_id,
      row.fen,
      row.blunder_move,
      row.solution_move,
      row.solution_san,
      row.eval_before,
      row.eval_after,
      row.eval_best,
      row.eval_second_best,
      row.eval_drop,
      row.move_number,
      row.player_color,
      row.phase,
      row.training_kind,
      row.status,
      row.times_seen,
      row.times_correct,
      row.srs_due_at,
      row.srs_ease,
      row.last_reviewed_at,
      row.solution_line_uci,
      row.solution_line_san,
      row.is_brilliant,
    ]
  );

  return mapPuzzle(rows[0] as Record<string, unknown>);
}

export async function resetPuzzleSrsForUser(userId: string): Promise<number> {
  await ensureSchema();
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE puzzles
     SET srs_due_at = NULL,
         srs_ease = 2.5,
         times_seen = 0,
         times_correct = 0,
         last_reviewed_at = NULL
     WHERE user_id = $1`,
    [userId]
  );
  return rowCount ?? 0;
}

export async function listDuePuzzlesForUser(
  userId: string,
  limit: number,
  nowIso: string,
  mode: PuzzleTrainingMode = "mixed"
): Promise<Puzzle[]> {
  await ensureSchema();
  const pool = getPool();
  const nextRotationIso = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  const weakAccuracyThreshold = 0.8;
  const weakEaseThreshold = 2.35;
  const accuracyExpr = "coalesce((p.times_correct::float / nullif(p.times_seen, 0)), 0)";
  const baseSelect = `SELECT
       p.*,
       g.lichess_game_id AS game_lichess_id,
       g.white_username AS game_white_username,
       g.black_username AS game_black_username,
       g.played_at AS game_played_at,
       g.time_control AS game_time_control,
       g.result AS game_result
     FROM puzzles p
     JOIN games g ON g.id = p.game_id`;
  let query = "";
  let params: Array<string | number> = [];

  switch (mode) {
    case "review":
      query = `${baseSelect}
        WHERE p.user_id = $1
          AND p.times_seen > 0
          AND p.srs_due_at IS NOT NULL
          AND p.srs_due_at <= $2
        ORDER BY p.srs_due_at ASC, p.eval_drop DESC, p.last_reviewed_at ASC NULLS FIRST
        LIMIT $3`;
      params = [userId, nowIso, limit];
      break;
    case "new":
      query = `${baseSelect}
        WHERE p.user_id = $1
          AND p.times_seen = 0
        ORDER BY p.created_at DESC, p.eval_drop DESC
        LIMIT $2`;
      params = [userId, limit];
      break;
    case "weak":
      query = `${baseSelect}
        WHERE p.user_id = $1
          AND p.times_seen > 0
          AND (p.srs_due_at IS NULL OR p.srs_due_at < $2::timestamptz)
          AND (${accuracyExpr} < $3 OR p.srs_ease < $4)
        ORDER BY ${accuracyExpr} ASC, p.srs_ease ASC, p.last_reviewed_at DESC NULLS LAST, p.eval_drop DESC
        LIMIT $5`;
      params = [userId, nextRotationIso, weakAccuracyThreshold, weakEaseThreshold, limit];
      break;
    case "mixed":
    default:
      query = `${baseSelect}
        WHERE p.user_id = $1
          AND (p.times_seen = 0 OR p.srs_due_at IS NULL OR p.srs_due_at < $3::timestamptz)
        ORDER BY
          CASE
            WHEN p.times_seen > 0 AND p.srs_due_at IS NOT NULL AND p.srs_due_at <= $2 THEN 0
            WHEN p.times_seen > 0 AND (${accuracyExpr} < $4 OR p.srs_ease < $5) THEN 1
            WHEN p.times_seen = 0 THEN 2
            ELSE 3
          END ASC,
          CASE
            WHEN p.times_seen > 0 AND p.srs_due_at IS NOT NULL AND p.srs_due_at <= $2 THEN p.srs_due_at
            ELSE NULL
          END ASC NULLS LAST,
          CASE
            WHEN p.times_seen > 0 THEN ${accuracyExpr}
            ELSE NULL
          END ASC NULLS LAST,
          CASE
            WHEN p.times_seen = 0 THEN p.created_at
            ELSE NULL
          END DESC NULLS LAST,
          p.eval_drop DESC,
          p.created_at DESC
        LIMIT $6`;
      params = [userId, nowIso, nextRotationIso, weakAccuracyThreshold, weakEaseThreshold, limit];
      break;
  }

  const { rows } = await pool.query(query, params);
  return rows.map((row) => mapPuzzle(row as Record<string, unknown>));
}

export async function getPuzzleProgressStatsForUser(
  userId: string,
  nowIso: string
): Promise<PuzzleProgressStats> {
  await ensureSchema();
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE times_seen > 0 AND srs_due_at IS NOT NULL AND srs_due_at <= $2)::int AS due_now,
       count(*) FILTER (WHERE times_seen = 0)::int AS unseen,
       count(*) FILTER (
         WHERE times_seen > 0
           AND (srs_due_at IS NULL OR srs_due_at < ($2::timestamptz + interval '60 days'))
       )::int AS learning,
       count(*) FILTER (WHERE srs_due_at >= ($2::timestamptz + interval '60 days'))::int AS mastered,
       count(*) FILTER (WHERE times_seen > 0)::int AS reviewed,
       coalesce(sum(times_seen), 0)::int AS total_attempts,
       coalesce(sum(times_correct), 0)::int AS total_correct
     FROM puzzles
     WHERE user_id = $1`,
    [userId, nowIso]
  );
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  const totalAttempts = Number(row.total_attempts ?? 0);
  const totalCorrect = Number(row.total_correct ?? 0);

  return {
    total: Number(row.total ?? 0),
    due_now: Number(row.due_now ?? 0),
    unseen: Number(row.unseen ?? 0),
    learning: Number(row.learning ?? 0),
    mastered: Number(row.mastered ?? 0),
    reviewed: Number(row.reviewed ?? 0),
    total_attempts: totalAttempts,
    total_correct: totalCorrect,
    accuracy: totalAttempts > 0 ? totalCorrect / totalAttempts : 0,
  };
}

// Interval at which a puzzle is considered "mastered" and stops appearing.
const RETIRE_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export async function applyPuzzleSrsRating(
  userId: string,
  puzzleId: string,
  choice: SrsChoice,
  options?: { revealed?: boolean; mistakes?: number }
): Promise<boolean> {
  await ensureSchema();
  const pool = getPool();
  const revealed = options?.revealed === true;
  const mistakes = Math.max(0, Math.floor(options?.mistakes ?? 0));

  // Fetch current puzzle state to compute SM-2 style next interval.
  const { rows: puzzleRows } = await pool.query(
    `SELECT srs_ease, srs_due_at, last_reviewed_at FROM puzzles WHERE id = $1 AND user_id = $2`,
    [puzzleId, userId]
  );
  if (!puzzleRows.length) return false;

  const p = puzzleRows[0] as Record<string, unknown>;
  const ease = Math.max(1.3, Math.min(3.0, Number(p.srs_ease ?? 2.5)));

  // Current interval: time between last review and when it was scheduled next.
  // Falls back to 0 for unseen puzzles so minimums below kick in.
  let currentIntervalMs = 0;
  if (p.srs_due_at && p.last_reviewed_at) {
    currentIntervalMs = Math.max(0,
      new Date(String(p.srs_due_at)).getTime() - new Date(String(p.last_reviewed_at)).getTime()
    );
  }

  let nextIntervalMs: number;
  let nextEase = ease;

  switch (choice) {
    case "hard":
      nextIntervalMs = Math.max(10 * 60 * 1000, currentIntervalMs * 0.6);
      nextEase = Math.max(1.3, ease - 0.15);
      break;
    case "good":
      nextIntervalMs = Math.max(24 * 60 * 60 * 1000, currentIntervalMs * ease);
      break;
    case "easy":
      nextIntervalMs = Math.max(4 * 24 * 60 * 60 * 1000, currentIntervalMs * ease * 1.3);
      nextEase = Math.min(3.0, ease + 0.1);
      break;
  }

  if (revealed) {
    nextIntervalMs = Math.min(nextIntervalMs, 12 * 60 * 60 * 1000);
    nextEase = Math.max(1.3, nextEase - 0.25);
  } else if (mistakes > 0) {
    nextIntervalMs = Math.max(30 * 60 * 1000, nextIntervalMs * 0.6);
    nextEase = Math.max(1.3, nextEase - Math.min(0.18, mistakes * 0.05));
  }

  // Graduation: if the next interval would exceed 90 days the puzzle is mastered.
  // Set srs_due_at exactly 90 days from now — it will resurface rarely as a refresher,
  // but since listDuePuzzlesForUser orders by srs_due_at ASC, it will never crowd out active puzzles.
  const dueAt = new Date(Date.now() + Math.min(nextIntervalMs, RETIRE_INTERVAL_MS)).toISOString();

  const earnedCorrect = !revealed && mistakes === 0 ? 1 : 0;
  const { rowCount } = await pool.query(
    `UPDATE puzzles
     SET times_seen = times_seen + 1,
         times_correct = times_correct + $1,
         srs_ease = $2,
         srs_due_at = $3,
         last_reviewed_at = now()
     WHERE id = $4 AND user_id = $5`,
    [earnedCorrect, nextEase.toFixed(4), dueAt, puzzleId, userId]
  );

  return (rowCount ?? 0) > 0;
}

export async function getImportCooldownRemainingMs(
  userId: string,
  platform: SyncPlatform,
  username: string,
  cooldownMs: number
): Promise<number> {
  await ensureSchema();
  const pool = getPool();
  const normalized = username.trim().toLowerCase();
  const { rows } = await pool.query(
    `SELECT last_synced_at
     FROM import_sync_cooldowns
     WHERE user_id = $1 AND platform = $2 AND username = $3
     LIMIT 1`,
    [userId, platform, normalized]
  );

  const last = rows[0]?.last_synced_at ? new Date(String(rows[0].last_synced_at)).getTime() : 0;
  if (!last) return 0;
  const remaining = cooldownMs - (Date.now() - last);
  return Math.max(0, remaining);
}

export async function markImportSyncedNow(
  userId: string,
  platform: SyncPlatform,
  username: string
): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  const normalized = username.trim().toLowerCase();
  await pool.query(
    `INSERT INTO import_sync_cooldowns (user_id, platform, username, last_synced_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, platform, username)
     DO UPDATE SET last_synced_at = now()`,
    [userId, platform, normalized]
  );
}
