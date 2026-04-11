"use client";

/**
 * useGameAnalysis — background full-game WASM analysis.
 *
 * Runs a separate Stockfish worker (single-threaded, depth 14) that evaluates
 * every position in the game sequentially. Produces per-move classifications,
 * per-player accuracy scores, and a breakdown table — all computed client-side
 * without any DB writes.
 *
 * Design notes:
 *   - Uses its own Worker instance, separate from useLiveAnalysis.
 *   - Positions are evaluated sequentially (one at a time) to avoid racing.
 *   - The hook cancels in-progress analysis on unmount or when inputs change.
 */

import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { classifyMove, getExpectedPointsLoss, isSacrificeMove } from "@/lib/analysis";
import type { MoveClassification } from "@/lib/analysis";
import { isBookPosition } from "@/lib/ecoBook";

// ── Config ─────────────────────────────────────────────────────────────────────
const BG_ENGINE_URL = "/stockfish/stockfish-18-single.js";
/** Depth for background analysis — enough for accurate classification. */
const BG_DEPTH = 14;
/** Per-position timeout — failsafe for stalled engine. */
const BG_TIMEOUT_MS = 12_000;

// ── Types ──────────────────────────────────────────────────────────────────────
export interface MoveAnalysis {
  ply: number;
  san: string;
  turn: "w" | "b";
  classification: MoveClassification;
  /** Lichess accuracy formula: 0–100 */
  accuracy: number;
}

export interface GameStats {
  whiteAccuracy: number;
  blackAccuracy: number;
  breakdown: Array<{
    classification: MoveClassification;
    white: number;
    black: number;
  }>;
  estimatedWhiteElo: number | null;
  estimatedBlackElo: number | null;
}

