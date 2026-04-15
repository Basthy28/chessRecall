"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Square } from "chess.js";
import type { Key } from "chessground/types";
import Button from "@/components/ui/Button";
import ChessBoard, { type MoveAnnotationOverlay } from "@/components/board/ChessBoard";
import MoveTree, { type UnifiedNode } from "./MoveTree";
import { getClientAuthHeaders } from "@/lib/supabase";
import {
  getAllViewerUsernames,
  getLinkedUsername,
  inferPlatformFromGameId,
  readLinkedAccounts,
  saveLinkedAccounts,
  syncLinkedAccountsToSupabase,
  usernameMatchesPlayer,
  type LinkedAccounts,
} from "@/lib/linkedAccounts";
import { LIVE_ANALYSIS_DEPTH, useLiveAnalysis } from "@/hooks/useLiveAnalysis";

const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 min between auto-syncs
const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

function getLastSyncKey(p: "lichess" | "chess.com", username: string) {
  return `lastSync_${p}_${username}`;
}
function getLastSyncMs(p: "lichess" | "chess.com", username: string): number {
  try { const v = localStorage.getItem(getLastSyncKey(p, username)); return v ? parseInt(v, 10) : 0; } catch { return 0; }
}
function setLastSyncMs(p: "lichess" | "chess.com", username: string) {
  try { localStorage.setItem(getLastSyncKey(p, username), String(Date.now())); } catch { /**/ }
}
import { useGameAnalysis } from "@/hooks/useGameAnalysis";
import type { DrawShape } from "chessground/draw";
import { lookupOpening } from "@/lib/ecoBook";
import type { OpeningInfo } from "@/lib/ecoBook";
import {
  classifyReviewedMove,
  type PositionEvaluationSnapshot,
} from "@/lib/reviewReporter";
import {
  ClassificationIcon,
  EvalBar,
  EvalGraph,
  PlayerChip,
  PlayerAvatar,
  formatClock,
  formatEval,
  parseInitialClockSeconds,
  statusColor,
} from "@/components/training/games/reviewUi";

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
  nextCursor: string | null;
}

interface ImportResponse {
  imported?: number;
  queued?: number;
  skippedQueue?: number;
  analyzeLimit?: number;
  queueUnavailable?: boolean;
  cooldownRemainingMs?: number;
  error?: string;
}


