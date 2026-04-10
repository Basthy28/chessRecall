// ── Load .env.local for standalone worker process ──────────────────
// Next.js loads .env.local automatically, but `npx tsx` does not.
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
{
  const envPath = resolve(process.cwd(), ".env.local");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
}

/**
 * analyzeGame.worker.ts
 *
 * BullMQ Worker — Phase 2 implementation.
 *
 * Responsibilities:
 *   1. Pull a Game from the Redis queue.
 *   2. Initialize Stockfish engine (UCI protocol).
 *   3. Pre-evaluate ALL N+1 positions in one pass (both players).
 *   4. Classify every move using Lichess win% formula.
 *   5. Detect player blunders and misses → create SRS puzzles.
 *   6. Persist move_annotations and puzzles to Supabase.
 *
 * Run this file directly with:
 *   npx tsx src/workers/analyzeGame.worker.ts
 *
 * NOTE: This file runs in Node.js — NOT in Next.js / browser context.
 */

import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { Chess } from "chess.js";
import { spawn } from "child_process";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const initEngine = require("stockfish") as (
  enginePath?: string | null
) => Promise<StockfishEngine>;

import type {
  AnalyzeGameJobData,
  AnalyzeGameJobResult,
  GameStatus,
  MoveClassification,
  Puzzle,
  PuzzlePhase,
} from "@/types";
import { DEFAULT_VALIDATOR_CONFIG } from "@/types";
import { createServerClient } from "@/lib/supabase";
import { ANALYZE_QUEUE_NAME } from "@/lib/constants";

// ── Stockfish engine type ───────────────────────────────────────────
interface StockfishEngine {
  listener?: (line: string) => void;
  sendCommand: (cmd: string) => void;
  terminate?: () => void;
}

// ── Position shape from PGN parsing ────────────────────────────────
interface Position {
  fen: string;
  movePlayed: string;
  san: string;
  moveNumber: number;
  turn: "w" | "b";
}

// ── Evaluation result ───────────────────────────────────────────────
interface EvalLine {
  move: string;
  score: number;
  pv: string[]; // full UCI move sequence from this position (up to 8 moves)
}

interface EvalResult {
  best: EvalLine;
  second: EvalLine | null;
}

// ── Cluster / env config ─────────────────────────────────────────────
// Overridden on the Oracle cluster via Docker env vars.
// ENGINE_MODE=native  → spawn the system `stockfish` binary (5-10x faster, use on cluster)
// ENGINE_MODE=wasm    → use npm WASM package (default, works anywhere)
const ENGINE_MODE = (process.env.ENGINE_MODE ?? "wasm") as "native" | "wasm";
const STOCKFISH_THREADS = Math.max(1, Number(process.env.STOCKFISH_THREADS ?? "1"));
const STOCKFISH_HASH_MB = Math.max(64, Number(process.env.STOCKFISH_HASH_MB ?? "256"));
const STOCKFISH_PATH = process.env.STOCKFISH_PATH ?? "/usr/games/stockfish";
// Use movetime (ms) when > 0, otherwise fall back to depth. Defaulting to 1000ms gives much deeper endgame analysis.
const STOCKFISH_MOVETIME_MS = Number(process.env.STOCKFISH_MOVETIME_MS ?? "1000");
const ENV_DEPTH = process.env.ANALYSIS_DEPTH ? Number(process.env.ANALYSIS_DEPTH) : null;

// ── Save native fetch before Stockfish ASM can nullify it ──────────
// The Stockfish emscripten ASM module sets globalThis.fetch = null in
// Node.js environments. We save and restore it after initialization.
const _nativeFetch: typeof fetch | undefined =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;

// ── ECO opening book (local JSON, no network required) ─────────────
// Maps 4-part FEN (position + turn + castling + en-passant) → { eco, name }.
// Built from src/lib/ecoBook.json at startup — O(1) lookup thereafter.
interface EcoEntry { eco: string; name: string }
const _ecoMap = new Map<string, EcoEntry>();
try {
  const ecoPath = resolve(process.cwd(), "src/lib/ecoBook.json");
  const raw = JSON.parse(readFileSync(ecoPath, "utf-8")) as Record<string, EcoEntry>;
  for (const [fen, entry] of Object.entries(raw)) {
    const key = fen.split(" ").slice(0, 4).join(" ");
    if (!_ecoMap.has(key)) _ecoMap.set(key, entry); // first entry wins on collision
  }
  console.log(`[worker] ECO book loaded: ${_ecoMap.size} positions`);
} catch {
  console.warn("[worker] Could not load ecoBook.json — book classification disabled");
}

