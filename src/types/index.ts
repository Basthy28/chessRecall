// ============================================================
// Chess Recall SRS — Core TypeScript Interfaces
// Mirrors Supabase table schema exactly.
// ============================================================

// ------------------------------------------------------------------
// Enums
// ------------------------------------------------------------------

export type GameResult = "win" | "loss" | "draw";
export type GameStatus = "pending" | "processing" | "analyzed" | "failed";
export type PuzzlePhase = "opening" | "middlegame" | "endgame";
export type PuzzleStatus = "pending" | "validated" | "rejected";
export type SrsRating = 1 | 2 | 3 | 4 | 5; // Ease factor buckets

// ------------------------------------------------------------------
// User
// ------------------------------------------------------------------

export interface User {
  id: string; // uuid — Supabase Auth UID
  lichess_username: string;
  lichess_rating: number | null;
  created_at: string; // ISO 8601
  last_synced_at: string | null;
}

// ------------------------------------------------------------------
// Game  (raw game imported from Lichess)
// ------------------------------------------------------------------

export interface Game {
  id: string; // uuid
  user_id: string; // FK → users.id
  lichess_game_id: string; // e.g. "abcXYZ12"
  pgn: string; // Full PGN string from Lichess API
  white_username: string;
  black_username: string;
  white_rating: number | null;
  black_rating: number | null;
  result: GameResult;
  played_at: string; // ISO 8601
  time_control: string; // e.g. "600+0", "180+2"
  status: GameStatus;
  created_at: string;
}

// ------------------------------------------------------------------
// Puzzle  (a single training position extracted from a Game)
// ------------------------------------------------------------------

export interface Puzzle {
  id: string; // uuid
  game_id: string; // FK → games.id
  user_id: string; // FK → users.id

  // Position
  fen: string; // FEN of the position *before* the blunder
  blunder_move: string; // The move the user actually played (UCI notation, e.g. "e2e4")
  solution_move: string; // Stockfish's #1 best move (UCI notation)
  solution_san: string; // Human-readable SAN (e.g. "Nxf7+")
  solution_line_uci: string[]; // Full refutation PV in UCI (up to 8 moves)
  solution_line_san: string[]; // Full refutation PV in SAN (human-readable)
  is_brilliant: boolean; // true when the correct move is a brilliant/sacrifice find

  // Validation data (populated by Worker)
  eval_before: number; // Centipawn eval before blunder
  eval_after: number; // Centipawn eval after blunder (from the user's perspective)
  eval_best: number; // Centipawn eval of the best move
  eval_second_best: number | null; // CP eval of 2nd best move (for Only-Winning-Move check)
  eval_drop: number; // Absolute drop: eval_before - eval_after  (always positive)
  move_number: number; // Full-move number in the game
  player_color: "white" | "black"; // Who blundered
  phase: PuzzlePhase;

  // SRS scheduling (will be expanded in Phase 2)
  status: PuzzleStatus;
  times_seen: number;
  times_correct: number;
  srs_due_at: string | null; // ISO 8601 — null = never shown yet
  srs_ease: number; // SM-2 ease factor, starts at 2.5
  last_reviewed_at: string | null;

  // Associated game metadata (joined when useful for UI)
  game_lichess_id?: string | null;
  game_white_username?: string | null;
  game_black_username?: string | null;
  game_played_at?: string | null;
  game_time_control?: string | null;
  game_result?: GameResult | null;

  created_at: string;
}

export interface PuzzleProgressStats {
  total: number;
  due_now: number;
  unseen: number;
  learning: number;
  mastered: number;
  reviewed: number;
  total_attempts: number;
  total_correct: number;
  accuracy: number;
}

// ------------------------------------------------------------------
// MoveAnnotation  (per-move classification from worker analysis)
// ------------------------------------------------------------------

export type MoveClassification =
  | "book"      // 📖 — opening theory move confirmed by Lichess explorer
  | "brilliant" // !! — best move AND non-obvious sacrifice / only-winning-move
  | "great"     // !  — not top-1 but nearly as good, non-obvious
  | "best"      // ★  — engine's top choice (delta < 0.02)
  | "excellent" // !  — very close to best (0.02–0.05)
  | "good"      // ✓  — acceptable (0.05–0.10)
  | "inaccuracy"// ?! — noticeable slip (0.10–0.20)
  | "mistake"   // ?  — clear error (0.20–0.30)
  | "blunder"   // ?? — big mistake (≥ 0.30)
  | "miss";     // ✖  — missed a clearly winning opportunity

export interface MoveAnnotation {
  id: string;
  game_id: string;
  user_id: string;
  ply: number;          // 1-indexed ply
  move_uci: string;
  move_san: string;
  fen_before: string;
  eval_best_cp: number;   // Stockfish best score (side-to-move perspective, cp)
  eval_played_cp: number; // Score after the played move (side-to-move next, negated)
  win_before: number;     // win% before move (0–1), from side-to-move
  win_after: number;      // win% after move (0–1), from same side
  classification: MoveClassification;
  is_miss: boolean;
  depth: number;
  created_at: string;
}

// ------------------------------------------------------------------
// Lichess API Response shapes (subset we care about)
// ------------------------------------------------------------------

export interface LichessGame {
  id: string;
  rated: boolean;
  variant: { key: string };
  speed: string;
  perf: string;
  createdAt: number; // Unix ms
  lastMoveAt: number;
  status: string;
  players: {
    white: { user?: { name: string; id?: string }; rating: number };
    black: { user?: { name: string; id?: string }; rating: number };
  };
  winner?: "white" | "black";
  pgn: string;
  clock?: { initial: number; increment: number };
}

// ------------------------------------------------------------------
// BullMQ Job Payloads
// ------------------------------------------------------------------

export interface AnalyzeGameJobData {
  gameId: string; // FK → games.id
  userId: string;
  pgn: string;
  playerColor: "white" | "black";
}

export interface AnalyzeGameJobResult {
  gameId: string;
  puzzlesFound: number;
  puzzlesValidated: number;
}

// ------------------------------------------------------------------
// Puzzle Validator Config  (tunable thresholds)
// ------------------------------------------------------------------

export interface PuzzleValidatorConfig {
  /** Minimum centipawn drop to flag a move as a blunder */
  minEvalDrop: number; // default: 150
  /** Minimum centipawn gap between best and 2nd-best move (Only-Winning-Move rule) */
  minSolutionGap: number; // default: 100
  /** Stockfish analysis depth */
  analysisDepth: number; // default: 20
  /** Number of MultiPV lines to request (must be ≥ 2 for gap check) */
  multiPv: number; // default: 2
}

export const DEFAULT_VALIDATOR_CONFIG: PuzzleValidatorConfig = {
  minEvalDrop: 180,
  minSolutionGap: 120,
  analysisDepth: 22,
  multiPv: 3,
};
