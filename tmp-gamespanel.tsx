"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import Button from "@/components/ui/Button";
import ChessBoard from "@/components/board/ChessBoard";
import {
  getAllViewerUsernames,
  getLinkedUsername,
  inferPlatformFromGameId,
  readLinkedAccounts,
  usernameMatchesPlayer,
  type LinkedAccounts,
} from "@/lib/linkedAccounts";

type Platform = "lichess" | "chess.com" | "all";
type GameStatus = "pending" | "processing" | "analyzed" | "failed";

interface GameRow {
  id: string;
  lichess_game_id: string;
  white_username: string;
  black_username: string;
  white_rating: number | null;
  black_rating: number | null;
  played_at: string;
  time_control: string;
  result: "win" | "loss" | "draw";
  status: GameStatus;
}

interface GamesResponse {
  games: GameRow[];
  stats: {
    total: number;
    pending: number;
    processing: number;
    analyzed: number;
    failed: number;
  };
}

interface LiveReviewResponse {
  game: {
    id: string;
    white: string;
    black: string;
    whiteRating: number | null;
    blackRating: number | null;
    timeControl: string | null;
    playedAt: string;
    result: "win" | "loss" | "draw";
    status: GameStatus;
    playerColor?: "white" | "black" | null;
  };
  positions: string[];
  moves: Array<{ ply: number; san: string; from: string; to: string; timeSpentMs: number | null }>;
  error?: string;
}

interface LiveAnalysisResponse {
  best: AnalysisLine;
  second: AnalysisLine | null;
  lines: AnalysisLine[];
  depth: number;
  turn: "w" | "b";
}

interface BranchMove {
  uci: string;
  san: string;
  fen: string;
}

interface BranchNode {
  move: BranchMove | null;
  children: Record<string, BranchNode>;
}

interface BranchState {
  root: BranchNode;
  activePath: string[];
}

interface AnalysisLine {
  move: string;
  san: string;
  score: number;
  pv: string;
  pvUci: string[];
}

function createEmptyBranchState(): BranchState {
  return {
    root: { move: null, children: {} },
    activePath: [],
  };
}

function cloneBranchNode(node: BranchNode): BranchNode {
  const clonedChildren: Record<string, BranchNode> = {};
  for (const [uci, child] of Object.entries(node.children)) {
    clonedChildren[uci] = cloneBranchNode(child);
  }
  return {
    move: node.move ? { ...node.move } : null,
    children: clonedChildren,
  };
}

function walkValidPath(root: BranchNode, path: string[]): { node: BranchNode; validPath: string[] } {
  let current = root;
  const validPath: string[] = [];
  for (const uci of path) {
    const next = current.children[uci];
    if (!next) break;
    validPath.push(uci);
    current = next;
  }
  return { node: current, validPath };
}

function getActiveBranchLine(state: BranchState): BranchMove[] {
  const line: BranchMove[] = [];
  let current = state.root;
  for (const uci of state.activePath) {
    const next = current.children[uci];
    if (!next || !next.move) break;
    line.push(next.move);
    current = next;
  }
  return line;
}

function buildBranchLines(root: BranchNode): Array<{ path: string[]; moves: BranchMove[] }> {
  const lines: Array<{ path: string[]; moves: BranchMove[] }> = [];

  const walk = (node: BranchNode, path: string[], moves: BranchMove[]) => {
    const children = Object.entries(node.children)
      .filter((entry): entry is [string, BranchNode] => Boolean(entry[1]?.move))
      .sort((a, b) => {
        const aSan = a[1].move?.san ?? "";
        const bSan = b[1].move?.san ?? "";
        if (aSan === bSan) return a[0].localeCompare(b[0]);
        return aSan.localeCompare(bSan);
      });

    if (children.length === 0) {
      if (path.length > 0) {
        lines.push({ path, moves });
      }
      return;
    }

    for (const [uci, child] of children) {
      walk(child, [...path, uci], [...moves, child.move as BranchMove]);
    }
  };

  walk(root, [], []);
  return lines;
}

function addMoveToBranchState(state: BranchState, move: BranchMove): BranchState {
  const root = cloneBranchNode(state.root);
  const walked = walkValidPath(root, state.activePath);
  const currentNode = walked.node;

  if (!currentNode.children[move.uci]) {
    currentNode.children[move.uci] = {
      move,
      children: {},
    };
  }

  return {
    root,
    activePath: [...walked.validPath, move.uci],
  };
}

function jumpToDepth(state: BranchState, depth: number): BranchState {
  const walked = walkValidPath(state.root, state.activePath);
  return {
    root: state.root,
    activePath: walked.validPath.slice(0, Math.max(0, depth)),
  };
}

function normalizeBranchState(value: unknown): BranchState {
  const raw = value as Record<string, unknown>;
  if (raw?.root && Array.isArray(raw?.activePath)) {
    const typedRoot = raw.root as BranchNode;
    const typedPath = raw.activePath as string[];
    const safeRoot = typedRoot && typeof typedRoot === "object"
      ? typedRoot
      : createEmptyBranchState().root;
    return {
      root: safeRoot,
      activePath: typedPath.filter((entry) => typeof entry === "string"),
    };
  }

  // Legacy migration from line-based cache format.
  if (Array.isArray(raw?.lines)) {
    const legacyLines = raw.lines as BranchMove[][];
    const legacyActiveLine = typeof raw.activeLine === "number" ? raw.activeLine : 0;
    const legacyActivePly = typeof raw.activePly === "number" ? raw.activePly : 0;
    const migrated = createEmptyBranchState();
    for (const line of legacyLines) {
      let node = migrated.root;
      for (const move of line) {
        if (!node.children[move.uci]) {
          node.children[move.uci] = { move, children: {} };
        }
        node = node.children[move.uci];
      }
    }

    const selectedLine = legacyLines[legacyActiveLine] ?? [];
    const selectedPath = selectedLine.slice(0, Math.max(0, legacyActivePly)).map((move) => move.uci);
    return {
      root: migrated.root,
      activePath: selectedPath,
    };
  }

  return createEmptyBranchState();
}

const ANALYSIS_ENGINE_URL = "/stockfish/stockfish-18-single.js";
const ANALYSIS_MULTI_PV = 3;
const ANALYSIS_DEBOUNCE_MS = 120;
const ANALYSIS_MOVETIME_MS = 20_000;
const ANALYSIS_TIMEOUT_MS = ANALYSIS_MOVETIME_MS + 8_000;

function getEngineThreadCount(): number {
  const hardware =
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? Math.floor(navigator.hardwareConcurrency)
      : 8;
  return Math.max(2, Math.min(24, hardware - 1));
}

function getEngineHashMb(threads: number): number {
  return Math.max(128, Math.min(1024, threads * 32));
}

function statusColor(status: GameStatus): string {
  if (status === "analyzed") return "var(--green)";
  if (status === "processing") return "var(--blue)";
  if (status === "failed") return "var(--red)";
  return "var(--orange)";
}

function formatEval(score: number): string {
  if (Math.abs(score) >= 99_990) {
    const mateIn = 100_000 - Math.abs(score);
    return `${score > 0 ? "+" : "-"}M${mateIn}`;
  }

  if (score === 0) return "0.0";

  const pawns = score / 100;
  return pawns > 0 ? `+${pawns.toFixed(2)}` : pawns.toFixed(2);
}