function lookupEco(fen: string): EcoEntry | null {
  const key = fen.split(" ").slice(0, 4).join(" ");
  return _ecoMap.get(key) ?? null;
}

// ── Stockfish singleton ─────────────────────────────────────────────
// The ASM module can only be initialized once per process.
let _sharedEngine: StockfishEngine | null = null;

// ── Redis connection ────────────────────────────────────────────────
const redisConnection = new IORedis({
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null, // required by BullMQ
});

let supabase: ReturnType<typeof createServerClient> | null = null;
try {
  supabase = createServerClient();
} catch {
  console.warn("[worker] Supabase not configured; DB writes disabled.");
}

async function updateGameStatus(gameId: string, status: GameStatus): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from("games").update({ status }).eq("id", gameId);
  if (error) {
    console.error(`[worker] failed to set game ${gameId} status=${status}:`, error.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Win-percentage formula from Lichess (ui/analyse/src/util.ts)
// Maps centipawns (side-to-move perspective) → win probability 0..1
// cp = 0   → 0.50 (even)
// cp = +800 → ~0.945 (clearly winning)
// cp = -800 → ~0.055 (clearly losing)
// ─────────────────────────────────────────────────────────────────────────────
function winChances(cp: number): number {
  const bounded = Math.max(Math.min(cp, 1000), -1000);
  return 1 / (1 + Math.exp(-0.00368208 * bounded));
}

// ─────────────────────────────────────────────────────────────────────────────
// Classify a single move using Lichess win% delta thresholds.
// Matches Lichess Advice.scala and src/lib/analysis.ts exactly.
//
//   delta < 0.02 → best       (within noise of engine's top choice)
//   delta < 0.05 → excellent
//   delta < 0.10 → good
//   delta < 0.20 → inaccuracy
//   delta < 0.30 → mistake
//   delta ≥ 0.30 → blunder
// ─────────────────────────────────────────────────────────────────────────────
function classifyMove(winBest: number, winAfter: number): MoveClassification {
  const delta = winBest - winAfter;
  if (delta < 0.02) return "best";
  if (delta < 0.05) return "excellent";
  if (delta < 0.10) return "good";
  if (delta < 0.20) return "inaccuracy";
  if (delta < 0.30) return "mistake";
  return "blunder";
}

// ─────────────────────────────────────────────────────────────────────────────
// Convert a UCI PV sequence to SAN, stopping at the first illegal move.
// ─────────────────────────────────────────────────────────────────────────────
function pvToSan(fen: string, pvUci: string[]): string[] {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of pvUci) {
    try {
      const m = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      if (!m) break;
      sans.push(m.san);
    } catch {
      break;
    }
  }
  return sans;
}

// ─────────────────────────────────────────────────────────────────────────────
// validatePuzzleLine: Re-evaluates a PV line to ensure it forms a strict puzzle.
// - Player moves MUST be the only winning reply (gap > minGapCp)
// - Opponent moves must match the engine's best defense.
// ─────────────────────────────────────────────────────────────────────────────
async function validatePuzzleLine(
  engine: StockfishEngine,
  initialFen: string,
  pvUci: string[],
  engineDepth: number,
  minGapCp: number
): Promise<string[]> {
  const validUci: string[] = [];
  const chess = new Chess(initialFen);

  for (let i = 0; i < pvUci.length; i++) {
    const moveUci = pvUci[i];
    const isPlayerTurn = (i % 2 === 0);

    if (i > 0) {
      const currentFen = chess.fen();
      try {
        // MultiPV=2 to check for alternatives
        const ev = await evaluatePosition(engine, currentFen, engineDepth, 2, STOCKFISH_MOVETIME_MS);
        
        // If the engine no longer likes this move, the sequence is unstable.
        if (ev.best.move !== moveUci) {
          break;
        }

        // Only the player's moves need to be "forced" (only winning move).
        // The opponent just plays the best defense.
        if (isPlayerTurn && ev.second !== null) {
          const gap = ev.best.score - ev.second.score;
          if (gap < minGapCp) {
            break; // Alternative is too good; not a strict puzzle sequence anymore.
          }
        }
      } catch {
        break; // Stop extending the puzzle on engine error
      }
    }

    try {
      const m = chess.move({
        from: moveUci.slice(0, 2),
        to: moveUci.slice(2, 4),
        promotion: moveUci.length > 4 ? moveUci[4] : undefined
      });
      if (!m) break;
    } catch {
      break;
    }
    
    validUci.push(moveUci);
  }

  // Ensure the puzzle ends on a player's move so they complete a tactic.
  // i=0 is player, i=1 is opponent. Length 1 = player only (odd).
  // Length 2 = player then opponent (even) -> we pop it so it ends on player.
  if (validUci.length % 2 === 0) {
    validUci.pop();
  }

  return validUci;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classify a single move, handling mate scores correctly.
//
// Pure win% delta works for most positions but breaks when the player is
// already losing: going from -300cp to "opponent mate-in-1" only produces a
// delta of ~0.22 (mistake) even though the move is catastrophic.
//
// Special-case rules:
//   - If opponent has a forced mating sequence after our move  → always blunder
//   - If we had a forced mating sequence but didn't play the best move → always blunder
//   - Otherwise use standard Lichess win% delta thresholds
// ─────────────────────────────────────────────────────────────────────────────
function classifyMoveWithMates(
  evalBeforeScore: number,   // side-to-move score before our move (from eval best)
  evalAfterScore: number,    // side-to-move score after our move (from opponent's eval, will be negated)
  playedBest: boolean,
): MoveClassification {
  const MATE_THRESHOLD = 90_000;

  // Were we already getting mated before this move? (engine reports negative mate score)
  // If so, any move we play will still leave opponent with forced mate — not our fault.
  const alreadyGettingMated = evalBeforeScore < -MATE_THRESHOLD;

  // Opponent has forced mate after our move — only a blunder if we weren't already lost
  if (evalAfterScore > MATE_THRESHOLD && !alreadyGettingMated) return "blunder";

  // We had a forced mating sequence but didn't take it
  if (evalBeforeScore > MATE_THRESHOLD && !playedBest) return "blunder";

  const winBest = winChances(evalBeforeScore);
  const winAfter = winChances(-evalAfterScore);
  return classifyMove(winBest, winAfter);
}

// ─────────────────────────────────────────────────────────────────────────────
// Miss detection: player had a clearly winning shot (winBest > 65%) but
// chose a move that didn't capitalise (missed >25% win%). Their position
// after the move is still not losing (winAfter > 30%) — so it's not a
// blunder, just a missed opportunity.
// ─────────────────────────────────────────────────────────────────────────────
function isMissedWin(winBest: number, winAfter: number): boolean {
  return winBest > 0.65 && (winBest - winAfter) > 0.25 && winAfter > 0.30;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn the system `stockfish` binary as a child process.
// Output lines are delivered to engine.listener one at a time.
// ─────────────────────────────────────────────────────────────────────────────
function spawnNativeEngine(): StockfishEngine {
  // Use an explicit binary path so we never hit node_modules/.bin/stockfish (WASM wrapper).
  const proc = spawn(STOCKFISH_PATH);
  let buf = "";

  const engine: StockfishEngine = {
    sendCommand(cmd: string) {
      proc.stdin.write(cmd + "\n");
    },
  };

  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) engine.listener?.(trimmed);
    }
  });

  proc.stderr.on("data", (d: Buffer) =>
    console.warn("[worker][stockfish stderr]", d.toString().trim())
  );

  proc.on("exit", (code) =>
    console.log(`[worker] Stockfish process exited with code ${code}`)
  );

  return engine;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stockfish init — singleton per process