interface LiveReviewResponse {
  game: {
    id: string;
    lichessGameId?: string;
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

interface GamesPanelProps {
  requestedReviewTarget?: {
    gameId: string;
    reviewIndex?: number;
    sidebarTab?: "engine" | "report";
    viewerColor?: "white" | "black";
  } | null;
  onRequestedReviewHandled?: () => void;
}

/** Minimum depth before showing live move classification. Prevents premature annotations. */
const MIN_CLASSIFY_DEPTH = LIVE_ANALYSIS_DEPTH;

const CLASSIFICATION_COLOR: Record<string, string> = {
  brilliant: "#1baca6",  // teal  — !!
  great:     "#5c8fe0",  // blue  — Critical !
  best:      "#81b64c",  // green — ★
  excellent: "#96bc4b",  // lime  — 👍
  good:      "#5cb85c",  // green — ✓  (Okay)
  inaccuracy:"#e8b84b",  // amber — ?!
  mistake:   "#e8802a",  // orange — ?
  blunder:   "#f05149",  // red   — ??
  miss:      "#f05149",
  book:      "#b09f87",  // tan   — Theory
};

const CLASSIFICATION_LABEL: Record<string, string> = {
  brilliant:  "Brilliant !!",
  great:      "Critical !",
  best:       "Best",
  excellent:  "Excellent",
  good:       "Okay",
  inaccuracy: "Inaccuracy ?!",
  mistake:    "Mistake ?",
  blunder:    "Blunder ??",
  miss:       "Missed win",
  book:       "Theory",
};

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


// ── Eval graph ─────────────────────────────────────────────────────
// ── Full-screen chess.com-style review view ────────────────────────
function ReviewView({
  review,
  reviewIndex,
  setReviewIndex,
  initialSidebarTab,
  preferredViewerColor,
  onClose,
}: {
  review: LiveReviewResponse;
  reviewIndex: number;
  setReviewIndex: React.Dispatch<React.SetStateAction<number>>;
  initialSidebarTab?: "engine" | "report";
  preferredViewerColor?: "white" | "black" | null;
  onClose: () => void;
}) {
  const [windowWidth, setWindowWidth] = useState(1280);
  const effectiveViewerColor = review.game.playerColor ?? preferredViewerColor ?? null;
  const [orientation, setOrientation] = useState<"white" | "black">(
    effectiveViewerColor === "black" ? "black" : "white"
  );

  const initialTree = useMemo(() => {
    const root: UnifiedNode = { uci: "", san: "", fen: review.positions[0], ply: 0, timeSpentMs: null, children: [] };
    let curr = root;
    for (let i = 0; i < review.moves.length; i++) {
      const rm = review.moves[i];
      const uci = rm.from + rm.to;
      const child: UnifiedNode = { uci, san: rm.san, fen: review.positions[i + 1], ply: rm.ply, timeSpentMs: rm.timeSpentMs, children: [] };
      curr.children.push(child);
      curr = child;
    }
    return root;
  }, [review]);


  const [rootNode, setRootNode] = useState<UnifiedNode>(initialTree);
  const [preferredChildren, setPreferredChildren] = useState<Record<string, string>>({});
  
  const [activePath, setActivePath] = useState<string[]>(() => {
    const p: string[] = [];
    let curr = initialTree;
    for (let i = 0; i < Math.max(0, reviewIndex); i++) {
      if (curr.children.length === 0) break;
      p.push(curr.children[0].uci);
      curr = curr.children[0];
    }
    return p;
  });

  const seekToPosition = useCallback((idx: number) => {
    setActivePath(review.moves.slice(0, idx).map(m => m.from + m.to));
  }, [review.moves]);

  const getActiveNode = useCallback(() => {
    let curr = rootNode;
    for (const uci of activePath) {
      const next = curr.children.find(c => c.uci === uci);
      if (!next) break;
      curr = next;
    }
    return curr;
  }, [rootNode, activePath]);

  const activeNode = getActiveNode();
  const activeFen = activeNode.fen;

  useEffect(() => {
    setReviewIndex(activePath.length);
  }, [activePath.length, setReviewIndex]);

  const { lines, depth, isSearching, error } = useLiveAnalysis(activeFen);

  // ── Sidebar tab ───────────────────────────────────────────────────────────
  const [sidebarTab, setSidebarTab] = useState<"engine" | "report">(initialSidebarTab ?? "engine");

  // ── Background full-game analysis ────────────────────────────────────────
  const gameAnalysis = useGameAnalysis(review.positions, review.moves);
  const snapshotByFen = useMemo(() => {
    const map = new Map<string, PositionEvaluationSnapshot>();
    for (const snapshot of gameAnalysis.snapshots) {
      map.set(snapshot.fen, snapshot);
    }
    return map;
  }, [gameAnalysis.snapshots]);

  // ── Opening: keep the last book hit along the currently selected path ────
  const currentOpening = useMemo((): OpeningInfo | null => {
    let opening = lookupOpening(review.positions[0]) ?? null;
    let node = rootNode;
    for (const uci of activePath) {
      const next = node.children.find((child) => child.uci === uci);
      if (!next) break;
      node = next;
      const nextOpening = lookupOpening(node.fen);
      if (nextOpening) opening = nextOpening;
    }
    return opening;
  }, [activePath, review.positions, rootNode]);

  const isMainlinePath = useMemo(() => (
    activePath.every((uci, index) => {
      const move = review.moves[index];
      return !!move && uci === `${move.from}${move.to}`;
    })
  ), [activePath, review.moves]);

  const mainlineClassification = useMemo(() => {
    if (!isMainlinePath || activePath.length === 0) return null;
    const move = review.moves[activePath.length - 1];
    if (!move) return null;
    return gameAnalysis.moves.find((analysis) => (
      analysis.ply === move.ply && analysis.san === move.san
    ))?.classification ?? null;
  }, [activePath.length, gameAnalysis.moves, isMainlinePath, review.moves]);

  const liveCurrentSnapshot = useMemo((): PositionEvaluationSnapshot | null => {
    if (lines.length === 0 || depth < MIN_CLASSIFY_DEPTH) return null;
    return {
      fen: activeFen,
      score: lines[0].score,
      depth,
      topMove: lines[0].move,
      secondScore: lines[1]?.score,
    };
  }, [activeFen, lines, depth]);

  const liveClassification = useMemo(() => {
    if (mainlineClassification) return mainlineClassification;
    if (activePath.length === 0) return null;

    let parentNode = rootNode;
    for (const uci of activePath.slice(0, -1)) {
      const next = parentNode.children.find((child) => child.uci === uci);
      if (!next) return null;
      parentNode = next;
    }

    const parentFen = parentNode.fen;
    const previous = snapshotByFen.get(parentFen);
    const current = snapshotByFen.get(activeFen) ?? liveCurrentSnapshot;
    const playedUci = activePath[activePath.length - 1];

    if (!previous || !current) return null;

    return classifyReviewedMove({
      parentFen,
      currentFen: activeFen,
      playedUci,
      previous,
      current,
    });
  }, [activePath, activeFen, liveCurrentSnapshot, mainlineClassification, rootNode, snapshotByFen]);


  const boardBoxRef = useRef<HTMLDivElement | null>(null);
  const boardSlotRef = useRef<HTMLDivElement | null>(null);
  const [boardHeight, setBoardHeight] = useState<number | null>(null);
  const [boardSlotSize, setBoardSlotSize] = useState<{ width: number; height: number } | null>(null);
  const [promotionPending, setPromotionPending] = useState<{ orig: Key; dest: Key; color: "w" | "b" } | null>(null);

  // Engine best-move arrows: subtle colours only, top 2 lines
  const engineShapes = useMemo((): DrawShape[] => {
    if (lines.length === 0 || depth < 4) return [];
    return lines.slice(0, 2).map((line, i) => ({
      orig: line.move.slice(0, 2) as Key,
      dest: line.move.slice(2, 4) as Key,
      brush: i === 0 ? "paleBlue" : "paleGrey",
    }));
  }, [lines, depth]);

  const isCompact = windowWidth < 1100;
  const boardSize = useMemo(() => {
    if (!boardSlotSize) return null;
    if (isCompact) {
      const size = Math.floor(Math.min(boardSlotSize.width, 560) - 2);
      return size > 0 ? size : null;
    }
    const chromeWidth = isCompact ? 0 : 24 + 42;
    const max = isCompact ? 560 : 920;
    const reservedVertical = 86;
    const usableHeight = Math.max(0, boardSlotSize.height - reservedVertical);
    const size = Math.floor(Math.max(0, Math.min(usableHeight, boardSlotSize.width - chromeWidth, max) - 2));
    return size > 0 ? size : null;
  }, [boardSlotSize, isCompact]);

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

  const goLeft = useCallback(() => {
    setActivePath(prev => prev.slice(0, Math.max(0, prev.length - 1)));
  }, []);

  const goRight = useCallback(() => {
    setActivePath(prev => {
      let curr = rootNode;
      for (const uci of prev) {
        const next = curr.children.find(c => c.uci === uci);
        if (!next) return prev;
        curr = next;
      }
      if (curr.children.length === 0) return prev;
      
      let nextUci = curr.children[0].uci;
      const prefStr = prev.join(",");
      if (preferredChildren[prefStr]) {
        const pref = preferredChildren[prefStr];
        if (curr.children.some(c => c.uci === pref)) {
          nextUci = pref;
        }
      }
      return [...prev, nextUci];
    });
  }, [rootNode, preferredChildren]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goLeft();
      if (e.key === "ArrowRight") goRight();
      if (e.key === "Home") setActivePath([]);
      if (e.key === "End") {
         setActivePath(prev => {
           const np = [...prev];
           let curr = rootNode;
           for (const uci of np) {
             const next = curr.children.find(c => c.uci === uci);
             if (!next) return prev;
             curr = next;
           }
           while(curr.children.length > 0) {
             const prefStr = np.join(",");
             let nextUci = curr.children[0].uci;
             if (preferredChildren[prefStr]) {
                const pref = preferredChildren[prefStr];
                if (curr.children.some(c => c.uci === pref)) nextUci = pref;
             }
             np.push(nextUci);
             const next = curr.children.find(c => c.uci === nextUci);
             if(!next) break;
             curr = next;
           }
           return np;
         });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goLeft, goRight, rootNode, preferredChildren]);

  // Always-up-to-date ref so applyBranchSequence never has a stale closure.
  const activePathRef = useRef(activePath);
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);
  const rootNodeRef = useRef(rootNode);
  useEffect(() => { rootNodeRef.current = rootNode; }, [rootNode]);

  const applyBranchSequence = useCallback((uciMoves: string[]) => {
    if (uciMoves.length === 0) return;

    // Read the current values from refs — never stale.
    const currentPath = activePathRef.current;
    const currentRoot: UnifiedNode = JSON.parse(JSON.stringify(rootNodeRef.current));

    // Walk to the current active node inside the cloned tree.
    let currNode = currentRoot;
    for (const uci of currentPath) {
      const next = currNode.children.find((c: UnifiedNode) => c.uci === uci);
      if (!next) break;
      currNode = next;
    }

    let currState = [...currentPath];
    const pathsToPref: { pathStr: string; uci: string }[] = [];

    for (const uciMove of uciMoves) {
      let existingChild = currNode.children.find((c: UnifiedNode) => c.uci === uciMove);
      if (!existingChild) {
        const tryPlay = (positionFen: string) => {
          const chess = new Chess(positionFen);
          try {
            const move = uciMove.length > 4
              ? chess.move({ from: uciMove.slice(0, 2), to: uciMove.slice(2, 4), promotion: uciMove.slice(4, 5) })
              : chess.move({ from: uciMove.slice(0, 2), to: uciMove.slice(2, 4) });
            if (!move) return null;
            return { san: move.san, fen: chess.fen() };
          } catch { return null; }
        };

        const res = tryPlay(currNode.fen);
        if (!res) break; // Illegal move for this side — just ignore.

        existingChild = {
          uci: uciMove,
          san: res.san,
          fen: res.fen,
          ply: currNode.ply + 1,
          timeSpentMs: null,
          children: [],
        };
        currNode.children.push(existingChild);
      }

      pathsToPref.push({ pathStr: currState.join(","), uci: uciMove });
      currState = [...currState, uciMove];
      currNode = existingChild;
    }

    // Two independent state updates — never nested.
    setRootNode(currentRoot);
    setActivePath(currState);
    if (pathsToPref.length > 0) {
      setPreferredChildren(prev => {
        const next = { ...prev };
        for (const pt of pathsToPref) next[pt.pathStr] = pt.uci;
        return next;
      });
    }
  }, []); // Empty deps — reads always-fresh values via refs.

  const handleBoardMove = useCallback(
    (orig: Key, dest: Key) => {
      try {
        let currNode = rootNodeRef.current;
        for (const uciStep of activePathRef.current) {
          const next = currNode.children.find(c => c.uci === uciStep);
          if (!next) break;
          currNode = next;
        }
        const chess = new Chess(currNode.fen);
        const piece = chess.get(orig as Square);
        if (
          piece?.type === "p" &&
          ((piece.color === "w" && dest[1] === "8") ||
           (piece.color === "b" && dest[1] === "1"))
        ) {
          setPromotionPending({ orig, dest, color: piece.color });
          return;
        }
      } catch { /* ignore */ }
      applyBranchSequence([`${orig}${dest}`]);
    },
    [applyBranchSequence]
  );

  const handlePromotion = useCallback((piece: "q" | "r" | "b" | "n") => {
    if (!promotionPending) return;
    applyBranchSequence([`${promotionPending.orig}${promotionPending.dest}${piece}`]);
    setPromotionPending(null);
  }, [promotionPending, applyBranchSequence]);
  
  const handleSelectPath = useCallback((path: string[]) => {
    setActivePath(path);
  }, []);

  // True when the active path diverges from the recorded game moves.
  const isInVariation = useMemo(() => {
    for (let i = 0; i < activePath.length; i++) {
      const mainUci = review.moves[i] ? review.moves[i].from + review.moves[i].to : null;
      if (mainUci === null || activePath[i] !== mainUci) return true;
    }
    return false;
  }, [activePath, review.moves]);

  // Detect terminal position (checkmate, stalemate, draw) for the active node.
  const gameOverResult = useMemo(() => {
    try {
      const chess = new Chess(activeFen);
      if (chess.isCheckmate()) {
        // The side that just moved won
        return chess.turn() === "b" ? "1-0" : "0-1";
      }
      if (chess.isStalemate() || chess.isDraw() || chess.isThreefoldRepetition() || chess.isInsufficientMaterial()) {
        return "½-½";
      }
    } catch { /* ignore */ }
    return null;
  }, [activeFen]);

  // Board annotation: live WASM classification only — wait for stable depth
  const boardAnnotation = useMemo((): MoveAnnotationOverlay | undefined => {
    if (activePath.length === 0) return undefined;
    // Don't show annotation while searching at shallow depth
    if (isSearching && depth < MIN_CLASSIFY_DEPTH) return undefined;

    const cls: string = liveClassification ?? "";

    if (!cls || cls === "book" || cls === "excellent" || cls === "good") return undefined;

    const lastUci = activePath[activePath.length - 1];
    const destSquare = lastUci.slice(2, 4) as Key;
    const SYMBOLS: Record<string, string> = {
      brilliant: "!!", great: "!", best: "★", inaccuracy: "?!", mistake: "?", blunder: "??", miss: "✗",
    };
    const symbol = SYMBOLS[cls];
    if (!symbol) return undefined;
    return { square: destSquare, symbol, color: CLASSIFICATION_COLOR[cls] ?? "#999" };
  }, [activePath, liveClassification, depth, isSearching]);


  const resultLabel = review.game.result === "win" ? "1-0" : review.game.result === "loss" ? "0-1" : "½-½";
  const whiteEval = lines[0]?.score ?? 0;
  const viewerColor = effectiveViewerColor;
  // Clock reflects time remaining at the CURRENT position (up to activePath.length mainline moves).
  // For branch moves (ply > review.moves.length) we just freeze at the last known clock.
  const initialClockSeconds = useMemo(
    () => parseInitialClockSeconds(review.game.timeControl),
    [review.game.timeControl]
  );
  const clockAtPosition = useMemo(() => {
    if (initialClockSeconds === null) return { whiteClock: null, blackClock: null };
    let whiteMs = 0;
    let blackMs = 0;
    // Only sum up to the current depth in the mainline.
    const depth = Math.min(activePath.length, review.moves.length);
    for (let i = 0; i < depth; i++) {
      const move = review.moves[i];
      if (typeof move?.timeSpentMs !== "number") continue;
      if (move.ply % 2 === 1) whiteMs += move.timeSpentMs;
      else blackMs += move.timeSpentMs;
    }
    return {
      whiteClock: Math.max(0, initialClockSeconds - Math.floor(whiteMs / 1000)),
      blackClock: Math.max(0, initialClockSeconds - Math.floor(blackMs / 1000)),
    };
  }, [initialClockSeconds, activePath.length, review.moves]);
  const { whiteClock, blackClock } = clockAtPosition;
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        height: isCompact ? "auto" : "calc(100dvh - 56px)",
        minHeight: 0,
        maxHeight: isCompact ? "none" : "calc(100dvh - 56px)",
        overflowY: isCompact ? "auto" : "hidden",
        overflowX: "hidden",
        background: "var(--bg-base)",
      }}
    >
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
          <PlayerAvatar name={review.game.white} size={22} platform={inferPlatformFromGameId(review.game.lichessGameId ?? review.game.id)} />
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {review.game.white}
          </span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)", flexShrink: 0 }}>vs</span>
          <PlayerAvatar name={review.game.black} size={22} platform={inferPlatformFromGameId(review.game.lichessGameId ?? review.game.id)} />
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {review.game.black}
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
        {currentOpening && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto", flexShrink: 0 }}>
            <span style={{
              padding: "2px 8px",
              borderRadius: "4px",
              background: "rgba(176,159,135,0.15)",
              border: "1px solid rgba(176,159,135,0.3)",
              fontSize: "11px",
              fontWeight: 600,
              color: "#b09f87",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "280px",
            }}>
              {currentOpening.eco} · {currentOpening.name}
            </span>
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: isCompact ? "column" : "row",
          flex: isCompact ? "0 0 auto" : 1,
          height: isCompact ? "auto" : "100%",
          minHeight: 0,
          overflow: "visible",
        }}
      >
        <div style={{
          flex: isCompact ? "0 0 auto" : 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: isCompact ? "10px 12px 12px" : "18px 24px",
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
              height: isCompact ? "auto" : "100%",
              maxHeight: isCompact ? "none" : "100%",
              width: "100%",
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              alignSelf: "stretch",
              justifyContent: "center",
            }}
          >
            {!isCompact && <EvalBar score={whiteEval} orientation={orientation} gameResult={gameOverResult} />}
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
                  {isInVariation && (
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
                  {promotionPending && (
                    <div style={{
                      position: "absolute",
                      inset: 0,
                      zIndex: 10,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(0,0,0,0.55)",
                      borderRadius: "6px",
                    }}>
                      <div style={{
                        background: "#2c2b29",
                        border: "1px solid #4a4846",
                        borderRadius: "10px",
                        padding: "14px 18px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "10px",
                        alignItems: "center",
                        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                      }}>
                        <div style={{ fontSize: "12px", color: "#aaa", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>Promote to</div>
                        <div style={{ display: "flex", gap: "8px" }}>
                          {(["q", "r", "b", "n"] as const).map(p => {
                            const wSymbols = { q: "♕", r: "♖", b: "♗", n: "♘" };
                            const bSymbols = { q: "♛", r: "♜", b: "♝", n: "♞" };
                            const sym = promotionPending.color === "w" ? wSymbols[p] : bSymbols[p];
                            const labels = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };
                            return (
                              <button
                                key={p}
                                onClick={() => handlePromotion(p)}
                                title={labels[p]}
                                style={{
                                  width: "62px",
                                  height: "62px",
                                  fontSize: "40px",
                                  background: "#3c3a38",
                                  border: "2px solid #5a5856",
                                  borderRadius: "8px",
                                  cursor: "pointer",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  color: promotionPending.color === "w" ? "#f0ddb5" : "#1a1917",
                                  textShadow: promotionPending.color === "w" ? "0 1px 3px #000" : "0 1px 3px rgba(255,255,255,0.4)",
                                  transition: "background 120ms ease, border-color 120ms ease",
                                  lineHeight: 1,
                                }}
                                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#52504e"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#81b64c"; }}
                                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "#3c3a38"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#5a5856"; }}
                              >
                                {sym}
                              </button>
                            );
                          })}
                        </div>
                        <button
                          onClick={() => setPromotionPending(null)}
                          style={{ fontSize: "11px", color: "#777", background: "none", border: "none", cursor: "pointer", padding: "2px 8px", fontFamily: "inherit" }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  <ChessBoard
                    fen={activeFen}
                    orientation={orientation}
                    interactive
                    onMove={handleBoardMove}
                    showCoordinates
                    annotation={boardAnnotation}
                    shapes={engineShapes}
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

        {/* ── Right panel — analysis sidebar ─────────────────────────────── */}
        <style>{`
          @keyframes shimmer {
            0%   { background-position: -200% 0; }
            100% { background-position:  200% 0; }
          }
          @keyframes cgPulse {
            0%,100% { opacity: 1; }
            50%      { opacity: 0.3; }
          }
        `}</style>
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

          {/* Sidebar header: tab switcher + engine status */}
          <div style={{ background: "#211f1c", borderBottom: "1px solid #3c3a38", flexShrink: 0 }}>
            {/* Tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid #3c3a38" }}>
              {(["engine", "report"] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setSidebarTab(tab)}
                  style={{
                    flex: 1, padding: "7px 0",
                    background: sidebarTab === tab ? "#262421" : "transparent",
                    border: "none",
                    borderBottom: sidebarTab === tab ? "2px solid #81b64c" : "2px solid transparent",
                    color: sidebarTab === tab ? "#fff" : "#666",
                    fontSize: "11px", fontWeight: 700, cursor: "pointer",
                    fontFamily: "inherit", letterSpacing: "0.06em", textTransform: "uppercase",
                    transition: "color 150ms ease",
                  }}
                >
                  {tab === "engine" ? "Engine" : "Report"}
                </button>
              ))}
            </div>
            {/* Engine status row (always visible for depth feedback) */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{
                  width: "7px", height: "7px", borderRadius: "50%",
                  background: isSearching ? "#81b64c" : "#444",
                  animation: isSearching ? "cgPulse 1.4s ease-in-out infinite" : "none",
                  flexShrink: 0, transition: "background 300ms ease",
                }} />
                <span style={{ fontSize: "11px", fontWeight: 700, color: "#aaa", letterSpacing: "0.06em" }}>SF18</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {gameAnalysis.isAnalyzing && (
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <div style={{ width: "60px", height: "4px", borderRadius: "2px", background: "#333", overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${gameAnalysis.progress}%`,
                        background: "#5ca0d3", borderRadius: "2px",
                        transition: "width 300ms ease",
                      }} />
                    </div>
                    <span style={{ fontSize: "10px", color: "#5ca0d3", fontVariantNumeric: "tabular-nums" }}>
                      {gameAnalysis.progress}%
                    </span>
                  </div>
                )}
                <span style={{ fontSize: "11px", color: depth > 0 ? "#81b64c" : "#555", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  {depth > 0 ? `d${depth}` : isSearching ? "…" : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* Classified move card — live WASM classification */}
          {sidebarTab === "engine" && (() => {
            if (activePath.length === 0 || gameOverResult) return null;

                const rawCls = liveClassification ?? null;
                const cls: string = rawCls ?? "";
            const color = cls ? (CLASSIFICATION_COLOR[cls] ?? "#999") : null;
            const label = cls ? (CLASSIFICATION_LABEL[cls] ?? cls) : null;
            const bestSan = lines[0]?.san ?? null;
            const lastMoveSan = activeNode.san;
            const showBestWas = cls && !["best","brilliant","great","book","none","excellent","good"].includes(cls) && bestSan;

            // Show loading skeleton while engine hasn't reached the minimum classify depth
            const isLoading = isSearching && depth < MIN_CLASSIFY_DEPTH;

            return (
              <div style={{
                padding: "8px 12px", background: "#2a2826", borderBottom: "1px solid #3c3a38", flexShrink: 0, minHeight: "48px",
              }}>
                {isLoading ? (
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "linear-gradient(90deg, #2c2b29 25%, #3d3b38 50%, #2c2b29 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", flexShrink: 0 }} />
                    <div style={{ flex: 1, height: "14px", borderRadius: "4px", background: "linear-gradient(90deg, #2c2b29 25%, #3d3b38 50%, #2c2b29 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite 0.1s" }} />
                  </div>
                ) : cls && color && label ? (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: showBestWas ? "3px" : 0 }}>
                      <span style={{ background: color, borderRadius: "50%", width: "8px", height: "8px", flexShrink: 0 }} />
                      <span style={{ fontSize: "13px", fontWeight: 700, color }}>
                        {lastMoveSan}
                      </span>
                      <span style={{ fontSize: "12px", color: "#888", fontWeight: 400 }}>is {label}</span>
                    </div>
                    {showBestWas && (
                      <div style={{ fontSize: "12px", color: "#666", paddingLeft: "15px" }}>
                        Best was <span style={{ color: "#81b64c", fontWeight: 700 }}>{bestSan}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: "12px", color: "#555", lineHeight: 1.5 }}>
                    {activePath.length > 0 ? "Analysing…" : "Navigate moves to see classifications"}
                  </div>
                )}
              </div>
            );
          })()}


          {/* Engine lines area — engine tab only */}
          {sidebarTab === "engine" && <div style={{ flexShrink: 0, borderBottom: "1px solid #3c3a38" }}>
            {gameOverResult ? (
              <div style={{ padding: "12px", textAlign: "center" }}>
                <div style={{ fontSize: "22px", fontWeight: 900, color: "#fff", letterSpacing: "0.04em" }}>{gameOverResult}</div>
                <div style={{ fontSize: "12px", color: "#999", marginTop: "4px" }}>
                  {gameOverResult === "½-½" ? "Draw" : gameOverResult === "1-0" ? `${review.game.white} wins` : `${review.game.black} wins`}
                </div>
              </div>
            ) : error ? (
              <div style={{ padding: "8px 12px", fontSize: "12px", color: "#ff6666" }}>{error}</div>
            ) : (
              (isSearching && depth < 6 ? [null, null, null] as (null)[] : lines.slice(0, 3)).map((line, idx) =>
                line ? (
                  <div
                    key={idx}
                    onClick={() => applyBranchSequence(line.pvUci.length > 0 ? line.pvUci : [line.move])}
                    style={{
                      display: "flex", alignItems: "center", gap: "8px", padding: "7px 10px",
                      background: idx === 0 ? "rgba(129,182,76,0.07)" : "transparent",
                      borderBottom: idx < 2 ? "1px solid rgba(255,255,255,0.04)" : "none",
                      cursor: "pointer",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = idx === 0 ? "rgba(129,182,76,0.13)" : "rgba(255,255,255,0.04)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = idx === 0 ? "rgba(129,182,76,0.07)" : "transparent"; }}
                  >
                    {/* Score badge — Centichess style */}
                    <div style={{
                      background: line.score >= 0 ? "#ececea" : "#1a1917",
                      color: line.score >= 0 ? "#111" : "#ccc",
                      padding: "2px 6px", borderRadius: "4px",
                      fontSize: "11px", fontWeight: 800,
                      minWidth: "44px", textAlign: "center", flexShrink: 0,
                      border: "1px solid rgba(255,255,255,0.07)",
                    }}>
                      {formatEval(line.score)}
                    </div>
                    <div style={{ overflow: "hidden", flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: "5px" }}>
                      <span style={{ fontWeight: 800, fontSize: "13px", color: idx === 0 ? "#fff" : "#ccc", flexShrink: 0 }}>
                        {line.san}
                      </span>
                      <span style={{ fontSize: "11px", color: "#555", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {line.pv.split(" ").slice(1).join(" ")}
                      </span>
                    </div>
                  </div>
                ) : (
                  /* Skeleton shimmer line (Chesskit style) */
                  <div key={idx} style={{
                    display: "flex", alignItems: "center", gap: "8px", padding: "7px 10px",
                    borderBottom: idx < 2 ? "1px solid rgba(255,255,255,0.04)" : "none",
                  }}>
                    <div style={{
                      width: "44px", height: "22px", borderRadius: "4px", flexShrink: 0,
                      background: "linear-gradient(90deg, #2c2b29 25%, #3d3b38 50%, #2c2b29 75%)",
                      backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite",
                    }} />
                    <div style={{
                      flex: 1, height: "14px", borderRadius: "4px",
                      background: "linear-gradient(90deg, #2c2b29 25%, #3d3b38 50%, #2c2b29 75%)",
                      backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite 0.2s",
                    }} />
                  </div>
                )
              )
            )}
          </div>}

          {/* Report tab — accuracy + move breakdown */}
          {sidebarTab === "report" && (
            <div
              style={{
                flexShrink: 0,
                borderBottom: "1px solid #3c3a38",
                overflowY: "auto",
                maxHeight: isCompact ? "none" : "320px",
              }}
            >
              {gameAnalysis.isAnalyzing ? (
                <div style={{ padding: "14px 12px" }}>
                  {/* Live-building eval graph during analysis */}
                  {gameAnalysis.positionEvals.length > 1 && (
                    <div style={{ marginBottom: "10px", borderRadius: "6px", overflow: "hidden", border: "1px solid #333" }}>
                      <EvalGraph
                        positionEvals={gameAnalysis.positionEvals}
                        moves={gameAnalysis.moves}
                        currentIndex={reviewIndex}
                        onSeek={seekToPosition}
                      />
                    </div>
                  )}
                  <div style={{ fontSize: "11px", color: "#888", marginBottom: "8px", display: "flex", justifyContent: "space-between" }}>
                    <span>Analysing game…</span>
                    <span style={{ color: "#5ca0d3", fontVariantNumeric: "tabular-nums" }}>{gameAnalysis.progress}%</span>
                  </div>
                  <div style={{ height: "6px", borderRadius: "3px", background: "#333", overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${gameAnalysis.progress}%`,
                      background: "linear-gradient(90deg, #5ca0d3, #81b64c)",
                      borderRadius: "3px", transition: "width 300ms ease",
                    }} />
                  </div>
                  <div style={{ fontSize: "10px", color: "#555", marginTop: "8px" }}>
                    Evaluating {gameAnalysis.progress < 100 ? "positions" : "done"} — {review.positions.length} total
                  </div>
                </div>
              ) : gameAnalysis.stats ? (
                <div style={{ padding: "10px 12px" }}>
                  {/* Eval graph */}
                  <div style={{ marginBottom: "10px", borderRadius: "6px", overflow: "hidden", border: "1px solid #333" }}>
                    <EvalGraph
                      positionEvals={gameAnalysis.positionEvals}
                      moves={gameAnalysis.moves}
                      currentIndex={reviewIndex}
                      onSeek={seekToPosition}
                    />
                  </div>
                  {/* Accuracy cards */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "12px" }}>
                    {([
                      { color: "white", name: review.game.white, acc: gameAnalysis.stats.whiteAccuracy },
                      { color: "black", name: review.game.black, acc: gameAnalysis.stats.blackAccuracy },
                    ] as const).map(({ color, name, acc }) => (
                      <div key={color} style={{
                        padding: "10px 8px", background: "#2a2826",
                        borderRadius: "6px", border: "1px solid #3c3a38", textAlign: "center",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", marginBottom: "6px" }}>
                          <PlayerAvatar name={name} size={24} platform={inferPlatformFromGameId(review.game.lichessGameId ?? review.game.id)} />
                          <span style={{ fontSize: "11px", color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                            {name}
                          </span>
                        </div>
                        <div style={{ fontSize: "21px", fontWeight: 900, color: "#fff", fontVariantNumeric: "tabular-nums" }}>
                          {acc.toFixed(1)}%
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Breakdown table */}
                  <div style={{ fontSize: "10px", color: "#555", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Move Breakdown
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "0 10px", alignItems: "center" }}>
                    <div style={{ fontSize: "10px", color: "#444", paddingBottom: "3px" }} />
                    <div style={{ fontSize: "10px", color: "#555", textAlign: "center", paddingBottom: "3px" }}>⬜</div>
                    <div style={{ fontSize: "10px", color: "#555", textAlign: "center", paddingBottom: "3px" }}>⬛</div>
                    {gameAnalysis.stats.breakdown.map(({ classification, white, black }) => {
                      const clsColor = CLASSIFICATION_COLOR[classification] ?? "#999";
                      const clsLabel = CLASSIFICATION_LABEL[classification] ?? classification;
                      return (
                        <Fragment key={classification}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "3px 0" }}>
                            <ClassificationIcon cls={classification} size={16} />
                            <span style={{ fontSize: "11px", color: "#aaa" }}>{clsLabel}</span>
                          </div>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: white > 0 ? clsColor : "#333", textAlign: "center" }}>{white}</div>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: black > 0 ? clsColor : "#333", textAlign: "center" }}>{black}</div>
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div style={{ padding: "16px 12px", fontSize: "12px", color: "#555", textAlign: "center" }}>
                  Analysis unavailable.
                </div>
              )}
            </div>
          )}

          {/* Move tree */}
          <div
            style={{
              flex: isCompact ? "0 0 auto" : 1,
              minHeight: 0,
              maxHeight: isCompact ? "260px" : "none",
              overflowY: "auto",
              padding: "10px 0",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: "10px", marginBottom: "4px", color: "#444", paddingLeft: "12px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Moves
            </div>
            <MoveTree rootNode={rootNode} activePath={activePath} onSelectPath={handleSelectPath} />
          </div>

          {/* Nav buttons */}
          <div style={{ padding: "10px 12px", background: "#211f1c", display: "flex", justifyContent: "center", gap: "4px", flexShrink: 0, borderTop: "1px solid #3c3a38" }}>
            {[
              { icon: <NavFirst />, action: () => setActivePath([]),  disabled: reviewIndex === 0 },
              { icon: <NavPrev />,  action: goLeft,                    disabled: reviewIndex === 0 },
              { icon: <NavNext />,  action: goRight,                   disabled: activeNode.children.length === 0 },
              { icon: <NavLast />,  action: () => {
                setActivePath(prev => {
                  const np = [...prev];
                  let curr = rootNode;
                  for (const uci of np) { const next = curr.children.find(c => c.uci === uci); if (!next) return prev; curr = next; }
                  while (curr.children.length > 0) {
                    const prefStr = np.join(",");
                    let nextUci = curr.children[0].uci;
                    const pref = preferredChildren[prefStr];
                    if (pref && curr.children.some(c => c.uci === pref)) nextUci = pref;
                    np.push(nextUci); const next = curr.children.find(c => c.uci === nextUci); if (!next) break; curr = next;
                  }
                  return np;
                });
              }, disabled: activeNode.children.length === 0 },
            ].map((btn, i) => (
              <button key={i} onClick={btn.action} disabled={btn.disabled} style={{
                background: "#3c3a38", color: "#fff", border: "none", padding: "8px 16px", borderRadius: "4px",
                opacity: btn.disabled ? 0.35 : 1, cursor: btn.disabled ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", transition: "opacity 150ms ease",
              }}>
                {btn.icon}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}



// ── Main component ─────────────────────────────────────────────────
export default function GamesPanel({
  requestedReviewTarget = null,
  onRequestedReviewHandled,
}: GamesPanelProps) {
  const [platform, setPlatform] = useState<Platform>("all");
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccounts>({
    lichess: "",
    chessCom: "",
  });
  // Account linking UI state
  const [linkInputs, setLinkInputs] = useState({ lichess: "", chessCom: "" });
  // Auto-sync status
  const [syncingPlatforms, setSyncingPlatforms] = useState<Set<string>>(new Set());
  const [lastSynced, setLastSynced] = useState<Record<string, number>>({});

  const [games, setGames] = useState<GameRow[]>([]);
  const [stats, setStats] = useState<GamesResponse["stats"]>({
    total: 0, pending: 0, processing: 0, analyzed: 0, failed: 0,
  });
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [review, setReview] = useState<LiveReviewResponse | null>(null);  // board review
  const [reviewIndex, setReviewIndex] = useState(0);
  const [gameSearchInput, setGameSearchInput] = useState("");
  const [gameSearch, setGameSearch] = useState("");
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const lastRequestedReviewIdRef = useRef<string | null>(null);
  const [reviewStartTab, setReviewStartTab] = useState<"engine" | "report">("engine");
  const [reviewPreferredViewerColor, setReviewPreferredViewerColor] = useState<"white" | "black" | null>(null);
  const [reviewSessionKey, setReviewSessionKey] = useState(0);

  useEffect(() => {
    const refreshLinkedAccounts = () => {
      const accounts = readLinkedAccounts();
      setLinkedAccounts(accounts);
      setLinkInputs({ lichess: accounts.lichess, chessCom: accounts.chessCom });
    };
    refreshLinkedAccounts();
    window.addEventListener("focus", refreshLinkedAccounts);
    window.addEventListener("storage", refreshLinkedAccounts);
    return () => {
      window.removeEventListener("focus", refreshLinkedAccounts);
      window.removeEventListener("storage", refreshLinkedAccounts);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncLayout = () => setIsCompactLayout(window.innerWidth < 900);
    syncLayout();
    window.addEventListener("resize", syncLayout);
    return () => window.removeEventListener("resize", syncLayout);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setGameSearch(gameSearchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [gameSearchInput]);

  function linkAccount(p: "lichess" | "chess.com") {
    const val = (p === "lichess" ? linkInputs.lichess : linkInputs.chessCom).trim().toLowerCase();
    if (!val) return;
    const next: LinkedAccounts = p === "chess.com"
      ? { ...linkedAccounts, chessCom: val }
      : { ...linkedAccounts, lichess: val };
    setLinkedAccounts(next);
    saveLinkedAccounts(next);
    void syncLinkedAccountsToSupabase(next);
  }

  const loadGames = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setLoading(true);
      setMessage("");
    }

    try {
      const params = new URLSearchParams({ platform });
      if (gameSearch) params.set("q", gameSearch);
      const res = await fetch(`/api/games?${params.toString()}`, { headers: await getClientAuthHeaders() });
      const json = (await res.json()) as GamesResponse & { error?: string };

      if (!res.ok) {
        if (!silent) setMessage(json.error ?? "Failed to load games.");
        return;
      }

      setGames(json.games ?? []);
      setNextCursor(json.nextCursor ?? null);
      setStats((prev) => json.stats ?? prev);
      const ids = new Set((json.games ?? []).map((g) => g.id));
      setSelectedGameId((prev) => (prev && ids.has(prev) ? prev : (json.games?.[0]?.id ?? null)));
    } catch {
      if (!silent) setMessage("Network error while loading games.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [platform, gameSearch]);

  const loadMoreGames = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ platform, cursor: nextCursor });
      if (gameSearch) params.set("q", gameSearch);
      const res = await fetch(`/api/games?${params.toString()}`, { headers: await getClientAuthHeaders() });
      const json = (await res.json()) as GamesResponse & { error?: string };
      if (!res.ok) return;
      setGames(prev => {
        const existingIds = new Set(prev.map(g => g.id));
        const newGames = (json.games ?? []).filter(g => !existingIds.has(g.id));
        return [...prev, ...newGames];
      });
      setNextCursor(json.nextCursor ?? null);
    } catch { /**/ } finally {
      setLoadingMore(false);
    }
  }, [platform, nextCursor, loadingMore, gameSearch]);

  useEffect(() => {
    void loadGames();
  }, [loadGames]);

  // ── Auto-sync: silently fetch new games when account is linked ──────────────
  const autoSync = useCallback(async (accounts: LinkedAccounts) => {
    const platforms: Array<"lichess" | "chess.com"> = ["lichess", "chess.com"];
    for (const p of platforms) {
      const username = getLinkedUsername(accounts, p);
      if (!username) continue;
      const elapsed = Date.now() - getLastSyncMs(p, username);
      if (elapsed < AUTO_SYNC_INTERVAL_MS) continue;

      setSyncingPlatforms(prev => new Set(prev).add(p));
      try {
        const res = await fetch("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await getClientAuthHeaders()) },
          body: JSON.stringify({ username, platform: p }),
        });
        if (res.ok) {
          setLastSyncMs(p, username);
          setLastSynced(prev => ({ ...prev, [`${p}_${username}`]: Date.now() }));
          void loadGames({ silent: true });
        } else if (res.status === 429) {
          const payload = (await res.json().catch(() => ({}))) as ImportResponse;
          const remainingMs = payload.cooldownRemainingMs ?? AUTO_SYNC_INTERVAL_MS;
          const assumedLast = Date.now() - (AUTO_SYNC_INTERVAL_MS - remainingMs);
          setLastSynced(prev => ({ ...prev, [`${p}_${username}`]: assumedLast }));
        }
      } catch { /**/ } finally {
        setSyncingPlatforms(prev => { const s = new Set(prev); s.delete(p); return s; });
      }
    }
  }, [loadGames]);

  const manualSync = useCallback(async (p: "lichess" | "chess.com") => {
    const username = getLinkedUsername(linkedAccounts, p);
    if (!username) {
      setMessage(`Link your ${p === "lichess" ? "Lichess" : "Chess.com"} account first.`);
      return;
    }

    const elapsed = Date.now() - getLastSyncMs(p, username);
    if (elapsed < MANUAL_SYNC_COOLDOWN_MS) {
      const waitSec = Math.ceil((MANUAL_SYNC_COOLDOWN_MS - elapsed) / 1000);
      setMessage(`Please wait ${waitSec}s before syncing ${p} again.`);
      return;
    }

    setSyncingPlatforms(prev => new Set(prev).add(p));
    setMessage("");
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await getClientAuthHeaders()) },
        body: JSON.stringify({
          username,
          platform: p,
          fullSync: true,
          analyzeLimit: 1000,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as ImportResponse;

      if (res.ok) {
        setLastSyncMs(p, username);
        setLastSynced(prev => ({ ...prev, [`${p}_${username}`]: Date.now() }));
        const skipped = payload.skippedQueue ?? 0;
        if (skipped > 0) {
          setMessage(
            `Synced ${p}: imported ${payload.imported ?? 0}, queued ${payload.queued ?? 0}, skipped ${skipped} (queue limit ${payload.analyzeLimit ?? "n/a"}).`
          );
        } else {
          setMessage(`Synced ${p}: imported ${payload.imported ?? 0}, queued ${payload.queued ?? 0}.`);
        }
        void loadGames({ silent: true });
      } else if (res.status === 429) {
        const remainingSec = Math.ceil((payload.cooldownRemainingMs ?? MANUAL_SYNC_COOLDOWN_MS) / 1000);
        setMessage(`Sync cooldown active for ${p}. Try again in ${remainingSec}s.`);
      } else {
        setMessage(payload.error ?? `Failed to sync ${p}.`);
      }
    } catch {
      setMessage(`Network error while syncing ${p}.`);
    } finally {
      setSyncingPlatforms(prev => { const s = new Set(prev); s.delete(p); return s; });
    }
  }, [linkedAccounts, loadGames]);

  // Trigger auto-sync on mount and whenever linked accounts change
  useEffect(() => {
    void autoSync(linkedAccounts);
    const timer = setInterval(() => void autoSync(linkedAccounts), AUTO_SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [linkedAccounts, autoSync]);

  const selectedGame = useMemo(
    () => games.find((g) => g.id === selectedGameId) ?? null,
    [games, selectedGameId]
  );
  // hasRunningAnalysis uses global DB stats (not just the loaded page).
  const hasRunningAnalysis = stats.pending > 0 || stats.processing > 0;
  const viewerUsernames = useMemo(
    () => getAllViewerUsernames(linkedAccounts),
    [linkedAccounts]
  );

  // Poll stats while jobs are running — never touches the games list or scroll position.
  useEffect(() => {
    if (!hasRunningAnalysis || review) return;
    const timer = setInterval(async () => {
      try {
        const params = new URLSearchParams({ platform });
        if (gameSearch) params.set("q", gameSearch);
        const res = await fetch(`/api/games/stats?${params.toString()}`, {
          headers: await getClientAuthHeaders(),
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          total: number; pending: number; processing: number; analyzed: number; failed: number;
        };
        setStats(json);
      } catch { /* silent */ }
    }, 8000);
    return () => clearInterval(timer);
  }, [hasRunningAnalysis, review, platform, gameSearch]);

  async function queueSelectedGame(targetGameId = selectedGameId, targetGame = selectedGame) {
    if (!targetGameId || !targetGame) { setMessage("Select a game first."); return; }
    if (targetGame.status === "analyzed") {
      setMessage("This game is already analyzed.");
      return;
    }
    const selectedPlatform = inferPlatformFromGameId(targetGame.lichess_game_id);
    const selectedUsername = getLinkedUsername(linkedAccounts, selectedPlatform);

    setActionLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await getClientAuthHeaders()) },
        body: JSON.stringify({
          gameIds: [targetGameId],
          platform: selectedPlatform,
          username: selectedUsername,
          viewerUsernames,
          forceRequeue: targetGame.status === "processing" || targetGame.status === "failed",
        }),
      });
      const json = (await res.json()) as { selected?: number; queued?: number; skipped?: number; queueUnavailable?: boolean; error?: string };
      if (!res.ok) {
        setMessage(json.error ?? "Failed to queue selected games.");
      } else if (json.queueUnavailable) {
        setMessage("Redis queue offline. Start Redis + worker and try again.");
      } else {
        const skipped = json.skipped ?? 0;
        setMessage(
          skipped > 0
            ? `Queued (${json.queued ?? 0}/${json.selected ?? 0}) — ${skipped} already recently re-queued.`
            : `Queued (${json.queued ?? 0}/${json.selected ?? 0}).`
        );
      }
      await loadGames();
    } catch {
      setMessage("Network error while queueing.");
    } finally {
      setActionLoading(false);
    }
  }

  async function queueBacklogAll() {
    setActionLoading(true);
    setMessage("");
    try {
      let totalSelected = 0;
      let totalQueued = 0;
      let rounds = 0;

      while (rounds < 20) {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await getClientAuthHeaders()) },
          body: JSON.stringify({
            platform,
            order: "oldest",
            limit: 1000,
            viewerUsernames,
          }),
        });
        const json = (await res.json()) as { selected?: number; queued?: number; queueUnavailable?: boolean; error?: string };

        if (!res.ok) {
          setMessage(json.error ?? "Failed to queue backlog games.");
          await loadGames();
          return;
        }
        if (json.queueUnavailable) {
          setMessage("Redis queue offline. Start Redis + worker and try again.");
          await loadGames();
          return;
        }

        const selected = json.selected ?? 0;
        const queued = json.queued ?? 0;
        totalSelected += selected;
        totalQueued += queued;
        rounds += 1;

        // Nothing else picked for queue in this pass -> backlog drained for current filter.
        if (selected === 0 || queued === 0) break;
      }

      setMessage(`Queued backlog (${totalQueued}/${totalSelected}) in ${rounds} batch(es).`);
      await loadGames();
    } catch {
      setMessage("Network error while queueing backlog.");
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
        headers: { "Content-Type": "application/json", ...(await getClientAuthHeaders()) },
        body: JSON.stringify({
          gameIds: stuckIds,
          viewerUsernames,
          forceRequeue: true,
        }),
      });
      const json = (await res.json()) as { selected?: number; queued?: number; skipped?: number; error?: string; queueUnavailable?: boolean };

      if (!res.ok) {
        setMessage(json.error ?? "Failed to recover stuck games.");
      } else if (json.queueUnavailable) {
        setMessage("Redis queue offline. Start Redis + worker and retry recovery.");
      } else {
        const skipped = json.skipped ?? 0;
        setMessage(
          skipped > 0
            ? `Recovery queued (${json.queued ?? 0}/${json.selected ?? stuckIds.length}) — ${skipped} already recently re-queued.`
            : `Recovery queued (${json.queued ?? 0}/${json.selected ?? stuckIds.length}).`
        );
      }

      await loadGames();
    } catch {
      setMessage("Network error while recovering stuck games.");
    } finally {
      setActionLoading(false);
    }
  }

  const openLiveReview = useCallback(async (
    gameId = selectedGameId,
    options?: {
      reviewIndex?: number;
      sidebarTab?: "engine" | "report";
      viewerColor?: "white" | "black";
    }
  ) => {
    if (!gameId) { setMessage("Select a game first."); return; }
    setReviewLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/live-review", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await getClientAuthHeaders()) },
        body: JSON.stringify({ gameId, viewerUsernames }),
      });
      const json = (await res.json()) as LiveReviewResponse;
      if (!res.ok) {
        setMessage(json.error ?? "Could not open live review for this game.");
      } else {
        setReview(json);
        setReviewIndex(options?.reviewIndex ?? 0);
        setReviewStartTab(options?.sidebarTab ?? "engine");
        setReviewPreferredViewerColor(options?.viewerColor ?? null);
        setReviewSessionKey((prev) => prev + 1);
      }
    } catch {
      setMessage("Network error while opening live review.");
    } finally {
      setReviewLoading(false);
    }
  }, [selectedGameId, viewerUsernames]);

  useEffect(() => {
    if (!requestedReviewTarget) {
      lastRequestedReviewIdRef.current = null;
      return;
    }
    const targetSignature = `${requestedReviewTarget.gameId}:${requestedReviewTarget.reviewIndex ?? 0}:${requestedReviewTarget.sidebarTab ?? "engine"}:${requestedReviewTarget.viewerColor ?? "auto"}`;
    if (lastRequestedReviewIdRef.current === targetSignature) return;
    lastRequestedReviewIdRef.current = targetSignature;
    setSelectedGameId(requestedReviewTarget.gameId);
    void openLiveReview(requestedReviewTarget.gameId, {
      reviewIndex: requestedReviewTarget.reviewIndex,
      sidebarTab: requestedReviewTarget.sidebarTab,
      viewerColor: requestedReviewTarget.viewerColor,
    }).finally(() => {
      onRequestedReviewHandled?.();
    });
  }, [requestedReviewTarget, onRequestedReviewHandled, openLiveReview]);

  // ── Review mode: full chess.com-style layout ───────────────────
  if (review) {
    return (
      <ReviewView
        key={`${review.game.id}:${reviewSessionKey}`}
        review={review}
        reviewIndex={reviewIndex}
        setReviewIndex={setReviewIndex}
        initialSidebarTab={reviewStartTab}
        preferredViewerColor={reviewPreferredViewerColor}
        onClose={() => {
          setReview(null);
          setReviewIndex(0);
          setReviewPreferredViewerColor(null);
        }}
      />
    );
  }

  // ── Games list ─────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: "16px 20px", gap: "10px" }}>

      {/* ── Accounts section ── */}
      <div style={{
        display: "flex", gap: "10px", flexWrap: "wrap", flexShrink: 0,
        padding: "10px 14px", borderRadius: "8px",
        background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
        alignItems: "center",
      }}>
        {(["lichess", "chess.com"] as const).map((p) => {
          const linked = getLinkedUsername(linkedAccounts, p);
          const isSyncing = syncingPlatforms.has(p);
          const lastSync = linked ? lastSynced[`${p}_${linked}`] ?? getLastSyncMs(p, linked) : 0;
          const minAgo = lastSync ? Math.floor((Date.now() - lastSync) / 60000) : null;
          return (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: "8px", flex: "1 1 200px" }}>
              <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0, width: "62px" }}>
                {p === "lichess" ? "Lichess" : "Chess.com"}
              </span>
              {linked ? (
                <>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {linked}
                  </span>
                  {isSyncing ? (
                    <span style={{ fontSize: "10px", color: "var(--accent)", flexShrink: 0 }}>syncing…</span>
                  ) : minAgo !== null ? (
                    <span style={{ fontSize: "10px", color: "var(--text-muted)", flexShrink: 0 }}>
                      {minAgo < 1 ? "just now" : minAgo < 60 ? `${minAgo}m ago` : `${Math.floor(minAgo / 60)}h ago`}
                    </span>
                  ) : null}
                  <button
                    onClick={() => void manualSync(p)}
                    disabled={isSyncing}
                    style={{ fontSize: "11px", color: "var(--accent)", background: "var(--accent-dim)", border: "1px solid rgba(129,182,76,0.4)", borderRadius: "4px", padding: "2px 8px", cursor: isSyncing ? "default" : "pointer", fontFamily: "inherit", flexShrink: 0, opacity: isSyncing ? 0.5 : 1 }}
                  >
                    Sync now
                  </button>
                  <span
                    style={{ fontSize: "10px", color: "var(--text-muted)", flexShrink: 0 }}
                    title="Linked accounts stay locked while sync and analysis jobs may still depend on them."
                  >
                    locked
                  </span>
                </>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder={`${p === "lichess" ? "Lichess" : "Chess.com"} username`}
                    value={p === "lichess" ? linkInputs.lichess : linkInputs.chessCom}
                    onChange={(e) => setLinkInputs(prev => p === "lichess" ? { ...prev, lichess: e.target.value } : { ...prev, chessCom: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && linkAccount(p)}
                    style={{ flex: 1, minWidth: 0, background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: "5px", padding: "5px 9px", fontSize: "12px", color: "var(--text-primary)", outline: "none", fontFamily: "inherit" }}
                  />
                  <button
                    onClick={() => linkAccount(p)}
                    disabled={!(p === "lichess" ? linkInputs.lichess : linkInputs.chessCom).trim()}
                    style={{ fontSize: "11px", fontWeight: 600, color: "var(--accent)", background: "var(--accent-dim)", border: "1px solid rgba(129,182,76,0.4)", borderRadius: "5px", padding: "5px 10px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0, opacity: !(p === "lichess" ? linkInputs.lichess : linkInputs.chessCom).trim() ? 0.4 : 1 }}
                  >
                    Link
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Filters + actions */}
      <div style={{ display: "flex", flexDirection: isCompactLayout ? "column" : "row", alignItems: isCompactLayout ? "stretch" : "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", flexShrink: 0 }}>
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

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", width: isCompactLayout ? "100%" : undefined }}>
          <Button variant="secondary" size="sm" onClick={() => void queueSelectedGame()} disabled={actionLoading || !selectedGameId || selectedGame?.status === "analyzed"}>
            {actionLoading ? "…" : selectedGame?.status === "processing" ? "Re-queue (stuck)" : "Queue Analysis"}
          </Button>
          {stats.processing > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void recoverStuckGames()}
              disabled={actionLoading}
            >
              Recover All Stuck
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void queueBacklogAll()}
            disabled={actionLoading || stats.pending === 0}
          >
            Queue Backlog
          </Button>
          <Button variant="primary" size="sm" onClick={() => void openLiveReview()} disabled={reviewLoading || !selectedGameId}>
            {reviewLoading ? "…" : "Live Review"}
          </Button>
        </div>
      </div>

      {/* Stats + message */}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", fontSize: "11px", color: "var(--text-muted)", flexShrink: 0 }}>
        <span>Total: <b style={{ color: "var(--text-secondary)" }}>{stats.total}</b></span>
        {stats.pending > 0 && <span>Pending: <b style={{ color: "var(--orange)" }}>{stats.pending}</b></span>}
        {stats.processing > 0 && <span>Processing: <b style={{ color: "var(--blue)" }}>{stats.processing}</b></span>}
        <span>Analyzed: <b style={{ color: "var(--green)" }}>{stats.analyzed}</b></span>
        {stats.failed > 0 && <span>Failed: <b style={{ color: "var(--red)" }}>{stats.failed}</b></span>}
        {hasRunningAnalysis && <span style={{ color: "var(--accent)" }}>· auto-refreshing</span>}
      </div>
      {message && <div style={{ fontSize: "12px", color: "var(--text-secondary)", flexShrink: 0 }}>{message}</div>}

      {/* Search */}
      <div style={{ flexShrink: 0, position: "relative" }}>
        <input
          type="text"
          placeholder="Search by player…"
          value={gameSearchInput}
          onChange={(e) => setGameSearchInput((e.target as HTMLInputElement).value)}
          style={{
            width: "100%",
            padding: "7px 10px 7px 30px",
            borderRadius: "7px",
            border: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            color: "var(--text-primary)",
            fontSize: "13px",
            fontFamily: "inherit",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
        >
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </div>

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
        {!isCompactLayout && (
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
        )}

        {/* Rows */}
        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "4px", padding: "6px 8px" }}>
          {games.map((g) => {
            const isSelected = g.id === selectedGameId;
            const gamePlatform = inferPlatformFromGameId(g.lichess_game_id);
            const linkedUsername = getLinkedUsername(linkedAccounts, gamePlatform);
            const youAreWhite = usernameMatchesPlayer(linkedUsername, g.white_username);
            const youAreBlack = usernameMatchesPlayer(linkedUsername, g.black_username);
            const canOpenReview = g.status === "analyzed";
            const primaryActionLabel = canOpenReview
              ? "Open review"
              : g.status === "processing"
                ? "Re-queue"
                : "Queue analysis";
            if (isCompactLayout) {
              return (
                <div
                  key={g.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    padding: "12px",
                    borderRadius: "10px",
                    border: isSelected ? "1px solid var(--accent)" : "1px solid var(--border-subtle)",
                    background: isSelected ? "var(--accent-dim)" : "var(--bg-elevated)",
                  }}
                >
                  <button
                    onClick={() => { setSelectedGameId(g.id); setMessage(""); }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                      alignItems: "stretch",
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      margin: 0,
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "inherit",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ color: "var(--text-primary)", fontWeight: 700, fontSize: "13px", lineHeight: 1.35 }}>
                          {g.white_username}{youAreWhite ? " (You)" : ""} vs {g.black_username}{youAreBlack ? " (You)" : ""}
                        </div>
                        <div style={{ color: "var(--text-muted)", fontSize: "11px", marginTop: "4px", lineHeight: 1.35 }}>
                          {g.white_rating ?? "?"} / {g.black_rating ?? "?"} · {g.time_control}
                        </div>
                      </div>
                      <div style={{ padding: "3px 8px", borderRadius: "999px", background: "rgba(255,255,255,0.05)", color: statusColor(g.status), fontSize: "10px", fontWeight: 700, textTransform: "capitalize", whiteSpace: "nowrap" }}>
                        {g.status}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      <span style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(255,255,255,0.04)", color: "var(--text-muted)", fontSize: "10px", fontWeight: 700 }}>
                        {gamePlatform === "chess.com" ? "Chess.com" : "Lichess"}
                      </span>
                      <span style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(255,255,255,0.04)", color: "var(--text-muted)", fontSize: "10px", fontWeight: 700, textTransform: "capitalize" }}>
                        {g.result}
                      </span>
                      <span style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(255,255,255,0.04)", color: "var(--text-muted)", fontSize: "10px", fontWeight: 700 }}>
                        {new Date(g.played_at).toLocaleDateString()}
                      </span>
                    </div>
                  </button>
                  <div style={{ display: "grid", gridTemplateColumns: canOpenReview ? "1fr auto" : "1fr", gap: "8px" }}>
                    <button
                      onClick={() => {
                        setSelectedGameId(g.id);
                        setMessage("");
                        if (canOpenReview) {
                          void openLiveReview(g.id);
                        } else {
                          void queueSelectedGame(g.id, g);
                        }
                      }}
                      disabled={actionLoading || reviewLoading}
                      style={{
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: "1px solid rgba(129,182,76,0.3)",
                        background: "rgba(129,182,76,0.12)",
                        color: "#81b64c",
                        fontSize: "12px",
                        fontWeight: 700,
                        cursor: actionLoading || reviewLoading ? "default" : "pointer",
                        fontFamily: "inherit",
                        opacity: actionLoading || reviewLoading ? 0.6 : 1,
                      }}
                    >
                      {primaryActionLabel}
                    </button>
                    {canOpenReview && (
                      <button
                        onClick={() => {
                          setSelectedGameId(g.id);
                          setMessage("");
                        }}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "8px",
                          border: "1px solid var(--border)",
                          background: "transparent",
                          color: "var(--text-muted)",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        Select
                      </button>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <button
                key={g.id}
                onClick={() => { setSelectedGameId(g.id); setMessage(""); }}
                onDoubleClick={() => { setSelectedGameId(g.id); void openLiveReview(g.id); }}
                style={{
                  display: "grid",
                  gridTemplateColumns: isCompactLayout ? "1fr auto" : "1fr 100px 80px 90px",
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
                  {isCompactLayout && (
                    <div style={{ color: "var(--text-muted)", fontSize: "11px" }}>
                      {new Date(g.played_at).toLocaleDateString()} · {g.result}
                    </div>
                  )}
                </div>
                {!isCompactLayout && (
                <div style={{ color: "var(--text-secondary)", fontSize: "11px" }}>
                  {new Date(g.played_at).toLocaleDateString()}
                </div>
                )}
                {!isCompactLayout && <div style={{ color: "var(--text-secondary)", textTransform: "capitalize" }}>{g.result}</div>}
                <div style={{ color: statusColor(g.status), fontWeight: 600, textTransform: "capitalize", fontSize: "11px" }}>
                  {g.status}
                </div>
              </button>
            );
          })}

          {games.length === 0 && !loading && (
            <div style={{ padding: "32px", color: "var(--text-muted)", textAlign: "center", fontSize: "13px" }}>
              {gameSearch ? `No games match "${gameSearch}".` : "No games found. Link your account above to get started."}
            </div>
          )}

          {/* Load more */}
          {nextCursor && (
            <div style={{ padding: "10px 14px", textAlign: "center" }}>
              <button
                onClick={() => void loadMoreGames()}
                disabled={loadingMore}
                style={{
                  padding: "6px 18px", borderRadius: "6px",
                  border: "1px solid var(--border)", background: "transparent",
                  color: "var(--text-muted)", fontSize: "12px", cursor: "pointer",
                  fontFamily: "inherit", opacity: loadingMore ? 0.5 : 1,
                }}
              >
                {loadingMore ? "Loading…" : `Load more (${Math.max(0, stats.total - games.length)} remaining)`}
              </button>
            </div>
          )}
        </div>
      </div>

      <div style={{ fontSize: "11px", color: "var(--text-muted)", flexShrink: 0 }}>
        {isCompactLayout
          ? "Tap a card to select it, then use Open review / Queue analysis on the card."
          : "Double-click a game to open Live Review · Select + Queue Analysis to analyse"}
      </div>
    </div>
  );
}