function parseInitialClockSeconds(timeControl: string | null | undefined): number | null {
  if (!timeControl) return null;
  const match = timeControl.match(/^(\d+)(?:\+\d+)?$/);
  if (!match) return null;
  const seconds = Number.parseInt(match[1], 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function formatClock(totalSeconds: number | null): string {
  if (totalSeconds === null) return "--:--";
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function parseScore(line: string): number | null {
  const mateMatch = line.match(/\bscore mate (-?\d+)\b/);
  if (mateMatch) {
    const mateIn = parseInt(mateMatch[1], 10);
    return mateIn > 0 ? 100_000 - mateIn : -100_000 - mateIn;
  }

  const cpMatch = line.match(/\bscore cp (-?\d+)\b/);
  return cpMatch ? parseInt(cpMatch[1], 10) : null;
}

function uciToSan(fen: string, uciMove: string): string {
  const chess = new Chess(fen);
  try {
    const from = uciMove.slice(0, 2);
    const to = uciMove.slice(2, 4);
    const move =
      uciMove.length > 4
        ? chess.move({ from, to, promotion: uciMove[4] })
        : chess.move({ from, to });

    if (!move) {
      throw new Error(`Invalid move ${uciMove}`);
    }

    return move.san;
  } catch {
    throw new Error(`Invalid move ${uciMove}`);
  }
}

function playUciMove(fen: string, uciMove: string): BranchMove | null {
  const tryPlay = (positionFen: string): BranchMove | null => {
    const chess = new Chess(positionFen);
    let move:
      | ReturnType<typeof chess.move>
      | null = null;
    try {
      const from = uciMove.slice(0, 2);
      const to = uciMove.slice(2, 4);
      move =
        uciMove.length > 4
          ? chess.move({ from, to, promotion: uciMove[4] })
          : chess.move({ from, to });
    } catch {
      return null;
    }

    if (!move) return null;

    return {
      uci: uciMove,
      san: move.san,
      fen: chess.fen(),
    };
  };

  const direct = tryPlay(fen);
  if (direct) return direct;

  const fenParts = fen.split(" ");
  if (fenParts.length < 2) return null;
  fenParts[1] = fenParts[1] === "w" ? "b" : "w";
  return tryPlay(fenParts.join(" "));
}

function normalizeToWhitePerspective(score: number, turn: "w" | "b"): number {
  return turn === "w" ? score : -score;
}

function evalBarWhiteRatio(score: number): number {
  if (Math.abs(score) >= 99_000) {
    return score > 0 ? 1 : 0;
  }

  const clamped = Math.max(-800, Math.min(800, score));
  return (clamped + 800) / 1600;
}

function uciPvToSanPreview(fen: string, pvLine: string, maxPlies = 8): string {
  const chess = new Chess(fen);
  const moves = pvLine.trim().split(/\s+/).filter(Boolean);
  const sanMoves: string[] = [];

  for (let i = 0; i < moves.length && sanMoves.length < maxPlies; i++) {
    const beforeMoveNumber = chess.moveNumber();
    const beforeTurn = chess.turn();
    let move:
      | ReturnType<typeof chess.move>
      | null = null;
    try {
      const from = moves[i].slice(0, 2);
      const to = moves[i].slice(2, 4);
      move =
        moves[i].length > 4
          ? chess.move({ from, to, promotion: moves[i][4] })
          : chess.move({ from, to });
    } catch {
      break;
    }

    if (!move) break;

    sanMoves.push(
      beforeTurn === "w"
        ? `${beforeMoveNumber}. ${move.san}`
        : `${beforeMoveNumber}... ${move.san}`
    );
  }

  return sanMoves.join(" ");
}

function useBrowserLiveAnalysis(fen: string) {
  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef(false);
  const activeRef = useRef<{
    id: number;
    fen: string;
    turn: "w" | "b";
    bestDepth: number;
    pvByIndex: Map<number, AnalysisLine>;
  } | null>(null);
  const queuedRef = useRef<{
    id: number;
    fen: string;
    turn: "w" | "b";
    bestDepth: number;
    pvByIndex: Map<number, AnalysisLine>;
  } | null>(null);
  const requestIdRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);
  const timeoutTimerRef = useRef<number | null>(null);
  const [analysis, setAnalysis] = useState<LiveAnalysisResponse | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(true);
  const [analysisError, setAnalysisError] = useState("");

  const clearAnalysisTimeout = useCallback(() => {
    if (timeoutTimerRef.current !== null) {
      window.clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
  }, []);

  const publishAnalysis = useCallback((pending: NonNullable<typeof activeRef.current>) => {
    const best = pending.pvByIndex.get(1);
    if (!best) return;

    setAnalysis({
      best,
      second: pending.pvByIndex.get(2) ?? null,
      lines: Array.from(pending.pvByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]),
      depth: pending.bestDepth,
      turn: pending.turn,
    });
    setAnalysisLoading(false);
    setAnalysisError("");
  }, []);

  const startQueuedAnalysis = useCallback(() => {
    const worker = workerRef.current;
    const queued = queuedRef.current;
    if (!worker || !readyRef.current || !queued || activeRef.current) return;

    queuedRef.current = null;
    activeRef.current = queued;

    clearAnalysisTimeout();
    timeoutTimerRef.current = window.setTimeout(() => {
      if (activeRef.current?.id !== queued.id) return;

      worker.postMessage("stop");
      setAnalysisError("Analysis timed out. Restarting engine…");
      setAnalysisLoading(false);
    }, ANALYSIS_TIMEOUT_MS);

    worker.postMessage("ucinewgame");
    worker.postMessage(`setoption name MultiPV value ${ANALYSIS_MULTI_PV}`);
    worker.postMessage(`position fen ${queued.fen}`);
    worker.postMessage(`go movetime ${ANALYSIS_MOVETIME_MS}`);
  }, [clearAnalysisTimeout]);

  const bootWorker = useCallback(() => {
    if (typeof Worker === "undefined") {
      queueMicrotask(() => {
        setAnalysis(null);
        setAnalysisLoading(false);
        setAnalysisError("Browser workers are not available.");
      });
      return;
    }

    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }

    readyRef.current = false;
    activeRef.current = null;
    clearAnalysisTimeout();

    const worker = new Worker(ANALYSIS_ENGINE_URL);
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<string>) => {
      const line = typeof event.data === "string" ? event.data : "";
      if (!line) return;

      if (!readyRef.current) {
        if (line === "uciok") {
          const threads = getEngineThreadCount();
          const hash = getEngineHashMb(threads);
          worker.postMessage("setoption name UCI_AnalyseMode value true");
          worker.postMessage(`setoption name Threads value ${threads}`);
          worker.postMessage(`setoption name Hash value ${hash}`);
          worker.postMessage("isready");
          return;
        }

        if (line === "readyok") {
          readyRef.current = true;
          startQueuedAnalysis();
        }

        return;
      }

      const pending = activeRef.current;
      if (!pending) return;

      if (line.startsWith("info") && line.includes("multipv")) {
        const depthMatch = line.match(/\bdepth (\d+)\b/);
        const firstMoveMatch = line.match(/\bpv (\S+)/);
        const pvLineMatch = line.match(/\bpv (.+)$/);
        const multipvMatch = line.match(/\bmultipv (\d+)\b/);
        const depth = depthMatch ? parseInt(depthMatch[1], 10) : 0;
        const pvIndex = multipvMatch ? parseInt(multipvMatch[1], 10) : 0;
        const rawScore = parseScore(line);

        if (!firstMoveMatch || !pvLineMatch || !pvIndex || pvIndex > ANALYSIS_MULTI_PV || rawScore === null) return;
        if (depth < pending.bestDepth) return;

        if (depth > pending.bestDepth) {
          pending.bestDepth = depth;
          pending.pvByIndex.clear();
        }

        try {
          const pvUci = pvLineMatch[1].trim().split(/\s+/).filter(Boolean);
          const score = normalizeToWhitePerspective(rawScore, pending.turn);
          pending.pvByIndex.set(pvIndex, {
            move: firstMoveMatch[1],
            san: uciToSan(pending.fen, firstMoveMatch[1]),
            score,
            pv: uciPvToSanPreview(pending.fen, pvLineMatch[1]),
            pvUci,
          });
        } catch {
          return;
        }

        if (pending.id === requestIdRef.current) {
          publishAnalysis(pending);
        }

        return;
      }

      if (!line.startsWith("bestmove")) return;

      clearAnalysisTimeout();

      const finished = activeRef.current;
      activeRef.current = null;
      if (!finished) {
        startQueuedAnalysis();
        return;
      }

      if (finished.id === requestIdRef.current && finished.pvByIndex.get(1)) {
        publishAnalysis(finished);
      } else if (!queuedRef.current && finished.id === requestIdRef.current) {
        setAnalysisLoading(false);
        setAnalysisError("No live analysis result received.");
      }

      startQueuedAnalysis();
    };

    worker.onerror = () => {
      clearAnalysisTimeout();
      readyRef.current = false;
      activeRef.current = null;
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      setAnalysisLoading(true);
      setAnalysisError("Analysis engine crashed. Change position to retry.");
    };

    worker.postMessage("uci");
  }, [clearAnalysisTimeout, publishAnalysis, startQueuedAnalysis]);

  useEffect(() => {
    bootWorker();

    return () => {
      clearAnalysisTimeout();
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      if (workerRef.current) {
        workerRef.current.postMessage("quit");
        workerRef.current.terminate();
        workerRef.current = null;
      }
      readyRef.current = false;
      activeRef.current = null;
      queuedRef.current = null;
    };
  }, [bootWorker, clearAnalysisTimeout]);

  useEffect(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }

    queueMicrotask(() => {
      setAnalysisLoading(true);
      setAnalysisError("");
    });

    debounceTimerRef.current = window.setTimeout(() => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      queuedRef.current = {
        id: requestId,
        fen,
        turn: new Chess(fen).turn(),
        bestDepth: 0,
        pvByIndex: new Map(),
      };

      const worker = workerRef.current;
      if (!worker) {
        bootWorker();
        return;
      }

      if (activeRef.current) {
        worker.postMessage("stop");
        return;
      }

      startQueuedAnalysis();
    }, ANALYSIS_DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, [bootWorker, fen, startQueuedAnalysis]);

  return { analysis, analysisLoading, analysisError };
}