// ─────────────────────────────────────────────────────────────────────────────
async function initStockfish(): Promise<StockfishEngine> {
  if (_sharedEngine) {
    _sharedEngine.sendCommand("ucinewgame");
    return _sharedEngine;
  }

  let engine: StockfishEngine;

  if (ENGINE_MODE === "native") {
    // Native binary — fastest, use on the Oracle cluster after `apt install stockfish`
    console.log(`[worker] Stockfish: native binary, threads=${STOCKFISH_THREADS} hash=${STOCKFISH_HASH_MB}MB movetime=${STOCKFISH_MOVETIME_MS}ms`);
    engine = spawnNativeEngine();
  } else {
    // WASM fallback — works anywhere without installing anything
    const engineVariant = STOCKFISH_THREADS > 1 ? "full" : "lite-single";
    console.log(`[worker] Stockfish: WASM/${engineVariant} threads=${STOCKFISH_THREADS} hash=${STOCKFISH_HASH_MB}MB movetime=${STOCKFISH_MOVETIME_MS}ms`);
    engine = await initEngine(engineVariant);

    // Restore fetch if Stockfish ASM nullified it
    if (_nativeFetch && typeof globalThis.fetch !== "function") {
      Object.defineProperty(globalThis, "fetch", {
        value: _nativeFetch,
        writable: true,
        configurable: true,
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Stockfish uciok timeout")), 30_000);
    engine.listener = (line: string) => {
      if (line === "uciok") { clearTimeout(timeout); resolve(); }
    };
    engine.sendCommand("uci");
  });

  engine.sendCommand(`setoption name Threads value ${STOCKFISH_THREADS}`);
  engine.sendCommand(`setoption name Hash value ${STOCKFISH_HASH_MB}`);
  engine.sendCommand("setoption name UCI_AnalyseMode value true");

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Stockfish readyok timeout")), 30_000);
    engine.listener = (line: string) => {
      if (line === "readyok") { clearTimeout(timeout); resolve(); }
    };
    engine.sendCommand("isready");
  });

  _sharedEngine = engine;
  return engine;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluatePosition — runs Stockfish MultiPV analysis on a FEN
// Returns top-2 moves with scores (side-to-move perspective).
// ─────────────────────────────────────────────────────────────────────────────
async function evaluatePosition(
  engine: StockfishEngine,
  fen: string,
  depth: number,
  multiPv: number,
  movetimeMs = 0  // when > 0, use movetime instead of depth (cluster mode)
): Promise<EvalResult> {
  return new Promise<EvalResult>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`evaluatePosition timeout for FEN: ${fen}`)),
      120_000
    );

    const pvBest = new Map<number, EvalLine>();
    let highestDepthSeen = 0;

    engine.listener = (line: string) => {
      if (line === "readyok") {
        engine.sendCommand(`position fen ${fen}`);
        const goCmd = movetimeMs > 0
          ? `go movetime ${movetimeMs}`
          : `go depth ${depth}`;
        engine.sendCommand(goCmd);
        return;
      }

      if (line.startsWith("info") && line.includes("multipv")) {
        const depthMatch = line.match(/\bdepth (\d+)\b/);
        const currentDepth = depthMatch ? parseInt(depthMatch[1], 10) : 0;
        const multipvMatch = line.match(/\bmultipv (\d+)\b/);
        const pvIndex = multipvMatch ? parseInt(multipvMatch[1], 10) : null;
        if (!pvIndex || pvIndex > multiPv) return;

        let score: number | null = null;
        const mateMatch = line.match(/\bscore mate (-?\d+)\b/);
        const cpMatch = line.match(/\bscore cp (-?\d+)\b/);
        if (mateMatch) {
          const mateIn = parseInt(mateMatch[1], 10);
          score = mateIn > 0 ? 100_000 - mateIn : -100_000 - mateIn;
        } else if (cpMatch) {
          score = parseInt(cpMatch[1], 10);
        }
        if (score === null) return;

        // Capture full PV line (up to 8 moves for refutation storage)
        const pvMatch = line.match(/\bpv (.+)$/);
        if (!pvMatch) return;
        const pv = pvMatch[1].trim().split(/\s+/).filter(Boolean).slice(0, 8);
        const move = pv[0];
        if (!move) return;

        if (currentDepth >= highestDepthSeen) {
          if (currentDepth > highestDepthSeen) highestDepthSeen = currentDepth;
          pvBest.set(pvIndex, { move, score, pv });
        }
      } else if (line.startsWith("bestmove")) {
        clearTimeout(timeout);
        if (pvBest.size === 0) {
          reject(new Error(`No eval data for FEN: ${fen.slice(0, 40)}`));
          return;
        }
        const best = pvBest.get(1);
        if (!best) { reject(new Error("Missing pvBest[1]")); return; }
        resolve({ best, second: pvBest.get(2) ?? null });
      }
    };

    engine.sendCommand(`setoption name MultiPV value ${multiPv}`);
    engine.sendCommand("isready");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// parsePgn — replay a PGN and return positions + sentinel final position.
