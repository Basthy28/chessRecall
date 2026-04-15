"use client";

/**
 * useGameAnalysis — background full-game WASM analysis.
 *
 * Runs a separate Stockfish worker that evaluates every position in the game
 * sequentially at a WintrChess-like depth. Produces:
 *   - stable per-position snapshots (score + top 2 engine choices)
 *   - per-move classifications aligned with the shared review reporter
 *   - per-player accuracies using the WintrChess/Lichess formula
 */

import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";

import type { MoveClassification } from "@/lib/analysis";
import {
  classifyReviewedMove,
  getMoveAccuracyFromScores,
  type PositionEvaluationSnapshot,
} from "@/lib/reviewReporter";

const BG_ENGINE_BASE_URL = "https://r2.chessrecall.qzz.io/stockfish";
const BG_ENGINE_URL = `${BG_ENGINE_BASE_URL}/stockfish-18-single.js`;
const BG_REMOTE_WASM_URL = "https://r2.chessrecall.qzz.io/stockfish/stockfish-18-single.wasm";
const BG_DEPTH = Math.max(10, Number(process.env.NEXT_PUBLIC_ANALYSIS_DEPTH ?? 16));
const BG_MULTI_PV = 2;
const BG_TIMEOUT_MS = 16_000;

async function createBackgroundWorker(): Promise<{ worker: Worker; blobUrl: string }> {
  const response = await fetch(BG_ENGINE_URL, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    cache: "default",
  });
  if (!response.ok) {
    throw new Error(`Background engine bootstrap fetch failed (${response.status})`);
  }

  const source = await response.text();
  const blob = new Blob([source], {
    type: "application/javascript; charset=utf-8",
  });
  const blobUrl = URL.createObjectURL(blob);
  const worker = new Worker(
    `${blobUrl}#${encodeURIComponent(BG_REMOTE_WASM_URL)},worker`,
  );

  return { worker, blobUrl };
}

export interface MoveAnalysis {
  ply: number;
  san: string;
  turn: "w" | "b";
  classification: MoveClassification;
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
  progress: number;
  moves: MoveAnalysis[];
  stats: GameStats | null;
  positionEvals: (number | null)[];
  snapshots: PositionEvaluationSnapshot[];
}

const REPORT_CLASSIFICATION_ORDER: MoveClassification[] = [
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "inaccuracy",
  "mistake",
  "blunder",
  "book",
];

function buildGameStats(analyses: MoveAnalysis[]): GameStats {
  const whiteMoves = analyses.filter((move) => move.turn === "w");
  const blackMoves = analyses.filter((move) => move.turn === "b");
  const whiteAccuracy = whiteMoves.length > 0
    ? whiteMoves.reduce((sum, move) => sum + move.accuracy, 0) / whiteMoves.length
    : 0;
  const blackAccuracy = blackMoves.length > 0
    ? blackMoves.reduce((sum, move) => sum + move.accuracy, 0) / blackMoves.length
    : 0;

  return {
    whiteAccuracy: Math.round(whiteAccuracy * 10) / 10,
    blackAccuracy: Math.round(blackAccuracy * 10) / 10,
    breakdown: REPORT_CLASSIFICATION_ORDER.map((classification) => ({
      classification,
      white: whiteMoves.filter((move) => move.classification === classification).length,
      black: blackMoves.filter((move) => move.classification === classification).length,
    })),
    estimatedWhiteElo: null,
    estimatedBlackElo: null,
  };
}

function parseScore(line: string): number | null {
  const mateMatch = line.match(/\bscore mate (-?\d+)\b/);
  if (mateMatch) {
    const mate = parseInt(mateMatch[1], 10);
    return mate > 0 ? 100_000 - mate : -100_000 - mate;
  }
  const cpMatch = line.match(/\bscore cp (-?\d+)\b/);
  return cpMatch ? parseInt(cpMatch[1], 10) : null;
}

function normaliseScore(raw: number, turn: "w" | "b"): number {
  return turn === "w" ? raw : -raw;
}