export interface GameAnalysisResult {
  isAnalyzing: boolean;
  /** 0–100 during analysis, 100 when complete */
  progress: number;
  moves: MoveAnalysis[];
  stats: GameStats | null;
  /** White-POV centipawn eval for each position (index 0 = start, index N = after move N-1) */
  positionEvals: (number | null)[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** WintrChess / Lichess accuracy formula. pointLoss is in [0, 1]. */
function moveAccuracy(pointLoss: number): number {
  return Math.max(0, Math.min(100, 103.16 * Math.exp(-4 * pointLoss) - 3.17));
}

/** Simple accuracy → Elo lookup based on empirical data. */
function accuracyToElo(accuracy: number): number {
  if (accuracy >= 98) return 2800;
  if (accuracy >= 95) return 2500;
  if (accuracy >= 90) return 2200;
  if (accuracy >= 85) return 1900;
  if (accuracy >= 80) return 1700;
  if (accuracy >= 75) return 1500;
  if (accuracy >= 70) return 1300;
  if (accuracy >= 65) return 1100;
  if (accuracy >= 60) return 1000;
  return 900;
}

function parseScore(line: string): number | null {
  const mateMatch = line.match(/\bscore mate (-?\d+)\b/);
  if (mateMatch) {
    const m = parseInt(mateMatch[1], 10);
    return m > 0 ? 100_000 - m : -100_000 - m;
  }
  const cpMatch = line.match(/\bscore cp (-?\d+)\b/);
  return cpMatch ? parseInt(cpMatch[1], 10) : null;
}

// ── Hook ───────────────────────────────────────────────────────────────────────
/**
 * @param positions  Array of FEN strings: positions[0] = start, positions[N] = after move N-1.
 *                   Length must be moves.length + 1.
 * @param moves      Array of { san, ply } for each move.
 * @param enabled    Set to false to skip analysis (e.g. when the view is not visible).
 */
export function useGameAnalysis(
  positions: string[],
  moves: Array<{ san: string; ply: number; from?: string; to?: string }>,
  enabled = true,
): GameAnalysisResult {
  const workerRef  = useRef<Worker | null>(null);
  const cancelRef  = useRef(false);

  const [workerReady,  setWorkerReady]  = useState(false);
  const [isAnalyzing,  setIsAnalyzing]  = useState(false);
  const [progress,     setProgress]     = useState(0);
  const [moveAnalyses, setMoveAnalyses] = useState<MoveAnalysis[]>([]);
  const [stats,        setStats]        = useState<GameStats | null>(null);
  const [positionEvals, setPositionEvals] = useState<(number | null)[]>([]);

  // ── Boot the background engine ────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || typeof Worker === "undefined") return;

    cancelRef.current = false;
    setWorkerReady(false);

    const worker = new Worker(BG_ENGINE_URL);
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<string>) => {
      const line = typeof e.data === "string" ? e.data : "";
      if (line === "uciok") {
        // Single thread + small hash to minimise competition with live analysis
        worker.postMessage("setoption name Threads value 1");
        worker.postMessage("setoption name Hash value 64");
        worker.postMessage("setoption name UCI_AnalyseMode value true");
        worker.postMessage("isready");
      } else if (line === "readyok") {
        worker.onmessage = null; // hand off control to evalPosition
        setWorkerReady(true);
      }
    };

    worker.onerror = () => {
      console.warn("[useGameAnalysis] background engine failed to start");
      setWorkerReady(false);
    };

    worker.postMessage("uci");

    return () => {
      cancelRef.current = true;
      worker.postMessage("stop");
      worker.postMessage("quit");
      worker.terminate();
      workerRef.current = null;
    };
  }, [enabled]);

  // ── Run analysis once the engine is ready ─────────────────────────────────
  useEffect(() => {
    if (!workerReady || !enabled || positions.length < 2 || moves.length === 0) return;

    let cancelled = false;

    /** Evaluates a single FEN, returns side-to-move score or null on error/timeout. */
    function evalPosition(fen: string): Promise<number | null> {
      return new Promise((resolve) => {
        const worker = workerRef.current;
        if (!worker) { resolve(null); return; }

        const timeout = setTimeout(() => {
          worker.onmessage = null;
          resolve(null);
        }, BG_TIMEOUT_MS);

        let bestScore: number | null = null;
        let highestDepth = 0;

        worker.onmessage = (e: MessageEvent<string>) => {
          const line = typeof e.data === "string" ? e.data : "";
          if (line.startsWith("info") && line.includes("depth")) {
            const dm = line.match(/\bdepth (\d+)\b/);
            const d  = dm ? parseInt(dm[1], 10) : 0;
            if (d >= highestDepth) {
              const s = parseScore(line);
              if (s !== null) { highestDepth = d; bestScore = s; }
            }
          } else if (line.startsWith("bestmove")) {
            clearTimeout(timeout);
            worker.onmessage = null;
            resolve(bestScore);
          }
        };

        worker.postMessage("ucinewgame");
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage(`go depth ${BG_DEPTH}`);
      });
    }

    async function analyze() {
      setIsAnalyzing(true);
      setProgress(0);
      setMoveAnalyses([]);
      setStats(null);
      setPositionEvals([]);

      // Evaluate all N+1 positions (before each move + final position)
      const total = positions.length;
      const evals: (number | null)[] = new Array(total).fill(null);

      for (let i = 0; i < total; i++) {
        if (cancelled || cancelRef.current) break;

        const rawScore = await evalPosition(positions[i]);
        if (rawScore !== null) {
          // Convert side-to-move score → white's POV
          try {
            const turn = new Chess(positions[i]).turn();
            evals[i] = turn === "w" ? rawScore : -rawScore;
          } catch {
            evals[i] = rawScore;
          }
        }

        if (!cancelled) {
          setProgress(Math.round(((i + 1) / total) * 100));
          setPositionEvals([...evals]);
        }
      }

      if (cancelled || cancelRef.current) {
        setIsAnalyzing(false);
        return;
      }

      // Classify each move
      const analyses: MoveAnalysis[] = [];
      for (let i = 0; i < moves.length; i++) {
        const evalBefore = evals[i];
        const evalAfter  = evals[i + 1];
        if (evalBefore === null || evalAfter === null) continue;

        let turn: "w" | "b" = "w";
        try { turn = new Chess(positions[i]).turn(); } catch { /* skip */ }

        // Book move: if the destination position is in the ECO database
        if (isBookPosition(positions[i + 1])) {
          analyses.push({ ply: moves[i].ply, san: moves[i].san, turn, classification: "book", accuracy: 100 });
          continue;
        }

        // Forced move + sacrifice detection
        let legalMoveCount: number | undefined;
        let sacrifice = false;
        try {
          const board = new Chess(positions[i]);
          legalMoveCount = board.moves().length;
        } catch { /* ignore */ }
        const uci = moves[i].from != null && moves[i].to != null ? moves[i].from! + moves[i].to! : null;
        if (uci && legalMoveCount !== 1) {
          sacrifice = isSacrificeMove(positions[i], uci);
        }

        const classification = classifyMove(evalBefore, evalAfter, turn, sacrifice, legalMoveCount);
        const pointLoss      = getExpectedPointsLoss(evalBefore, evalAfter, turn);
        const accuracy       = moveAccuracy(pointLoss);

        analyses.push({ ply: moves[i].ply, san: moves[i].san, turn, classification, accuracy });
      }

      if (!cancelled) {
        setMoveAnalyses(analyses);
        setPositionEvals(evals);
      }

      // Aggregate stats
      const wMoves = analyses.filter(m => m.turn === "w");
      const bMoves = analyses.filter(m => m.turn === "b");
      const wAcc = wMoves.length > 0
        ? wMoves.reduce((s, m) => s + m.accuracy, 0) / wMoves.length : 0;
      const bAcc = bMoves.length > 0
        ? bMoves.reduce((s, m) => s + m.accuracy, 0) / bMoves.length : 0;

      // WintrChess display order (Critical/great requires multi-PV; background analysis shows 0)
      const CLS_ORDER: MoveClassification[] = [
        "brilliant", "great", "best", "excellent", "good", "inaccuracy", "mistake", "blunder", "book",
      ];
      const breakdown = CLS_ORDER.map(cls => ({
        classification: cls,
        white: wMoves.filter(m => m.classification === cls).length,
        black: bMoves.filter(m => m.classification === cls).length,
      }));

      if (!cancelled) {
        setStats({
          whiteAccuracy:      Math.round(wAcc * 10) / 10,
          blackAccuracy:      Math.round(bAcc * 10) / 10,
          breakdown,
          estimatedWhiteElo:  accuracyToElo(wAcc),
          estimatedBlackElo:  accuracyToElo(bAcc),
        });
        setIsAnalyzing(false);
        setProgress(100);
      }
    }

    void analyze();
    return () => { cancelled = true; };
  // positions and moves are stable per-game (ReviewView remounts for each game)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerReady, enabled]);

  return { isAnalyzing, progress, moves: moveAnalyses, stats, positionEvals };
}