// positions[i].fen = FEN BEFORE move i
// positions[N].fen = FEN AFTER last move (sentinel, movePlayed = "")
// ─────────────────────────────────────────────────────────────────────────────
function parsePgn(pgn: string): Position[] {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });
  const positions: Position[] = [];
  const replay = new Chess();

  for (const move of history) {
    positions.push({
      fen: replay.fen(),
      movePlayed: move.lan,
      san: move.san,
      moveNumber: replay.moveNumber(),
      turn: replay.turn(),
    });
    replay.move(move.san);
  }

  // Sentinel: FEN after the last move (needed to evaluate winAfter for the last move)
  positions.push({
    fen: replay.fen(),
    movePlayed: "",
    san: "",
    moveNumber: replay.moveNumber(),
    turn: replay.turn(),
  });

  return positions;
}

function uciToSan(fen: string, uciMove: string): string {
  const chess = new Chess(fen);
  const from = uciMove.slice(0, 2);
  const to = uciMove.slice(2, 4);
  const promotion = uciMove.length > 4 ? uciMove[4] : undefined;
  const result = chess.move({ from, to, promotion });
  if (!result) throw new Error(`Invalid UCI move ${uciMove} in position ${fen}`);
  return result.san;
}

function detectPhase(fen: string, moveNumber: number): PuzzlePhase {
  if (moveNumber <= 15) return "opening";
  const piecePlacement = fen.split(" ")[0];
  let pieceCount = 0;
  for (const ch of piecePlacement) {
    if (/[a-zA-Z]/.test(ch) && ch.toLowerCase() !== "k") pieceCount++;
  }
  if (pieceCount <= 7) return "endgame";
  return "middlegame";
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker
// ─────────────────────────────────────────────────────────────────────────────
const worker = new Worker<AnalyzeGameJobData, AnalyzeGameJobResult>(
  ANALYZE_QUEUE_NAME,
  async (job: Job<AnalyzeGameJobData>) => {
    const { gameId, userId, pgn, playerColor } = job.data;
    console.log(`[worker] Processing job ${job.id} — game ${gameId}`);
    await updateGameStatus(gameId, "processing");

    let engine: StockfishEngine | null = null;
    let puzzlesFound = 0;
    let puzzlesValidated = 0;

    try {
      // ── Step 1: Parse PGN ────────────────────────────────────────────────
      const positions = parsePgn(pgn);
      const moveCount = positions.length - 1; // last entry is the sentinel
      console.log(`[worker] ${moveCount} moves to evaluate for game ${gameId}`);

      // ── Step 2: Init Stockfish ──────────────────────────────────────────
      engine = await initStockfish();
      console.log(`[worker] Stockfish ready for game ${gameId}`);

      const config = {
        ...DEFAULT_VALIDATOR_CONFIG,
        ...(ENV_DEPTH !== null ? { analysisDepth: ENV_DEPTH } : {}),
      };
      const playerTurn = playerColor === "white" ? "w" : "b";

      // ── Step 3: Pre-evaluate ALL N+1 positions in one linear pass ───────
      //
      // Key insight: allEvals[i] = eval of positions[i].fen (before move i)
      //              allEvals[N] = eval of the sentinel FEN (after last move)
      //
      // For move i:
      //   evalBefore = allEvals[i]    (side-to-move = positions[i].turn)
      //   evalAfter  = allEvals[i+1]  (opponent to move → negate for player perspective)
      //
      // This gives us N+1 evals for N moves instead of 2N.
      const allEvals: (EvalResult | null)[] = new Array(positions.length).fill(null);

      for (let i = 0; i < positions.length; i++) {
        // Report progress 0-80% during eval pass
        await job.updateProgress(Math.round((i / positions.length) * 80));
        try {
          allEvals[i] = await evaluatePosition(
            engine,
            positions[i].fen,
            config.analysisDepth,
            config.multiPv,
            STOCKFISH_MOVETIME_MS
          );
        } catch (err) {
          console.warn(
            `[worker] eval[${i}] failed:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      // ── Step 4: Classify each move & store puzzles ────────
      for (let i = 0; i < moveCount; i++) {
        const pos = positions[i];
        const evalBefore = allEvals[i];
        const evalAfter = allEvals[i + 1];

        if (!evalBefore || !evalAfter || !pos.movePlayed) continue;

        // winBest / winAfter — standard win% from side-to-move perspective
        const winBest = winChances(evalBefore.best.score);
        const winAfter = winChances(-evalAfter.best.score);

        const playedBest = pos.movePlayed === evalBefore.best.move;

        // Classify with mate-aware logic (avoids under-classifying blunders when
        // the player is already losing and gives the opponent a forced mate).
        const baseClass = classifyMoveWithMates(
          evalBefore.best.score,
          evalAfter.best.score,
          playedBest,
        );
        const miss = isMissedWin(winBest, winAfter) && baseClass !== "blunder";

        // ── Step 5: Create SRS puzzles (player turns only) ───────────────
        if (pos.turn !== playerTurn) continue;

        const isBlunder = baseClass === "blunder";
        const isPuzzleMiss = miss;

        if (!isBlunder && !isPuzzleMiss) continue;

        // Skip puzzles from already-hopeless positions.
        // If the player had < 15% win chance before the move, the game was
        // already decided — training on these doesn't build useful pattern memory.
        const MIN_WIN_CHANCE_FOR_PUZZLE = 0.15; // 15%
        if (winBest < MIN_WIN_CHANCE_FOR_PUZZLE) continue;

        // For blunders: enforce Only-Winning-Move rule (gap between best and 2nd-best)
        if (isBlunder && evalBefore.second !== null) {
          const solutionGap = evalBefore.best.score - evalBefore.second.score;
          if (solutionGap < config.minSolutionGap) continue;
        }

        let solutionSan: string;
        let solutionLineSan: string[];
        let validPvLine: string[];
        try {
          // Verify that the PV line is actually forced
          validPvLine = await validatePuzzleLine(
            engine,
            pos.fen,
            evalBefore.best.pv,
            config.analysisDepth,
            config.minSolutionGap
          );
          if (validPvLine.length < 1) continue;

          solutionSan = uciToSan(pos.fen, validPvLine[0]);
          solutionLineSan = pvToSan(pos.fen, validPvLine);
        } catch (err) {
          console.warn(`[worker] uciToSan failed at ply ${i + 1}:`, err instanceof Error ? err.message : err);
          continue;
        }

        const phase = detectPhase(pos.fen, pos.moveNumber);
        const evalDrop = Math.round((winBest - winAfter) * 1000);

        const puzzle: Omit<Puzzle, "id" | "created_at"> = {
          game_id: gameId,
          user_id: userId,
          fen: pos.fen,
          blunder_move: pos.movePlayed,
          solution_move: validPvLine[0],
          solution_san: solutionSan,
          solution_line_uci: validPvLine,
          solution_line_san: solutionLineSan,
          is_brilliant: false,
          eval_before: Math.round(winBest * 10000),
          eval_after: Math.round(winAfter * 10000),
          eval_best: evalBefore.best.score,
          eval_second_best: evalBefore.second?.score ?? null,
          eval_drop: evalDrop,
          move_number: pos.moveNumber,
          player_color: playerColor,
          phase,
          status: "pending",
          times_seen: 0,
          times_correct: 0,
          srs_due_at: null,
          srs_ease: 2.5,
          last_reviewed_at: null,
        };

        puzzlesFound++;

        if (!supabase) {
          console.warn("[worker] No Supabase — skipping puzzle insert");
          puzzlesValidated++;
          continue;
        }

        const { error: insertError } = await supabase.from("puzzles").insert(puzzle);
        if (insertError) {
          console.error(
            `[worker] Puzzle insert failed at ply ${i + 1}:`,
            insertError.message
          );
        } else {
          puzzlesValidated++;
          console.log(
            `[worker] ${isBlunder ? "Blunder" : "Miss"} puzzle at ply ${i + 1} (drop=${evalDrop})`
          );
        }
      }

      await updateGameStatus(gameId, "analyzed");
      await job.updateProgress(100);

      console.log(
        `[worker] Job ${job.id} complete — ` +
        `${puzzlesFound} puzzles found, ${puzzlesValidated} stored`
      );

      return { gameId, puzzlesFound, puzzlesValidated };

    } catch (err) {
      await updateGameStatus(gameId, "failed");
      throw err;
    } finally {
      // Do NOT destroy the engine — singleton reused across all jobs.
      engine = null;
    }
  },
  {
    connection: redisConnection,
    concurrency: 1,        // Singleton Stockfish engine
    lockDuration: 10 * 60 * 1000,
    maxStalledCount: 3,
  }
);

// ── Lifecycle events ──────────────────────────────────────────────
worker.on("completed", (job, result: AnalyzeGameJobResult) => {
  console.log(
    `[worker] ✓ Job ${job.id} | game ${result.gameId} | ` +
    `${result.puzzlesFound} found / ${result.puzzlesValidated} validated`
  );
});

worker.on("failed", (job, err) => {
  if (job?.data?.gameId) void updateGameStatus(job.data.gameId, "failed");
  console.error(`[worker] ✗ Job ${job?.id} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("[worker] Redis/BullMQ error:", err.message);
});

console.log(`[worker] Started — listening on queue "${ANALYZE_QUEUE_NAME}"`);