// ── Chess.com-style move list ──────────────────────────────────────
function MoveList({
  moves,
  reviewIndex,
  onSelect,
  branchState,
  onSelectPath,
  onJumpToDepth,
  onUndoBranch,
  onResetBranches,
}: {
  moves: LiveReviewResponse["moves"];
  reviewIndex: number;
  onSelect: (idx: number) => void;
  branchState: BranchState;
  onSelectPath: (path: string[], depth: number) => void;
  onJumpToDepth: (depth: number) => void;
  onUndoBranch: () => void;
  onResetBranches: () => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [reviewIndex]);

  const maxTimeMs = Math.max(
    1,
    ...moves.map((m) => (typeof m.timeSpentMs === "number" ? m.timeSpentMs : 0))
  );

  const formatMoveTime = (timeSpentMs: number | null): string => {
    if (timeSpentMs === null) return "";
    const sec = timeSpentMs / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const mins = Math.floor(sec / 60);
    const secs = Math.round(sec % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const rows: Array<{ moveNum: number; white: (typeof moves)[0] | null; black: (typeof moves)[0] | null }> = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ moveNum: Math.floor(i / 2) + 1, white: moves[i] ?? null, black: moves[i + 1] ?? null });
  }

  const branchHasAny = useMemo(() => Object.keys(branchState.root.children ?? {}).length > 0, [branchState.root.children]);
  const branchActive = branchState.activePath.length > 0;

  const activeBranchMoves = useMemo(() => getActiveBranchLine(branchState), [branchState]);
  const sharedPrefixLength = (a: string[], b: string[]): number => {
    let idx = 0;
    while (idx < a.length && idx < b.length && a[idx] === b[idx]) idx++;
    return idx;
  };
  const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

  const branchLines = useMemo(() => {
    if (!branchHasAny) return [];
    const base = buildBranchLines(branchState.root);
    if (branchState.activePath.length > 0 && activeBranchMoves.length > 0 && !base.some((l) => samePath(l.path, branchState.activePath))) {
      base.unshift({ path: branchState.activePath, moves: activeBranchMoves });
    }
    const active = branchState.activePath;
    return base
      .slice()
      .sort((a, b) => {
        const aIsActive = samePath(a.path, active);
        const bIsActive = samePath(b.path, active);
        if (aIsActive !== bIsActive) return aIsActive ? -1 : 1;
        const aStr = a.path.join("/");
        const bStr = b.path.join("/");
        return aStr.localeCompare(bStr);
      });
  }, [activeBranchMoves, branchHasAny, branchState.activePath, branchState.root]);

  const formatBranchSan = (lineMoves: BranchMove[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < lineMoves.length; i += 1) {
      const ply = reviewIndex + i + 1;
      const moveNum = Math.floor((ply + 1) / 2);
      const isWhiteMove = ply % 2 === 1;
      const san = lineMoves[i]?.san ?? "";
      if (!san) continue;
      if (isWhiteMove) {
        parts.push(`${moveNum}. ${san}`);
      } else if (i === 0) {
        parts.push(`${moveNum}... ${san}`);
      } else {
        parts.push(san);
      }
    }
    return parts.join(" ");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", fontSize: "14px", color: "#ddd", background: "#211f1c" }}>
      <div style={{ borderBottom: "1px solid #3c3a38", background: "#1f1d1a" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", padding: "7px 8px" }}>
          <span style={{ fontSize: "11px", color: "#a9a5a1", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>
            Variations
          </span>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <button
              onClick={onUndoBranch}
              disabled={!branchActive}
              style={{
                border: "1px solid #4b4742",
                background: "#2c2a27",
                color: "#fff",
                borderRadius: "999px",
                padding: "2px 9px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: branchActive ? "pointer" : "default",
                opacity: branchActive ? 1 : 0.5,
                fontFamily: "inherit",
              }}
            >
              Undo
            </button>
            <button
              onClick={() => onJumpToDepth(0)}
              style={{
                border: "1px solid #4b4742",
                background: "#2c2a27",
                color: "#fff",
                borderRadius: "999px",
                padding: "2px 9px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Main
            </button>
            <button
              onClick={onResetBranches}
              disabled={!branchHasAny}
              style={{
                border: "1px solid rgba(185,64,64,0.45)",
                background: "rgba(185,64,64,0.16)",
                color: "#ffb1b1",
                borderRadius: "999px",
                padding: "2px 9px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: branchHasAny ? "pointer" : "default",
                opacity: branchHasAny ? 1 : 0.5,
                fontFamily: "inherit",
              }}
            >
              Reset
            </button>
          </div>
        </div>

        {!branchHasAny ? (
          <div style={{ padding: "10px 12px", borderTop: "1px solid #34322f", color: "#9a9896", fontSize: "12px", lineHeight: 1.35 }}>
            Clica numa linha do Analysis ou joga um lance no tabuleiro para criar variações aqui.
          </div>
        ) : (
          branchLines.map((line, idx) => {
            const activePath = branchState.activePath;
            const isActiveLine = samePath(line.path, activePath);
            const prefix = activePath.length > 0 ? sharedPrefixLength(line.path, activePath) : 0;
            const indent = Math.max(0, prefix - 1);
            const label = formatBranchSan(line.moves);
            return (
              <button
                key={`branch-line-${idx}-${line.path.join("-")}`}
                onClick={() => onSelectPath(line.path, line.path.length)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  borderTop: idx === 0 ? "1px solid #34322f" : "1px solid #302e2c",
                  background: isActiveLine ? "rgba(129,182,76,0.10)" : (idx % 2 === 0 ? "#24221f" : "#201e1b"),
                  color: isActiveLine ? "#fff" : "#d7d3cf",
                  padding: "8px 10px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                  <div style={{ width: `${12 + indent * 12}px`, flexShrink: 0, position: "relative" }}>
                    {indent > 0 && (
                      <div style={{ position: "absolute", left: "6px", top: 0, bottom: 0, width: "2px", background: "#34322f", borderRadius: "2px" }} />
                    )}
                    <div style={{ position: "absolute", left: `${indent > 0 ? "12px" : "0px"}`, top: "10px", width: "8px", height: "2px", background: "#34322f", borderRadius: "2px" }} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "12px", fontWeight: isActiveLine ? 800 : 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {label || line.path.join(" ")}
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {rows.map((row) => (
        <div key={row.moveNum} style={{ display: "flex", padding: "4px 0", borderBottom: "1px solid #3c3a38", background: row.moveNum % 2 === 0 ? "#262421" : "#211f1c" }}>
          <div style={{ width: "34px", color: "#9a9896", textAlign: "right", paddingRight: "8px", fontSize: "12px", fontWeight: 700 }}>{row.moveNum}.</div>
          <div style={{ display: "flex", flex: 1, gap: "4px" }}>
            {row.white && (
              <button
                ref={row.white.ply === reviewIndex ? activeRef : null}
                onClick={() => onSelect(row.white!.ply)}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px",
                  textAlign: "left", background: row.white.ply === reviewIndex ? "#4d4a45" : "transparent",
                  color: row.white.ply === reviewIndex ? "#fff" : "#ccc",
                  border: "none", padding: "2px 6px", borderRadius: "4px", cursor: "pointer",
                  fontWeight: row.white.ply === reviewIndex ? "bold" : "normal"
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "14px", fontWeight: 700 }}>{row.white.san}</span>
                {row.white.timeSpentMs !== null && (
                  <span style={{ display: "flex", alignItems: "center", gap: "6px", color: "#a9a5a1", fontSize: "12px", flexShrink: 0, fontWeight: 600 }}>
                    <span>{formatMoveTime(row.white.timeSpentMs)}</span>
                    <span style={{ width: "30px", height: "7px", borderRadius: "999px", background: "#3c3a38", overflow: "hidden" }}>
                      <span
                        style={{
                          display: "block",
                          height: "100%",
                          width: `${Math.max(6, Math.round((row.white.timeSpentMs / maxTimeMs) * 26))}px`,
                          background: "#6f6a64",
                        }}
                      />
                    </span>
                  </span>
                )}
              </button>
            )}
            {row.black && (
              <button
                ref={row.black.ply === reviewIndex ? activeRef : null}
                onClick={() => onSelect(row.black!.ply)}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px",
                  textAlign: "left", background: row.black.ply === reviewIndex ? "#4d4a45" : "transparent",
                  color: row.black.ply === reviewIndex ? "#fff" : "#ccc",
                  border: "none", padding: "2px 6px", borderRadius: "4px", cursor: "pointer",
                  fontWeight: row.black.ply === reviewIndex ? "bold" : "normal"
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "14px", fontWeight: 700 }}>{row.black.san}</span>
                {row.black.timeSpentMs !== null && (
                  <span style={{ display: "flex", alignItems: "center", gap: "6px", color: "#a9a5a1", fontSize: "12px", flexShrink: 0, fontWeight: 600 }}>
                    <span>{formatMoveTime(row.black.timeSpentMs)}</span>
                    <span style={{ width: "30px", height: "7px", borderRadius: "999px", background: "#3c3a38", overflow: "hidden" }}>
                      <span
                        style={{
                          display: "block",
                          height: "100%",
                          width: `${Math.max(6, Math.round((row.black.timeSpentMs / maxTimeMs) * 26))}px`,
                          background: "#6f6a64",
                        }}
                      />
                    </span>
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function EvalBar({
  score,
  orientation,
}: {
  score: number;
  orientation: "white" | "black";
}) {
  const whiteRatio = evalBarWhiteRatio(score);
  const blackRatio = 1 - whiteRatio;

  const isWhiteWinning = score >= 0;
  const labelColor = isWhiteWinning ? "#111" : "#fff";
  const whiteOnTop = orientation === "black";
  const topRatio = whiteOnTop ? whiteRatio : blackRatio;
  const topBg = whiteOnTop ? "#fff" : "#333";
  const bottomRatio = whiteOnTop ? blackRatio : whiteRatio;
  const bottomBg = whiteOnTop ? "#333" : "#fff";
  const labelOnTop = isWhiteWinning ? whiteOnTop : !whiteOnTop;

  return (
    <div
      style={{
        width: "24px",
        height: "100%",
        minHeight: "240px",
        borderTopLeftRadius: "4px",
        borderBottomLeftRadius: "4px",
        overflow: "hidden",
        border: "none",
        background: "#333",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        position: "relative",
      }}
    >
      <div
        style={{
          flex: topRatio,
          background: topBg,
          width: "100%",
          transition: "flex 0.5s ease-in-out",
        }}
      />
      <div
        style={{
          flex: bottomRatio,
          background: bottomBg,
          width: "100%",
          transition: "flex 0.5s ease-in-out",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: labelOnTop ? "4px" : "auto",
          bottom: labelOnTop ? "auto" : "4px",
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: "13px",
          fontWeight: 800,
          color: labelColor,
        }}
      >
        {formatEval(score)}
      </div>
    </div>
  );
}

function PlayerChip({
  player,
  viewerColor,
}: {
  player: { color: "white" | "black"; name: string; rating: number | null; clock: string };
  viewerColor: "white" | "black" | null;
}) {
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "8px",
      padding: "6px 10px",
      borderRadius: "999px",
      background: "rgba(24,22,20,0.82)",
      border: "1px solid rgba(255,255,255,0.14)",
      color: "#fff",
      fontSize: "12px",
      fontWeight: 800,
      backdropFilter: "blur(6px)",
      maxWidth: "100%",
      pointerEvents: "auto",
    }}>
      <span style={{
        width: "22px",
        height: "22px",
        borderRadius: "50%",
        background: player.color === "white" ? "#e8e6e2" : "#111",
        color: player.color === "white" ? "#111" : "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "12px",
        fontWeight: 900,
        flexShrink: 0,
      }}>
        {(player.name ?? "?").trim().slice(0, 1).toUpperCase()}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        {player.name}
        {typeof player.rating === "number" ? ` (${player.rating})` : ""}
      </span>
      <span style={{
        marginLeft: "2px",
        padding: "1px 7px",
        borderRadius: "999px",
        border: "1px solid rgba(255,255,255,0.18)",
        background: "rgba(0,0,0,0.22)",
        color: "#ddd",
        fontSize: "11px",
        fontWeight: 800,
        flexShrink: 0,
      }}>
        {player.clock}
      </span>
      {viewerColor === player.color && (
        <span style={{
          padding: "1px 7px",
          borderRadius: "999px",
          background: "rgba(129,182,76,0.26)",
          border: "1px solid rgba(129,182,76,0.6)",
          fontSize: "10px",
          fontWeight: 900,
          flexShrink: 0,
        }}>
          You
        </span>
      )}
    </div>
  );
}

// ── Navigation SVG icons ───────────────────────────────────────────
const NavFirst = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>
  </svg>
);
const NavPrev = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);
const NavNext = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);
const NavLast = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>
  </svg>
);

// ── Full-screen chess.com-style review view ────────────────────────
function ReviewView({
  review,
  reviewIndex,
  setReviewIndex,
  onClose,
}: {
  review: LiveReviewResponse;
  reviewIndex: number;
  setReviewIndex: React.Dispatch<React.SetStateAction<number>>;
  onClose: () => void;
}) {
  const total = review.positions.length - 1;
  const [windowWidth, setWindowWidth] = useState(1280);
  const [branchCache, setBranchCache] = useState<Record<number, BranchState>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(`chessRecall:reviewBranches:${review.game.id}`);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const normalized: Record<number, BranchState> = {};
      for (const [key, value] of Object.entries(parsed ?? {})) {
        const numericKey = Number(key);
        if (!Number.isFinite(numericKey)) continue;
        normalized[numericKey] = normalizeBranchState(value);
      }
      return normalized;
    } catch {
      return {};
    }
  });
  const [orientation, setOrientation] = useState<"white" | "black">(
    review.game.playerColor === "black" ? "black" : "white"
  );

  const getBranchState = useCallback(
    (idx: number): BranchState => normalizeBranchState(branchCache[idx] ?? createEmptyBranchState()),
    [branchCache]
  );

  const updateBranchState = useCallback(
    (updater: (current: BranchState) => BranchState) => {
      setBranchCache((prev) => {
        const current = normalizeBranchState(prev[reviewIndex] ?? createEmptyBranchState());
        return { ...prev, [reviewIndex]: updater(current) };
      });
    },
    [reviewIndex]
  );

  const go = useCallback(
    (idx: number) => {
      setReviewIndex(Math.max(0, Math.min(total, idx)));
    },
    [total, setReviewIndex]
  );

  const isCompact = windowWidth < 1100;
  const mainlineFen = review.positions[reviewIndex];
  const branchState = getBranchState(reviewIndex);
  const visibleBranch = getActiveBranchLine(branchState);
  const activeFen = visibleBranch[visibleBranch.length - 1]?.fen ?? mainlineFen;
  const { analysis, analysisLoading, analysisError } =
    useBrowserLiveAnalysis(activeFen);
  const branchActive = branchState.activePath.length > 0;
  const boardBoxRef = useRef<HTMLDivElement | null>(null);
  const boardSlotRef = useRef<HTMLDivElement | null>(null);
  const [boardHeight, setBoardHeight] = useState<number | null>(null);
  const [boardSlotSize, setBoardSlotSize] = useState<{ width: number; height: number } | null>(null);
  const boardSize = useMemo(() => {
    if (!boardSlotSize) return null;
    const chromeWidth = isCompact ? 0 : 24 + 42;
    const max = isCompact ? 560 : 920;
    const reservedVertical = 86;
    const usableHeight = Math.max(0, boardSlotSize.height - reservedVertical);
    const size = Math.floor(Math.max(0, Math.min(usableHeight, boardSlotSize.width - chromeWidth, max) - 2));
    return size > 0 ? size : null;
  }, [boardSlotSize, isCompact]);
  const branchStorageKey = useMemo(
    () => `chessRecall:reviewBranches:${review.game.id}`,
    [review.game.id]
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(branchStorageKey, JSON.stringify(branchCache));
    } catch {
      // Ignore quota/storage errors and keep in-memory cache.
    }
  }, [branchCache, branchStorageKey]);

  useEffect(() => {
    const syncWindowWidth = () => setWindowWidth(window.innerWidth);
    syncWindowWidth();
    window.addEventListener("resize", syncWindowWidth);
    return () => window.removeEventListener("resize", syncWindowWidth);
  }, []);

  useEffect(() => {
    const el = boardBoxRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setBoardHeight(Math.max(0, Math.round(rect.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = boardSlotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setBoardSlotSize({ width: rect.width, height: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(reviewIndex - 1);
      if (e.key === "ArrowRight") go(reviewIndex + 1);
      if (e.key === "Home") go(0);
      if (e.key === "End") go(total);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [go, reviewIndex, total]);

  const applyBranchMove = useCallback(
    (uciMove: string) => {
      updateBranchState((current) => {
        const currentLine = getActiveBranchLine(current);
        const baseFen = currentLine[currentLine.length - 1]?.fen ?? mainlineFen;
        const branchMove = playUciMove(baseFen, uciMove);
        if (!branchMove) return current;
        return addMoveToBranchState(current, branchMove);
      });
    },
    [mainlineFen, updateBranchState]
  );

  const applyBranchSequence = useCallback((uciMoves: string[]) => {
    if (uciMoves.length === 0) return;

    updateBranchState((current) => {
      let nextState = current;
      for (const uciMove of uciMoves) {
        const currentLine = getActiveBranchLine(nextState);
        const baseFen = currentLine[currentLine.length - 1]?.fen ?? mainlineFen;
        const branchMove = playUciMove(baseFen, uciMove);
        if (!branchMove) break;
        nextState = addMoveToBranchState(nextState, branchMove);
      }
      return nextState;
    });
  }, [mainlineFen, updateBranchState]);

  const handleBoardMove = useCallback(
    (orig: Key, dest: Key) => {
      applyBranchMove(`${orig}${dest}`);
    },
    [applyBranchMove]
  );

  const undoBranchMove = useCallback(() => {
    updateBranchState((current) => jumpToDepth(current, current.activePath.length - 1));
  }, [updateBranchState]);

  const selectBranchPath = useCallback((path: string[], depth: number) => {
    updateBranchState((current) => {
      const candidate = path.slice(0, Math.max(0, depth));
      const walked = walkValidPath(current.root, candidate);
      return {
        root: current.root,
        activePath: walked.validPath,
      };
    });
  }, [updateBranchState]);

  const jumpToBranchDepth = useCallback((depth: number) => {
    updateBranchState((current) => jumpToDepth(current, depth));
  }, [updateBranchState]);

  const clearBranches = useCallback(() => {
    setBranchCache({});
  }, []);

  const resultLabel = review.game.result === "win" ? "1-0" : review.game.result === "loss" ? "0-1" : "½-½";
  const whiteEval = analysis?.best.score ?? 0;
  const viewerColor = review.game.playerColor ?? null;
  const totalSpentByColor = useMemo(() => {
    let whiteMs = 0;
    let blackMs = 0;
    for (const move of review.moves) {
      if (typeof move.timeSpentMs !== "number") continue;
      if (move.ply % 2 === 1) {
        whiteMs += move.timeSpentMs;
      } else {
        blackMs += move.timeSpentMs;
      }
    }
    return { whiteMs, blackMs };
  }, [review.moves]);
  const initialClockSeconds = useMemo(
    () => parseInitialClockSeconds(review.game.timeControl),
    [review.game.timeControl]
  );
  const whiteClock = initialClockSeconds === null
    ? null
    : Math.max(0, initialClockSeconds - Math.floor(totalSpentByColor.whiteMs / 1000));
  const blackClock = initialClockSeconds === null
    ? null
    : Math.max(0, initialClockSeconds - Math.floor(totalSpentByColor.blackMs / 1000));
  const boardProfiles =
    orientation === "white"
      ? [
          {
            slot: "top" as const,
            color: "black" as const,
            name: review.game.black,
            rating: review.game.blackRating,
            clock: formatClock(blackClock),
          },
          {
            slot: "bottom" as const,
            color: "white" as const,
            name: review.game.white,
            rating: review.game.whiteRating,
            clock: formatClock(whiteClock),
          },
        ]
      : [
          {
            slot: "top" as const,
            color: "white" as const,
            name: review.game.white,
            rating: review.game.whiteRating,
            clock: formatClock(whiteClock),
          },
          {
            slot: "bottom" as const,
            color: "black" as const,
            name: review.game.black,
            rating: review.game.blackRating,
            clock: formatClock(blackClock),
          },
        ];
  const topBoardProfile = boardProfiles.find((p) => p.slot === "top") ?? null;
  const bottomBoardProfile = boardProfiles.find((p) => p.slot === "bottom") ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "calc(100dvh - 56px)", minHeight: 0, maxHeight: "calc(100dvh - 56px)", overflow: "hidden", background: "var(--bg-base)" }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
        background: "var(--bg-surface)",
        flexWrap: "wrap",
      }}>
        <button
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "5px",
            padding: "5px 10px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text-secondary)",
            fontSize: "12px",
            cursor: "pointer",
            fontFamily: "inherit",
            flexShrink: 0,
          }}
        >
          <NavPrev /> Back
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {review.game.white} vs {review.game.black}
          </span>
          <span style={{
            padding: "2px 8px",
            borderRadius: "4px",
            background: "var(--bg-elevated)",
            fontSize: "11px",
            fontWeight: 700,
            color: "var(--accent)",
          }}>
            {resultLabel}
          </span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            {new Date(review.game.playedAt).toLocaleDateString()}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: isCompact ? "column" : "row", flex: 1, height: "100%", minHeight: 0, overflow: "visible" }}>
        <div style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: isCompact ? "12px" : "18px 24px",
          minWidth: 0,
          minHeight: 0,
          overflow: "visible",
        }}>
          <div
            ref={boardSlotRef}
            style={{
              display: "flex",
              alignItems: "stretch",
              gap: "0px",
              height: "100%",
              maxHeight: "100%",
              width: "100%",
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              alignSelf: "stretch",
              justifyContent: "center",
            }}
          >
            {!isCompact && <EvalBar score={whiteEval} orientation={orientation} />}
            {!isCompact && (
              <div style={{ width: "42px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <button
                  onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}
                  style={{
                    width: "34px",
                    height: "34px",
                    borderRadius: "6px",
                    border: "1px solid #3c3a38",
                    background: "#211f1c",
                    color: "#fff",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    fontWeight: 700,
                    fontSize: "12px",
                  }}
                >
                  ↻
                </button>
              </div>
            )}
            <div style={{
              width: boardSize ? `${boardSize}px` : isCompact
                ? "min(100%, 560px)"
                : "min(920px, 100%)",
              maxWidth: "100%",
              maxHeight: "100%",
              margin: "auto",
              flexShrink: 0,
              alignSelf: "center",
              position: "relative",
            }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start", width: "100%" }}>
                {topBoardProfile && (
                  <div style={{ maxWidth: "100%" }}>
                    <PlayerChip player={topBoardProfile} viewerColor={viewerColor} />
                  </div>
                )}
                <div style={{ position: "relative", width: "100%" }} ref={boardBoxRef}>
                  {branchActive && (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(255,255,255,0.22)",
                        pointerEvents: "none",
                        zIndex: 4,
                        borderRadius: "6px",
                      }}
                    />
                  )}
                  <ChessBoard
                    fen={activeFen}
                    orientation={orientation}
                    interactive
                    allowAnyColorMoves
                    onMove={handleBoardMove}
                    showCoordinates
                  />
                </div>
                {bottomBoardProfile && (
                  <div style={{ maxWidth: "100%" }}>
                    <PlayerChip player={bottomBoardProfile} viewerColor={viewerColor} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={{
          width: isCompact ? "100%" : "380px",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderLeft: isCompact ? "none" : "1px solid #3c3a38",
          borderTop: isCompact ? "1px solid #3c3a38" : "none",
          background: "#262421",
          height: isCompact ? "auto" : (boardHeight ? `${boardHeight}px` : "100%"),
          minHeight: isCompact ? undefined : 0,
          overflow: "hidden",
          color: "#fff",
          alignSelf: isCompact ? "stretch" : "center",
        }}>
          <div style={{ display: 'flex', borderBottom: '1px solid #3c3a38', background: '#211f1c', flexShrink: 0 }}>
            {['Analysis', 'New Game', 'Games', 'Players'].map((tab, i) => (
              <button key={tab} style={{
                flex: 1, padding: '12px 0', fontSize: '13px', fontWeight: 600,
                color: i === 0 ? '#fff' : '#999',
                borderBottom: i === 0 ? '3px solid #81b64c' : '3px solid transparent',
                background: 'transparent', border: 'none', cursor: 'pointer',
              }}>
                {tab}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', borderBottom: '1px solid #3c3a38', flexShrink: 0 }}>
            {['Moves', 'Info', 'Openings'].map((tab, i) => (
              <button key={tab} style={{
                flex: 1, padding: '10px 0', fontSize: '12px', fontWeight: 600,
                color: i === 0 ? '#fff' : '#999',
                background: 'transparent', border: 'none', cursor: 'pointer',
              }}>
                {tab}
              </button>
            ))}
          </div>

          <div style={{ padding: "10px 12px", borderBottom: "1px solid #3c3a38", flexShrink: 0, display: "grid", gap: "6px" }}>
            {(
              orientation === "white"
                ? [
                    { side: "top", color: "black" as const, name: review.game.black },
                    { side: "bottom", color: "white" as const, name: review.game.white },
                  ]
                : [
                    { side: "top", color: "white" as const, name: review.game.white },
                    { side: "bottom", color: "black" as const, name: review.game.black },
                  ]
            ).map((player) => (
              <div
                key={`${player.side}-${player.color}`}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}
              >
                <span style={{ fontSize: "12px", fontWeight: 800, color: "#fff", display: "inline-flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: player.color === "white" ? "#e8e6e2" : "#111", border: "1px solid rgba(255,255,255,0.18)", flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{player.name}</span>
                </span>
                {viewerColor === player.color && (
                  <span style={{ padding: "2px 6px", borderRadius: "999px", background: "#3c3a38", fontSize: "11px", fontWeight: 800 }}>
                    You
                  </span>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', fontSize: '11px', color: '#999', alignItems: 'center', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>✓ Analysis</span>
              <span>•••</span>
            </div>
            <div>
              {analysis?.depth ? `depth=${analysis.depth}` : "depth=..."} | t=20s | SF18
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            {analysisError ? (
              <div style={{ padding: '8px 12px', fontSize: '12px', color: '#ff6666' }}>{analysisError}</div>
            ) : analysisLoading && !analysis ? (
              <div style={{ padding: '8px 12px', fontSize: '12px', color: '#999' }}>Analysing...</div>
            ) : analysis ? (
              analysis.lines.map((line, idx) => (
                <div key={idx} style={{ 
                  display: 'flex', alignItems: 'center', gap: '8px', 
                  padding: '4px 12px', 
                  background: idx % 2 === 0 ? '#2c2b29' : '#262421',
                  cursor: 'pointer'
                }} onClick={() => applyBranchSequence(line.pvUci.length > 0 ? line.pvUci : [line.move])}>
                  <div style={{ 
                    background: line.score >= 0 ? '#fff' : '#333', 
                    color: line.score >= 0 ? '#000' : '#fff', 
                    padding: '2px 6px', 
                    borderRadius: '4px', 
                    fontSize: '11px', 
                    fontWeight: 700,
                    minWidth: '38px',
                    textAlign: 'center'
                  }}>
                    {formatEval(line.score)}
                  </div>
                  <div style={{ 
                    color: '#ccc', 
                    fontSize: '12px', 
                    whiteSpace: 'nowrap', 
                    overflow: 'hidden', 
                    textOverflow: 'ellipsis',
                    flex: 1
                  }}>
                    <span style={{ fontWeight: 'bold', color: '#fff', marginRight: '4px' }}>{line.san}</span>
                    {line.pv.split(' ').slice(1).join(' ')}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ padding: '8px 12px', fontSize: '12px', color: '#999' }}>No analysis available.</div>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 0', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: '4px', color: '#999', paddingLeft: '12px' }}>
              Starting Position
            </div>
            <MoveList
              moves={review.moves}
              reviewIndex={reviewIndex}
              onSelect={go}
              branchState={branchState}
              onSelectPath={selectBranchPath}
              onJumpToDepth={jumpToBranchDepth}
              onUndoBranch={undoBranchMove}
              onResetBranches={clearBranches}
            />
          </div>

          <div style={{ padding: '12px', background: '#211f1c', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: '4px' }}>
                {[
                  { icon: <NavFirst />, action: () => go(0), disabled: reviewIndex === 0 },
                  { icon: <NavPrev />, action: () => go(reviewIndex - 1), disabled: reviewIndex === 0 },
                  { icon: <NavNext />, action: () => go(reviewIndex + 1), disabled: reviewIndex >= total },
                  { icon: <NavLast />, action: () => go(total), disabled: reviewIndex >= total },
                ].map((btn, i) => (
                  <button key={i} onClick={btn.action} disabled={btn.disabled} style={{
                    background: '#3c3a38', color: '#fff', border: 'none', padding: '8px 12px', borderRadius: '4px',
                    opacity: btn.disabled ? 0.5 : 1, cursor: btn.disabled ? 'default' : 'pointer', fontWeight: 'bold',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    {btn.icon}
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────
export default function GamesPanel() {
  const [platform, setPlatform] = useState<Platform>("all");
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccounts>({
    lichess: "",
    chessCom: "",
  });
  const [games, setGames] = useState<GameRow[]>([]);
  const [stats, setStats] = useState<GamesResponse["stats"]>({
    total: 0, pending: 0, processing: 0, analyzed: 0, failed: 0,
  });
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [review, setReview] = useState<LiveReviewResponse | null>(null);
  const [reviewIndex, setReviewIndex] = useState(0);

  useEffect(() => {
    const refreshLinkedAccounts = () => {
      setLinkedAccounts(readLinkedAccounts());
    };

    refreshLinkedAccounts();
    window.addEventListener("focus", refreshLinkedAccounts);
    window.addEventListener("storage", refreshLinkedAccounts);
    return () => {
      window.removeEventListener("focus", refreshLinkedAccounts);
      window.removeEventListener("storage", refreshLinkedAccounts);
    };
  }, []);

  const loadGames = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setLoading(true);
      setMessage("");
    }

    try {
      const params = new URLSearchParams({ platform, limit: "300" });
      const res = await fetch(`/api/games?${params.toString()}`);
      const json = (await res.json()) as GamesResponse & { error?: string };

      if (!res.ok) {
        if (!silent) setMessage(json.error ?? "Failed to load games.");
        return;
      }

      setGames(json.games ?? []);
      setStats((prev) => json.stats ?? prev);
      const ids = new Set((json.games ?? []).map((g) => g.id));
      setSelectedGameId((prev) => (prev && ids.has(prev) ? prev : (json.games?.[0]?.id ?? null)));
    } catch {
      if (!silent) setMessage("Network error while loading games.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    void loadGames();
  }, [loadGames]);

  const selectedGame = useMemo(
    () => games.find((g) => g.id === selectedGameId) ?? null,
    [games, selectedGameId]
  );
  const hasRunningAnalysis = useMemo(
    () => games.some((g) => g.status === "pending" || g.status === "processing"),
    [games]
  );
  const viewerUsernames = useMemo(
    () => getAllViewerUsernames(linkedAccounts),
    [linkedAccounts]
  );

  useEffect(() => {
    if (!hasRunningAnalysis || review) return;

    const intervalId = window.setInterval(() => {
      void loadGames({ silent: true });
    }, 4000);

    return () => window.clearInterval(intervalId);
  }, [hasRunningAnalysis, loadGames, review]);

  async function queueSelectedGame() {
    if (!selectedGameId || !selectedGame) { setMessage("Select a game first."); return; }
    const selectedPlatform = inferPlatformFromGameId(selectedGame.lichess_game_id);
    const selectedUsername = getLinkedUsername(linkedAccounts, selectedPlatform);

    setActionLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameIds: [selectedGameId],
          platform,
          username: selectedUsername,
          viewerUsernames,
        }),
      });
      const json = (await res.json()) as { selected?: number; queued?: number; queueUnavailable?: boolean; error?: string };
      if (!res.ok) {
        setMessage(json.error ?? "Failed to queue selected games.");
      } else if (json.queueUnavailable) {
        setMessage("Redis queue offline. Start Redis + worker and try again.");
      } else {
        setMessage(`Queued (${json.queued ?? 0}/${json.selected ?? 0}).`);
      }
      await loadGames();
    } catch {
      setMessage("Network error while queueing.");
    } finally {
      setActionLoading(false);
    }
  }

  async function recoverStuckGames() {
    const stuckIds = games
      .filter((game) => game.status === "processing")
      .map((game) => game.id);

    if (stuckIds.length === 0) {
      setMessage("No stuck processing games found.");
      return;
    }

    setActionLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameIds: stuckIds,
          viewerUsernames,
        }),
      });
      const json = (await res.json()) as { selected?: number; queued?: number; error?: string; queueUnavailable?: boolean };

      if (!res.ok) {
        setMessage(json.error ?? "Failed to recover stuck games.");
      } else if (json.queueUnavailable) {
        setMessage("Redis queue offline. Start Redis + worker and retry recovery.");
      } else {
        setMessage(`Recovery queued (${json.queued ?? 0}/${json.selected ?? stuckIds.length}).`);
      }

      await loadGames();
    } catch {
      setMessage("Network error while recovering stuck games.");
    } finally {
      setActionLoading(false);
    }
  }

  async function openLiveReview(gameId = selectedGameId) {
    if (!gameId) { setMessage("Select a game first."); return; }
    setReviewLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/live-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, viewerUsernames }),
      });
      const json = (await res.json()) as LiveReviewResponse;
      if (!res.ok) {
        setMessage(json.error ?? "Could not open live review for this game.");
      } else {
        setReview(json);
        setReviewIndex(0);
      }
    } catch {
      setMessage("Network error while opening live review.");
    } finally {
      setReviewLoading(false);
    }
  }

  // ── Review mode: full chess.com-style layout ───────────────────
  if (review) {
    return (
      <ReviewView
        review={review}
        reviewIndex={reviewIndex}
        setReviewIndex={setReviewIndex}
        onClose={() => { setReview(null); setReviewIndex(0); }}
      />
    );
  }

  // ── Games list ─────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: "16px 20px", gap: "10px" }}>

      {/* Filters + actions */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          {(["all", "lichess", "chess.com"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              style={{
                padding: "5px 10px",
                borderRadius: "6px",
                border: platform === p ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: platform === p ? "var(--accent-dim)" : "transparent",
                color: platform === p ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: "12px",
                fontFamily: "inherit",
              }}
            >
              {p === "all" ? "All" : p === "lichess" ? "Lichess" : "Chess.com"}
            </button>
          ))}
          <Button variant="secondary" size="sm" onClick={() => void loadGames()} disabled={loading}>
            {loading ? "…" : "Refresh"}
          </Button>
        </div>

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <Button variant="secondary" size="sm" onClick={() => void queueSelectedGame()} disabled={actionLoading || !selectedGameId}>
            {actionLoading ? "…" : selectedGame?.status === "processing" ? "Re-queue (stuck)" : "Queue Analysis"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void recoverStuckGames()}
            disabled={actionLoading || stats.processing === 0}
          >
            Recover All Stuck
          </Button>
          <Button variant="primary" size="sm" onClick={() => void openLiveReview()} disabled={reviewLoading || !selectedGameId}>
            {reviewLoading ? "…" : "Live Review"}
          </Button>
        </div>
      </div>

      {/* Stats + message */}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", fontSize: "11px", color: "var(--text-muted)", flexShrink: 0 }}>
        <span>
          Linked: <b style={{ color: "var(--text-secondary)" }}>
            {linkedAccounts.lichess ? `L ${linkedAccounts.lichess}` : "L -"}
            {" · "}
            {linkedAccounts.chessCom ? `C ${linkedAccounts.chessCom}` : "C -"}
          </b>
        </span>
        <span>Total: <b style={{ color: "var(--text-secondary)" }}>{stats.total}</b></span>
        <span>Pending: <b style={{ color: "var(--orange)" }}>{stats.pending}</b></span>
        {stats.processing > 0 && <span>Processing: <b style={{ color: "var(--blue)" }}>{stats.processing}</b></span>}
        <span>Analyzed: <b style={{ color: "var(--green)" }}>{stats.analyzed}</b></span>
        {stats.failed > 0 && <span>Failed: <b style={{ color: "var(--red)" }}>{stats.failed}</b></span>}
        {hasRunningAnalysis && <span>Auto-refreshing while analysis runs</span>}
      </div>
      {message && <div style={{ fontSize: "12px", color: "var(--text-secondary)", flexShrink: 0 }}>{message}</div>}

      {/* Games table */}
      <div style={{
        flex: 1,
        minHeight: 0,
        border: "1px solid var(--border)",
        borderRadius: "10px",
        background: "var(--bg-surface)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 100px 80px 90px",
          gap: "8px",
          padding: "9px 14px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-elevated)",
          fontSize: "11px",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          flexShrink: 0,
        }}>
          <div>Players</div>
          <div>Played</div>
          <div>Result</div>
          <div>Status</div>
        </div>

        {/* Rows */}
        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "4px", padding: "6px 8px" }}>
          {games.map((g) => {
            const isSelected = g.id === selectedGameId;
            const gamePlatform = inferPlatformFromGameId(g.lichess_game_id);
            const linkedUsername = getLinkedUsername(linkedAccounts, gamePlatform);
            const youAreWhite = usernameMatchesPlayer(linkedUsername, g.white_username);
            const youAreBlack = usernameMatchesPlayer(linkedUsername, g.black_username);
            return (
              <button
                key={g.id}
                onClick={() => { setSelectedGameId(g.id); setMessage(""); }}
                onDoubleClick={() => { setSelectedGameId(g.id); void openLiveReview(g.id); }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 100px 80px 90px",
                  gap: "8px",
                  padding: "9px 14px",
                  borderRadius: "7px",
                  border: isSelected ? "1px solid var(--accent)" : "1px solid transparent",
                  background: isSelected ? "var(--accent-dim)" : "transparent",
                  alignItems: "center",
                  fontSize: "12px",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "background 100ms ease",
                }}
                onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-elevated)"; }}
                onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--text-primary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "6px" }}>
                    <span>{g.white_username}{youAreWhite ? " (You)" : ""} vs {g.black_username}{youAreBlack ? " (You)" : ""}</span>
                    <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>{gamePlatform === "chess.com" ? "Chess.com" : "Lichess"}</span>
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: "11px" }}>
                    {g.white_rating ?? "?"} / {g.black_rating ?? "?"} · {g.time_control}
                  </div>
                </div>
                <div style={{ color: "var(--text-secondary)", fontSize: "11px" }}>
                  {new Date(g.played_at).toLocaleDateString()}
                </div>
                <div style={{ color: "var(--text-secondary)", textTransform: "capitalize" }}>{g.result}</div>
                <div style={{ color: statusColor(g.status), fontWeight: 600, textTransform: "capitalize", fontSize: "11px" }}>
                  {g.status}
                </div>
              </button>
            );
          })}

          {games.length === 0 && !loading && (
            <div style={{ padding: "32px", color: "var(--text-muted)", textAlign: "center", fontSize: "13px" }}>
              No games found. Link account(s) and sync to get started.
            </div>
          )}
        </div>
      </div>

      <div style={{ fontSize: "11px", color: "var(--text-muted)", flexShrink: 0 }}>
        Double-click a game to open Live Review · Select + Queue Analysis to analyse
      </div>
    </div>
  );
}
