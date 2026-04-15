"use client";

/**
 * useLiveAnalysis — shared browser-side Stockfish 18 WASM analysis hook.
 *
 * Adapted from the WintrChess realtime engine pattern:
 *   - analysis is depth-driven by default (instead of movetime-driven)
 *   - we keep only the deepest consistent MultiPV set
 *   - positions are queued/debounced and an active search is stopped before a new one
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";

// ── Engine config ──────────────────────────────────────────────────────────────
const ANALYSIS_ENGINE_BASE_URL = "https://r2.chessrecall.qzz.io/stockfish";
const ANALYSIS_ENGINE_URL = `${ANALYSIS_ENGINE_BASE_URL}/stockfish-18-single.js`;
const ANALYSIS_WASM_URL = `${ANALYSIS_ENGINE_BASE_URL}/stockfish-18-single.wasm`;
const ANALYSIS_MULTI_PV = Math.max(
  1,
  Math.min(5, Number(process.env.NEXT_PUBLIC_ANALYSIS_MULTI_PV ?? 2)),
);
const ANALYSIS_DEBOUNCE_MS = 150;
export const LIVE_ANALYSIS_DEPTH = Math.max(
  10,
  Number(process.env.NEXT_PUBLIC_ANALYSIS_DEPTH ?? 16),
);
const ANALYSIS_TIMEOUT_MS = Math.max(
  12_000,
  Number(process.env.NEXT_PUBLIC_ANALYSIS_TIMEOUT_MS ?? 18_000),
);

// ── Types ──────────────────────────────────────────────────────────────────────
export interface AnalysisLine {
  /** first UCI move of this PV */
  move: string;
  /** first move in SAN */
  san: string;
  /** eval in centipawns, always from White's perspective */
  score: number;
  /** SAN preview string of the full PV (e.g. "1. Nf6 d4 2. Nc6") */
  pv: string;
  /** full PV in UCI */
  pvUci: string[];
  /** multipv index (1 = best) */
  index: number;
}