function terminalSnapshot(fen: string): PositionEvaluationSnapshot {
  try {
    const board = new Chess(fen);
    if (board.moves().length > 0) {
      return { fen, score: null, depth: 0 };
    }
    if (board.isCheckmate()) {
      return { fen, score: board.turn() === "w" ? -99_999 : 99_999, depth: 0 };
    }
    return { fen, score: 0, depth: 0 };
  } catch {
    return { fen, score: null, depth: 0 };
  }
}

function resolvePlayedUci(
  fen: string,
  move: { san: string; from?: string; to?: string },
): string | null {
  if (move.from && move.to) return `${move.from}${move.to}`;

  try {
    const board = new Chess(fen);
    const played = board.move(move.san);
    if (!played) return null;
    const promotion = played.promotion ?? "";
    return `${played.from}${played.to}${promotion}`;
  } catch {
    return null;
  }
}

export function useGameAnalysis(
  positions: string[],
  moves: Array<{ san: string; ply: number; from?: string; to?: string }>,
  enabled = true,
): GameAnalysisResult {
  const workerRef = useRef<Worker | null>(null);
  const workerBlobUrlRef = useRef<string | null>(null);
  const cancelRef = useRef(false);

  const [workerReady, setWorkerReady] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [moveAnalyses, setMoveAnalyses] = useState<MoveAnalysis[]>([]);
  const [stats, setStats] = useState<GameStats | null>(null);
  const [snapshots, setSnapshots] = useState<PositionEvaluationSnapshot[]>([]);

  const revokeWorkerBlobUrl = () => {
    if (workerBlobUrlRef.current) {
      URL.revokeObjectURL(workerBlobUrlRef.current);
      workerBlobUrlRef.current = null;
    }
  };

  useEffect(() => {
    if (!enabled || typeof Worker === "undefined") return;

    cancelRef.current = false;

    void (async () => {
      try {
        const created = await createBackgroundWorker();
        if (cancelRef.current) {
          created.worker.terminate();
          URL.revokeObjectURL(created.blobUrl);
          return;
        }

        const worker = created.worker;
        workerRef.current = worker;
        workerBlobUrlRef.current = created.blobUrl;

        worker.onmessage = (e: MessageEvent<string>) => {
          const line = typeof e.data === "string" ? e.data : "";
          if (line === "uciok") {
            worker.postMessage("setoption name Threads value 1");
            worker.postMessage("setoption name Hash value 64");
            worker.postMessage(`setoption name MultiPV value ${BG_MULTI_PV}`);
            worker.postMessage("setoption name UCI_AnalyseMode value true");
            worker.postMessage("isready");
          } else if (line === "readyok") {
            worker.onmessage = null;
            setWorkerReady(true);
          }
        };

        worker.onerror = () => {
          console.warn("[useGameAnalysis] background engine failed to start");
          setWorkerReady(false);
        };

        worker.postMessage("uci");
      } catch {
        console.warn("[useGameAnalysis] background engine bootstrap failed");
        setWorkerReady(false);
      }
    })();

    return () => {
      cancelRef.current = true;
      if (workerRef.current) {
        workerRef.current.postMessage("stop");
        workerRef.current.postMessage("quit");
        workerRef.current.terminate();
        workerRef.current = null;
      }
      revokeWorkerBlobUrl();
    };
  }, [enabled]);

  useEffect(() => {
    if (!workerReady || !enabled || positions.length < 2 || moves.length === 0) return;

    let cancelled = false;

    function evalPosition(fen: string): Promise<PositionEvaluationSnapshot> {
      return new Promise((resolve) => {
        const worker = workerRef.current;
        if (!worker) {
          resolve(terminalSnapshot(fen));
          return;
        }

        const fallback = terminalSnapshot(fen);
        if (fallback.score !== null && fallback.depth === 0) {
          resolve(fallback);
          return;
        }

        let bestDepth = 0;
        const scores = new Map<number, number>();
        const topMoves = new Map<number, string>();

        const timeout = window.setTimeout(() => {
          worker.onmessage = null;
          resolve({
            fen,
            score: scores.has(1) ? scores.get(1)! : fallback.score,
            depth: bestDepth,
            topMove: topMoves.get(1),
            secondScore: scores.get(2),
          });
        }, BG_TIMEOUT_MS);

        worker.onmessage = (e: MessageEvent<string>) => {
          const line = typeof e.data === "string" ? e.data : "";

          if (line.startsWith("info") && line.includes("multipv")) {
            const depthMatch = line.match(/\bdepth (\d+)\b/);
            const mpvMatch = line.match(/\bmultipv (\d+)\b/);
            const pvMatch = line.match(/\bpv (.+)$/);
            const score = parseScore(line);
            const rawDepth = depthMatch ? parseInt(depthMatch[1], 10) : 0;
            const pvIndex = mpvMatch ? parseInt(mpvMatch[1], 10) : 0;

            if (!pvMatch || score === null || pvIndex < 1 || pvIndex > BG_MULTI_PV) return;
            if (rawDepth < bestDepth) return;

            if (rawDepth > bestDepth) {
              bestDepth = rawDepth;
              scores.clear();
              topMoves.clear();
            }

            try {
              const turn = new Chess(fen).turn();
              scores.set(pvIndex, normaliseScore(score, turn));
              topMoves.set(pvIndex, pvMatch[1].trim().split(/\s+/)[0]);
            } catch {
              scores.set(pvIndex, score);
              topMoves.set(pvIndex, pvMatch[1].trim().split(/\s+/)[0]);
            }
            return;
          }

          if (!line.startsWith("bestmove")) return;

          window.clearTimeout(timeout);
          worker.onmessage = null;
          resolve({
            fen,
            score: scores.has(1) ? scores.get(1)! : fallback.score,
            depth: bestDepth,
            topMove: topMoves.get(1),
            secondScore: scores.get(2),
          });
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
      setSnapshots([]);

      try {
        const total = positions.length;
        const nextSnapshots: PositionEvaluationSnapshot[] = new Array(total)
          .fill(null)
          .map((_, index) => ({ fen: positions[index], score: null, depth: 0 }));

        for (let i = 0; i < total; i++) {
          if (cancelled || cancelRef.current) break;

          nextSnapshots[i] = await evalPosition(positions[i]);

          if (!cancelled) {
            setProgress(Math.round(((i + 1) / total) * 100));
            setSnapshots([...nextSnapshots]);
          }
        }

        if (cancelled || cancelRef.current) {
          return;
        }

        const analyses: MoveAnalysis[] = [];
        for (let i = 0; i < moves.length; i++) {
          const previous = nextSnapshots[i];
          const current = nextSnapshots[i + 1];
          if (previous.score === null || current.score === null) continue;

          try {
            const playedUci = resolvePlayedUci(positions[i], moves[i]);
            if (!playedUci) continue;

            let turn: "w" | "b" = "w";
            try {
              turn = new Chess(positions[i]).turn();
            } catch {
              // Use white as a stable fallback if the FEN is malformed.
            }

            const classification = classifyReviewedMove({
              parentFen: positions[i],
              currentFen: positions[i + 1],
              playedUci,
              previous,
              current,
            });
            if (!classification) continue;

            const accuracy = getMoveAccuracyFromScores(previous.score, current.score, turn);
            analyses.push({
              ply: moves[i].ply,
              san: moves[i].san,
              turn,
              classification,
              accuracy,
            });
          } catch (error) {
            console.warn("[useGameAnalysis] skipped move during report build", {
              ply: moves[i]?.ply,
              fen: positions[i],
              error,
            });
          }
        }

        if (!cancelled) {
          setMoveAnalyses(analyses);
          setSnapshots([...nextSnapshots]);
          setStats(buildGameStats(analyses));
          setProgress(100);
        }
      } catch (error) {
        console.warn("[useGameAnalysis] report generation failed", error);
        if (!cancelled) {
          setMoveAnalyses([]);
          setStats(buildGameStats([]));
        }
      } finally {
        if (!cancelled) {
          setIsAnalyzing(false);
        }
      }
    }

    void analyze();
    return () => {
      cancelled = true;
    };
  }, [workerReady, enabled, positions, moves]);

  return {
    isAnalyzing,
    progress,
    moves: moveAnalyses,
    stats,
    positionEvals: snapshots.map((snapshot) => snapshot.score),
    snapshots,
  };
}