export interface LiveAnalysisResult {
  lines: AnalysisLine[];
  /** current search depth */
  depth: number;
  /** true while engine is actively searching */
  isSearching: boolean;
  /** non-empty string when an error occurred */
  error: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getThreadCount(): number {
  if (typeof navigator === "undefined") return 2;
  const hw = typeof navigator.hardwareConcurrency === "number"
    ? Math.floor(navigator.hardwareConcurrency) : 8;
  return Math.max(2, Math.min(24, hw - 1));
}

function getHashMb(threads: number): number {
  return Math.max(128, Math.min(1024, threads * 32));
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

function normalisedScore(raw: number, turn: "w" | "b"): number {
  return turn === "w" ? raw : -raw;
}

function uciToSanSafe(fen: string, uci: string): string {
  try {
    const chess = new Chess(fen);
    const from = uci.slice(0, 2);
    const to   = uci.slice(2, 4);
    const m = uci.length > 4
      ? chess.move({ from, to, promotion: uci[4] })
      : chess.move({ from, to });
    return m?.san ?? uci;
  } catch {
    return uci;
  }
}

function pvToSanPreview(fen: string, pvLine: string, maxPlies = 10): string {
  const chess = new Chess(fen);
  const moves = pvLine.trim().split(/\s+/).filter(Boolean);
  const parts: string[] = [];

  for (let i = 0; i < moves.length && parts.length < maxPlies; i++) {
    const mn  = chess.moveNumber();
    const turn = chess.turn();
    let m: ReturnType<typeof chess.move> | null = null;
    try {
      const from = moves[i].slice(0, 2);
      const to   = moves[i].slice(2, 4);
      m = moves[i].length > 4
        ? chess.move({ from, to, promotion: moves[i][4] })
        : chess.move({ from, to });
    } catch { break; }
    if (!m) break;
    parts.push(turn === "w" ? `${mn}. ${m.san}` : `${mn}... ${m.san}`);
  }

  return parts.join(" ");
}

async function createAnalysisWorker(): Promise<{ worker: Worker; blobUrl: string }> {
  const response = await fetch(ANALYSIS_ENGINE_URL, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    cache: "default",
  });
  if (!response.ok) {
    throw new Error(`Engine bootstrap fetch failed (${response.status})`);
  }

  const source = await response.text();
  const blob = new Blob([source], {
    type: "application/javascript; charset=utf-8",
  });
  const blobUrl = URL.createObjectURL(blob);
  const worker = new Worker(
    `${blobUrl}#${encodeURIComponent(ANALYSIS_WASM_URL)},worker`,
  );

  return { worker, blobUrl };
}

// ── Hook ───────────────────────────────────────────────────────────────────────
/**
 * @param fen - the current board position to analyse (changes trigger a new search)
 * @param enabled - set to false to skip analysis (e.g. when the view is hidden)
 */
export function useLiveAnalysis(fen: string, enabled = true): LiveAnalysisResult {
  const workerRef     = useRef<Worker | null>(null);
  const workerBlobUrlRef = useRef<string | null>(null);
  const readyRef      = useRef(false);
  const debounceRef   = useRef<number | null>(null);
  const timeoutRef    = useRef<number | null>(null);
  const requestIdRef  = useRef(0);

  // Per-request accumulation
  const activeRef = useRef<{
    id: number; fen: string; turn: "w" | "b";
    bestDepth: number; pvByIndex: Map<number, AnalysisLine>;
  } | null>(null);
  const queuedRef = useRef<typeof activeRef.current>(null);

  const [lines,       setLines]       = useState<AnalysisLine[]>([]);
  const [depth,       setDepth]       = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [error,       setError]       = useState("");

  const revokeWorkerBlobUrl = useCallback(() => {
    if (workerBlobUrlRef.current) {
      URL.revokeObjectURL(workerBlobUrlRef.current);
      workerBlobUrlRef.current = null;
    }
  }, []);

  // ── Clear timeout helper ─────────────────────────────────────────────────
  const clearTimeout_ = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // ── Publish accumulated lines to state ──────────────────────────────────
  const publish = useCallback(
    (pending: NonNullable<typeof activeRef.current>) => {
      const sorted = Array.from(pending.pvByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, line]) => line);
      if (sorted.length === 0) return;
      setLines(sorted);
      setDepth(pending.bestDepth);
    },
    [],
  );

  // ── Start next queued search (if any) ───────────────────────────────────
  const startQueued = useCallback(() => {
    const worker = workerRef.current;
    const queued = queuedRef.current;
    if (!worker || !readyRef.current || !queued || activeRef.current) return;

    queuedRef.current = null;
    activeRef.current = queued;
    setIsSearching(true);

    clearTimeout_();
    timeoutRef.current = window.setTimeout(() => {
      if (activeRef.current?.id !== queued.id) return;
      worker.postMessage("stop");
      setError("Analysis timed out — move to retry.");
      setIsSearching(false);
    }, ANALYSIS_TIMEOUT_MS);

    worker.postMessage("ucinewgame");
    worker.postMessage(`setoption name MultiPV value ${ANALYSIS_MULTI_PV}`);
    worker.postMessage(`position fen ${queued.fen}`);
      worker.postMessage(`go depth ${LIVE_ANALYSIS_DEPTH}`);
  }, [clearTimeout_]);

  // ── Boot the Web Worker ──────────────────────────────────────────────────
  const bootWorker = useCallback(async () => {
    if (typeof Worker === "undefined") {
      setError("Web Workers unavailable in this environment.");
      setIsSearching(false);
      return;
    }

    workerRef.current?.terminate();
    workerRef.current = null;
    revokeWorkerBlobUrl();
    readyRef.current  = false;
    activeRef.current = null;
    clearTimeout_();

    let worker: Worker;
    try {
      const created = await createAnalysisWorker();
      worker = created.worker;
      workerBlobUrlRef.current = created.blobUrl;
      workerRef.current = worker;
    } catch {
      setIsSearching(false);
      setError("Engine bootstrap failed — remote Stockfish unavailable.");
      return;
    }

    worker.onmessage = (e: MessageEvent<string>) => {
      const line = typeof e.data === "string" ? e.data : "";
      if (!line) return;

      // ── Init handshake ──────────────────────────────────────────────
      if (!readyRef.current) {
        if (line === "uciok") {
          const threads = getThreadCount();
          const hash    = getHashMb(threads);
          worker.postMessage("setoption name UCI_AnalyseMode value true");
          worker.postMessage(`setoption name Threads value ${threads}`);
          worker.postMessage(`setoption name Hash value ${hash}`);
          worker.postMessage("isready");
          return;
        }
        if (line === "readyok") {
          readyRef.current = true;
          startQueued();
        }
        return;
      }

      const pending = activeRef.current;
      if (!pending) return;

      // ── Progressive info lines ──────────────────────────────────────
      if (line.startsWith("info") && line.includes("multipv")) {
        const depthMatch   = line.match(/\bdepth (\d+)\b/);
        const firstMatch   = line.match(/\bpv (\S+)/);
        const pvMatch      = line.match(/\bpv (.+)$/);
        const mpvMatch     = line.match(/\bmultipv (\d+)\b/);
        const rawDepth     = depthMatch  ? parseInt(depthMatch[1],  10) : 0;
        const pvIndex      = mpvMatch    ? parseInt(mpvMatch[1],    10) : 0;
        const rawScore     = parseScore(line);

        if (!firstMatch || !pvMatch || !pvIndex || pvIndex > ANALYSIS_MULTI_PV || rawScore === null) return;
        if (rawDepth < pending.bestDepth) return;

        if (rawDepth > pending.bestDepth) {
          pending.bestDepth = rawDepth;
          pending.pvByIndex.clear();
        }

        try {
          const pvUci  = pvMatch[1].trim().split(/\s+/).filter(Boolean);
          const score  = normalisedScore(rawScore, pending.turn);
          const newLine: AnalysisLine = {
            move:  firstMatch[1],
            san:   uciToSanSafe(pending.fen, firstMatch[1]),
            score,
            pv:    pvToSanPreview(pending.fen, pvMatch[1]),
            pvUci,
            index: pvIndex,
          };
          pending.pvByIndex.set(pvIndex, newLine);
        } catch { return; }

        if (pending.id === requestIdRef.current) publish(pending);
        return;
      }

      // ── Search complete ─────────────────────────────────────────────
      if (!line.startsWith("bestmove")) return;

      clearTimeout_();
      const finished = activeRef.current;
      activeRef.current = null;
      setIsSearching(false);

      if (finished && finished.id === requestIdRef.current) {
        publish(finished);
      }
      startQueued();
    };

    worker.onerror = () => {
      clearTimeout_();
      readyRef.current  = false;
      activeRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
      revokeWorkerBlobUrl();
      setIsSearching(false);
      setError("Engine crashed — remote Stockfish unavailable.");
    };

    worker.postMessage("uci");
  }, [clearTimeout_, publish, revokeWorkerBlobUrl, startQueued]);

  // ── Boot once on mount ───────────────────────────────────────────────────
  useEffect(() => {
    const bootTimer = window.setTimeout(() => {
      void bootWorker();
    }, 0);
    return () => {
      window.clearTimeout(bootTimer);
      clearTimeout_();
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (workerRef.current) {
        workerRef.current.postMessage("quit");
        workerRef.current.terminate();
        workerRef.current = null;
      }
      revokeWorkerBlobUrl();
      readyRef.current  = false;
      activeRef.current = null;
      queuedRef.current = null;
    };
  }, [bootWorker, clearTimeout_, revokeWorkerBlobUrl]);

  // ── Queue new analysis when FEN changes ─────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);

    debounceRef.current = window.setTimeout(() => {
      // Optimistically clear stale data once the queued request is real.
      setIsSearching(true);
      setError("");

      let turn: "w" | "b";
      try { turn = new Chess(fen).turn(); } catch { turn = "w"; }

      const id = requestIdRef.current + 1;
      requestIdRef.current = id;
      queuedRef.current = { id, fen, turn, bestDepth: 0, pvByIndex: new Map() };

      if (!workerRef.current) { void bootWorker(); return; }

      if (activeRef.current) {
        workerRef.current.postMessage("stop");
        return;
      }
      startQueued();
    }, ANALYSIS_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [fen, enabled, bootWorker, startQueued]);

  return { lines, depth, isSearching, error };
}
