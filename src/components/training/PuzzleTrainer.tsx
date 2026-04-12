"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import type { DrawShape } from "chessground/draw";
import ChessBoard from "@/components/board/ChessBoard";
import { getClientAuthHeaders } from "@/lib/supabase";
import type { Puzzle } from "@/types";
import type { MoveAnnotationOverlay } from "@/components/board/ChessBoard";
import { useLiveAnalysis } from "@/hooks/useLiveAnalysis";
import { classifyMove } from "@/lib/analysis";
import { useAuth } from "@/hooks/useAuth";

// Helper: format centipawns as +1.23 / -0.45 / M3
function formatEvalPt(score: number): string {
  if (Math.abs(score) >= 90_000) {
    const m = 100_000 - Math.abs(score);
    return `${score > 0 ? "+" : "-"}M${m}`;
  }
  const val = score / 100;
  return `${score > 0 ? "+" : ""}${val.toFixed(2)}`;
}

type SrsChoice = "hard" | "good" | "easy";
type PuzzleState = "solving" | "wrong" | "correct" | "rating";

// ── SRS button config ────────────────────────────────────────────────────────
const SRS_BUTTONS: Array<{
  key: SrsChoice;
  label: string;
  shortcut: string;
  bg: string;
  color: string;
  border: string;
  hoverBg: string;
  interval: string;
}> = [
  {
    key: "hard",
    label: "Hard",
    shortcut: "1",
    bg: "rgba(200,120,50,0.15)",
    color: "var(--orange)",
    border: "rgba(200,120,50,0.35)",
    hoverBg: "rgba(200,120,50,0.25)",
    interval: "< 1 day",
  },
  {
    key: "good",
    label: "Good",
    shortcut: "2",
    bg: "rgba(134,166,102,0.15)",
    color: "var(--green)",
    border: "rgba(134,166,102,0.35)",
    hoverBg: "rgba(134,166,102,0.25)",
    interval: "~1 day+",
  },
  {
    key: "easy",
    label: "Easy",
    shortcut: "3",
    bg: "rgba(74,158,142,0.15)",
    color: "var(--teal)",
    border: "rgba(74,158,142,0.35)",
    hoverBg: "rgba(74,158,142,0.25)",
    interval: "~4 days+",
  },
];

// ── Helper: UCI move → [orig, dest] tuple ─────────────────────────────────
function uciToSquares(uci: string): [Key, Key] {
  return [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key];
}

// ── Helper: apply UCI move to FEN, return new FEN ────────────────────────
function applyUciMove(fen: string, uci: string): string | null {
  try {
    const chess = new Chess(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length === 5 ? uci[4] : undefined;
    const result = chess.move({ from, to, promotion: promotion as "q" | "r" | "b" | "n" | undefined });
    if (!result) return null;
    return chess.fen();
  } catch {
    return null;
  }
}

// ── Phase display ────────────────────────────────────────────────────────────
function phaseLabel(phase: string): string {
  switch (phase) {
    case "opening": return "Opening";
    case "middlegame": return "Middlegame";
    case "endgame": return "Endgame";
    default: return phase;
  }
}

// ── Empty state ───────────────────────────────────────────────────────────────
function NoPuzzlesState() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        flex: 1,
        gap: "16px",
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: "64px",
          height: "64px",
          borderRadius: "50%",
          background: "var(--accent-dim)",
          border: "1px solid rgba(192,160,96,0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"/>
          <path d="M12 6v6l4 2"/>
        </svg>
      </div>
      <div>
        <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)", marginBottom: "6px" }}>
          No puzzles due!
        </div>
        <div style={{ fontSize: "13px", color: "var(--text-muted)", maxWidth: "280px" }}>
          Check back later — your next review will be scheduled based on how well you know each position.
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function PuzzleTrainer() {
  const { userId } = useAuth();
  const [puzzles, setPuzzles] = useState<Puzzle[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [state, setState] = useState<PuzzleState>("solving");
  
  // Interactive puzzle state
  const [playedMoves, setPlayedMoves] = useState<string[]>([]);
  const [viewPly, setViewPly] = useState<number>(0);
  const [debugLastEval, setDebugLastEval] = useState<string>("Ninghuem jogou nada ainda");

  // Wrong move visual feedback
  const [wrongFen, setWrongFen] = useState<string | undefined>();
  const [wrongLastMove, setWrongLastMove] = useState<[Key, Key] | undefined>();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredSrs, setHoveredSrs] = useState<number | null>(null);
  // Track which puzzle IDs have been rated this session (for sidebar "done" indicator).
  const [ratedIds, setRatedIds] = useState<Set<string>>(new Set());
  // Experimental reset state
  const [resetting, setResetting] = useState(false);

  const wrongResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch due puzzles ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) {
      setError("Sign in to load puzzles.");
      setLoading(false);
      return;
    }
    async function fetchPuzzles() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/puzzles?limit=20", {
          headers: {
            ...(await getClientAuthHeaders()),
          },
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          if (res.status === 401) {
            throw new Error("Sign in to load puzzles.");
          }
          throw new Error(payload.error ?? "Failed to load puzzles");
        }
        const payload = (await res.json()) as { puzzles?: Puzzle[] };
        setPuzzles(payload.puzzles ?? []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setLoading(false);
      }
    }

    void fetchPuzzles();
  }, [userId]);

  // ── Reset board when puzzle changes ──────────────────────────────────────
  const currentPuzzle = puzzles[currentIndex] ?? null;

  useEffect(() => {
    if (!currentPuzzle) return;
    setPlayedMoves([]);
    setViewPly(0);
    setState("solving");
    setWrongFen(undefined);
    setWrongLastMove(undefined);
  }, [currentPuzzle]);

  // Compute Fen and LastMove based on viewPly
  const baseFen = currentPuzzle?.fen ?? "start";
  const { displayFen, displayLastMove } = useMemo(() => {
    let f = baseFen;
    let lm: [Key, Key] | undefined;
    
    if (wrongFen) {
      return { displayFen: wrongFen, displayLastMove: wrongLastMove };
    }

    if (currentPuzzle) {
      for (let i = 0; i < viewPly; i++) {
        const uci = playedMoves[i];
        if (!uci) break;
        const newF = applyUciMove(f, uci);
        if (newF) f = newF;
        lm = uciToSquares(uci);
      }
    }
    return { displayFen: f, displayLastMove: lm };
  }, [baseFen, currentPuzzle, viewPly, playedMoves, wrongFen, wrongLastMove]);


  const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Retry current puzzle (reset to initial position) ─────────────────────
  const retryPuzzle = useCallback(() => {
    if (wrongResetTimerRef.current) clearTimeout(wrongResetTimerRef.current);
    if (revealTimerRef.current) clearInterval(revealTimerRef.current);
    setPlayedMoves([]);
    setViewPly(0);
    setState("solving");
    setWrongFen(undefined);
    setWrongLastMove(undefined);
  }, []);

  // ── SRS rating update ─────────────────────────────────────────────────────
  const handleSrsRating = useCallback(async (choice: SrsChoice) => {
    if (!currentPuzzle) return;

    try {
      await fetch("/api/puzzles", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(await getClientAuthHeaders()),
        },
        body: JSON.stringify({ puzzleId: currentPuzzle.id, choice }),
      });
    } catch {
      // Silently fail — puzzle still advances
    }

    // Mark as rated and move to next puzzle
    if (currentPuzzle) {
      setRatedIds((prev) => new Set(prev).add(currentPuzzle.id));
    }
    setCurrentIndex((prev) => prev + 1);
  }, [currentPuzzle]);

  // ── Keyboard shortcuts for SRS rating & history review ─────────────────────
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (state === "rating" || state === "correct") {
        if (e.key === "ArrowLeft") setViewPly((p) => Math.max(0, p - 1));
        if (e.key === "ArrowRight") setViewPly((p) => Math.min(playedMoves.length, p + 1));
      }
      
      if (state !== "rating") return;
      if (e.key === "1") handleSrsRating("hard");
      else if (e.key === "2") handleSrsRating("good");
      else if (e.key === "3") handleSrsRating("easy");
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [state, playedMoves.length, handleSrsRating]);

  // ── Cleanup timers on unmount ─────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (wrongResetTimerRef.current) clearTimeout(wrongResetTimerRef.current);
      if (revealTimerRef.current) clearInterval(revealTimerRef.current);
    };
  }, []);

  // ── Handle user move ──────────────────────────────────────────────────────
  const handleMove = useCallback((orig: Key, dest: Key) => {
    if (!currentPuzzle) return;

    // Must be at the latest ply to play
    if (viewPly !== playedMoves.length) {
      setViewPly(playedMoves.length);
      return;
    }

    const moveUci = `${orig}${dest}`;
    
    // Support either the new solution_line_uci array, legacy solution_move, or Postgres stringified arrays
    let targetLine: string[] = [];
    if (Array.isArray(currentPuzzle.solution_line_uci) && currentPuzzle.solution_line_uci.length > 0) {
      targetLine = currentPuzzle.solution_line_uci;
    } else if (typeof currentPuzzle.solution_line_uci === 'string') {
      try {
        targetLine = JSON.parse(currentPuzzle.solution_line_uci);
      } catch {
        const s = (currentPuzzle.solution_line_uci as string).replace(/^{|}$/g, '');
        targetLine = s.split(',').map(x => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
      }
    }
    if (!targetLine || targetLine.length === 0) {
      targetLine = [currentPuzzle.solution_move];
    }

    // ── If we are already done solving, allow free play
    if (state !== "solving") {
      try {
        const chess = new Chess(displayFen);
        const m = chess.move({ from: orig, to: dest, promotion: "q" });
        if (m) {
          const actualUci = `${m.from}${m.to}${m.promotion ? m.promotion : ""}`;
          const newPlayed = [...playedMoves, actualUci];
          setPlayedMoves(newPlayed);
          setViewPly(newPlayed.length);
        }
      } catch { /* ignore illegal free moves */ }
      return;
    }

    // ── Solving logic
    const expectedMove = targetLine[playedMoves.length];
    
    // Use startsWith to elegantly handle cases where the puzzle expects a promotion (e.g. "e7e8q") 
    // but the UI dragging interaction only emitted "e7e8".
    const isCorrect = expectedMove && expectedMove.startsWith(moveUci);
    setDebugLastEval(`Eu arrastei ${moveUci}. O sistema queria ${expectedMove}. Deu isCorrect=${isCorrect}`);

    if (isCorrect) {
      const newPlayed = [...playedMoves, moveUci];
      setPlayedMoves(newPlayed);
      setViewPly(newPlayed.length);

      const isFinished = newPlayed.length >= targetLine.length;

      if (isFinished) {
        setState("correct");
        setTimeout(() => setState("rating"), 600);
      } else {
        // Opponent's turn
        const nextMoveUci = targetLine[newPlayed.length];
        
        setTimeout(() => {
            setPlayedMoves(prev => {
               const p2 = [...prev, nextMoveUci];
               setViewPly(p2.length);
               return p2;
            });
        }, 350);
      }
    } else {
      // Wrong move logic
      setState("wrong");
      const wFen = applyUciMove(displayFen, moveUci);
      if (wFen) {
         setWrongFen(wFen);
         setWrongLastMove([orig, dest]);
      }
      if (wrongResetTimerRef.current) clearTimeout(wrongResetTimerRef.current);
      wrongResetTimerRef.current = setTimeout(() => {
         setWrongFen(undefined);
         setWrongLastMove(undefined);
         setState("solving");
      }, 800);
    }
  }, [currentPuzzle, state, viewPly, playedMoves, displayFen]);

  // ── Reveal solution manually ──────────────────────────────────────────────
  const handleRevealSolution = useCallback(() => {
    if (!currentPuzzle) return;

    let targetLine: string[] = [];
    if (Array.isArray(currentPuzzle.solution_line_uci) && currentPuzzle.solution_line_uci.length > 0) {
      targetLine = currentPuzzle.solution_line_uci;
    } else if (typeof currentPuzzle.solution_line_uci === 'string') {
      try {
        targetLine = JSON.parse(currentPuzzle.solution_line_uci);
      } catch {
        const s = (currentPuzzle.solution_line_uci as string).replace(/^{|}$/g, '');
        targetLine = s.split(',').map(x => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
      }
    }
    if (!targetLine || targetLine.length === 0) {
      targetLine = [currentPuzzle.solution_move];
    }

    setPlayedMoves(targetLine);
    setViewPly(0);
    setState("correct");

    if (revealTimerRef.current) clearInterval(revealTimerRef.current);
    
    let current = 0;
    revealTimerRef.current = setInterval(() => {
      current++;
      if (current > targetLine.length) {
        if (revealTimerRef.current) clearInterval(revealTimerRef.current);
        setTimeout(() => setState("rating"), 500);
      } else {
        setViewPly(current);
      }
    }, 600);
  }, [currentPuzzle]);

  // ── Explore Engine Lines (Post-solution) ──────────────────────────────────
  const handleApplyEngineLine = useCallback((uciMoves: string[]) => {
    if (state !== "rating" && state !== "correct") return;
    setPlayedMoves(prev => {
      // Create new state that concatenates the engine moves.
      const np = [...prev, ...uciMoves];
      setViewPly(np.length);
      return np;
    });
  }, [state]);


  // ── Render ────────────────────────────────────────────────────────────────
  const isSolving = state === "solving";
  const isWrong = state === "wrong";
  const isCorrect = state === "correct" || state === "rating";
  const isRating = state === "rating";

  // Compute the FEN at the end of the played solution (for live analysis)
  const solutionFen = useMemo(() => {
    if (!currentPuzzle || playedMoves.length === 0) return currentPuzzle?.fen ?? "";
    let f = currentPuzzle.fen;
    for (const uci of playedMoves) {
      const nf = applyUciMove(f, uci);
      if (nf) f = nf;
    }
    return f;
  }, [currentPuzzle, playedMoves]);

  // Live analysis: only active after the puzzle is solved
  const { lines: engineLines, depth: engineDepth, isSearching: engineSearching } = useLiveAnalysis(
    displayFen,
    isRating || state === "correct" // Run engine as soon as solved to populate cache
  );

  // ── Eval cache: fen → score (white POV) ───────────────────────────────────
  const evalCacheRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (engineLines.length > 0 && engineDepth >= 8) {
      evalCacheRef.current.set(displayFen, engineLines[0].score);
    }
  }, [displayFen, engineLines, engineDepth]);

  // ── Board Annotation (WintrChess style !!, ?, etc.) ───────────────────────
  const boardAnnotation = useMemo((): MoveAnnotationOverlay | undefined => {
    if (viewPly === 0 || playedMoves.length === 0 || !playedMoves[viewPly - 1]) return undefined;
    const lastUci = playedMoves[viewPly - 1];

    let parentFen = baseFen;
    for (let i = 0; i < viewPly - 1; i++) {
        const u = playedMoves[i];
        if (!u) break;
        const next = applyUciMove(parentFen, u);
        if (next) parentFen = next;
    }

    const prevScore = evalCacheRef.current.get(parentFen);
    const currScore = engineLines.length > 0 ? engineLines[0].score : evalCacheRef.current.get(displayFen);
    
    if (prevScore === undefined || currScore === undefined) return undefined;

    let cls: import("@/lib/analysis").MoveClassification | null = null;
    try {
      const chess = new Chess(parentFen);
      const turnBefore = chess.turn();
      const isSacrifice = false; // Could implement sacrifice check here
      cls = classifyMove(prevScore, currScore, turnBefore, isSacrifice);
    } catch { return undefined; }

    if (!cls || cls === "book" || cls === "best" || cls === "good" || cls === "excellent") return undefined;

    const destSquare = lastUci.slice(2, 4) as Key;
    const SYMBOLS: Record<string, string> = { brilliant: "!!", great: "!", inaccuracy: "?!", mistake: "?", blunder: "??", miss: "?" };
    const symbol = SYMBOLS[cls];
    if (!symbol) return undefined;
    
    const CLASSIFICATION_COLOR: Record<string, string> = {
      brilliant: "#1baca6", great: "#5c8bb0", inaccuracy: "#f6b43d", mistake: "#ee6b23", blunder: "#fa412d", miss: "#ff7769",
    };

    return { square: destSquare, symbol, color: CLASSIFICATION_COLOR[cls] ?? "#999" };
  }, [displayFen, engineLines, viewPly, playedMoves, baseFen]);

  // Engine arrows on the board post-solution
  const engineShapes = useMemo((): DrawShape[] => {
    if (!isRating || engineLines.length === 0 || engineDepth < 4) return [];
    return engineLines.slice(0, 3).map((line, i) => ({
      orig: line.move.slice(0, 2) as Key,
      dest: line.move.slice(2, 4) as Key,
      brush: i === 0 ? "green" : i === 1 ? "paleBlue" : "paleGrey",
    }));
  }, [isRating, engineLines, engineDepth]);

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          color: "var(--text-muted)",
          fontSize: "13px",
          gap: "10px",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ animation: "spin 1s linear infinite" }}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        Loading puzzles...
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          gap: "12px",
          padding: "40px 24px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "13px", color: "var(--red)" }}>
          Failed to load puzzles: {error}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "7px 16px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            color: "var(--text-primary)",
            cursor: "pointer",
            fontSize: "13px",
            fontFamily: "inherit",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (puzzles.length === 0 || !currentPuzzle) {
    return <NoPuzzlesState />;
  }

  // All puzzles done
  if (currentIndex >= puzzles.length) {
    // Find the earliest next due time among the puzzles just reviewed.
    const nextDue = puzzles
      .map((p) => p.srs_due_at)
      .filter(Boolean)
      .sort()[0] ?? null;

    const nextDueLabel = (() => {
      if (!nextDue) return null;
      const diffMs = new Date(nextDue).getTime() - Date.now();
      if (diffMs <= 0) return "soon";
      const mins = Math.round(diffMs / 60_000);
      if (mins < 60) return `in ${mins} min`;
      const hrs = Math.round(diffMs / 3_600_000);
      if (hrs < 24) return `in ${hrs}h`;
      const days = Math.round(diffMs / 86_400_000);
      return `in ${days}d`;
    })();

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          gap: "16px",
          padding: "40px 24px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: "64px",
            height: "64px",
            borderRadius: "50%",
            background: "var(--green-dim)",
            border: "1px solid rgba(134,166,102,0.3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)", marginBottom: "6px" }}>
            Session complete!
          </div>
          <div style={{ fontSize: "13px", color: "var(--text-muted)", maxWidth: "280px" }}>
            You reviewed {puzzles.length} puzzle{puzzles.length === 1 ? "" : "s"}.
            {nextDueLabel && (
              <> Your next review is due <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{nextDueLabel}</span>.</>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Board is interactive while solving, or after puzzle is solved (for free play)
  const boardInteractive = state === "solving" || state === "rating";

  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        overflow: "hidden",
        minHeight: 0,
      }}
    >
      {/* ── Board section ── */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-start",
          flex: 1,
          padding: "20px 20px 16px",
          gap: "12px",
          minWidth: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {/* ── Top bar: puzzle count + status ── */}
        <div
          style={{
            width: "100%",
            maxWidth: "min(900px, calc(100vh - 220px))",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {/* Left: context info */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "13px",
              color: "var(--text-muted)",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Move {currentPuzzle.move_number}
            </span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: "9px",
                  height: "9px",
                  borderRadius: "50%",
                  background: currentPuzzle.player_color === "white" ? "#e8e6e2" : "#1a1a1a",
                  border: "1.5px solid var(--border)",
                  verticalAlign: "middle",
                  marginRight: "4px",
                }}
              />
              You played a blunder as {currentPuzzle.player_color}
            </span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span
              style={{
                padding: "1px 6px",
                borderRadius: "4px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--text-secondary)",
                textTransform: "capitalize",
              }}
            >
              {phaseLabel(currentPuzzle.phase)}
            </span>
            {currentPuzzle.is_brilliant && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "4px",
                  background: "rgba(192,160,96,0.12)",
                  border: "1px solid rgba(192,160,96,0.3)",
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "var(--accent)",
                }}
              >
                Brilliant move!
              </span>
            )}
          </div>

          {/* Right: puzzle count + status badge */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span
              style={{
                fontSize: "12px",
                color: "var(--text-muted)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              Puzzle {currentIndex + 1} of {puzzles.length}
            </span>
            {isSolving && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "4px 10px",
                  borderRadius: "6px",
                  background: "rgba(192,160,96,0.1)",
                  border: "1px solid rgba(192,160,96,0.25)",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "var(--accent)",
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {currentPuzzle.is_brilliant ? "Find the brilliant move!!" : "Your turn"}
              </div>
            )}
            {isWrong && (
              <div
                style={{
                  padding: "4px 10px",
                  borderRadius: "6px",
                  background: "var(--red-dim)",
                  border: "1px solid rgba(185,64,64,0.35)",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "var(--red)",
                }}
              >
                Incorrect — try again
              </div>
            )}
            {isCorrect && (
              <div
                style={{
                  padding: "4px 10px",
                  borderRadius: "6px",
                  background: "var(--green-dim)",
                  border: "1px solid rgba(134,166,102,0.35)",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "var(--green)",
                }}
              >
                Correct!
              </div>
            )}
          </div>
        </div>

        {/* ── Board ── */}
        <div
          style={{
            width: "100%",
            maxWidth: "min(900px, calc(100vh - 220px))",
            boxShadow: "var(--shadow-board)",
            borderRadius: "4px",
            overflow: "visible",
            position: "relative",
          }}
        >
          <ChessBoard
            fen={displayFen}
            orientation={currentPuzzle.player_color}
            interactive={boardInteractive}
            onMove={handleMove}
            lastMove={displayLastMove}
            showCoordinates
            shapes={isRating ? engineShapes : []}
            annotation={boardAnnotation}
          />
        </div>

        {/* ── Feedback + solution line banner ── */}
        {isCorrect && (
          <div
            style={{
              width: "100%",
              maxWidth: "min(900px, calc(100vh - 220px))",
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
              padding: "10px 14px",
              borderRadius: "7px",
              background: "rgba(134,166,102,0.08)",
              border: "1px solid rgba(134,166,102,0.25)",
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--green)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ flexShrink: 0, marginTop: "1px" }}
            >
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  color: "var(--green)",
                  marginBottom: "4px",
                }}
              >
                Best move: {currentPuzzle.solution_san}
              </div>
              {currentPuzzle.solution_line_san.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "4px",
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: "11px", color: "var(--text-muted)", marginRight: "2px" }}>
                    Line:
                  </span>
                  {currentPuzzle.solution_line_san.map((san, i) => (
                    <button
                      key={i}
                      onClick={() => setViewPly(i + 1)}
                      style={{
                        padding: "1px 6px",
                        borderRadius: "4px",
                        background: i < viewPly
                          ? "rgba(134,166,102,0.15)"
                          : "var(--bg-elevated)",
                        border: `1px solid ${i < viewPly ? "rgba(134,166,102,0.3)" : "var(--border)"}`,
                        fontSize: "12px",
                        fontFamily: "monospace",
                        fontWeight: 600,
                        color: i < viewPly ? "var(--green)" : "var(--text-muted)",
                        transition: "background 300ms, color 300ms",
                        cursor: "pointer",
                      }}
                    >
                      {san}
                    </button>
                  ))}
                  {viewPly < playedMoves.length && (
                    <span style={{ fontSize: "11px", color: "var(--orange)", marginLeft: "4px", opacity: 0.8 }}>
                      (Viewing history)
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Controls ── */}
        <div
          style={{
            width: "100%",
            maxWidth: "min(900px, calc(100vh - 220px))",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          {/* Solving phase: reveal + skip + (try again on wrong) */}
          {(isSolving || isWrong) && (
            <div style={{ display: "flex", gap: "8px" }}>
              {isWrong && (
                <button
                  onClick={retryPuzzle}
                  style={{
                    padding: "9px 14px",
                    borderRadius: "7px",
                    border: "1px solid rgba(200,120,50,0.4)",
                    background: "rgba(200,120,50,0.1)",
                    color: "var(--orange)",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "background var(--transition-fast)",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(200,120,50,0.2)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(200,120,50,0.1)";
                  }}
                >
                  Try again
                </button>
              )}
              <button
                onClick={handleRevealSolution}
                style={{
                  flex: 1,
                  padding: "9px 16px",
                  borderRadius: "7px",
                  border: "1px solid var(--border)",
                  background: "var(--bg-elevated)",
                  color: "var(--text-primary)",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "background var(--transition-fast)",
                  justifyContent: "center",
                  display: "flex",
                  alignItems: "center",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-elevated)";
                }}
              >
                Reveal Solution
              </button>
              <button
                onClick={() => setCurrentIndex((prev) => prev + 1)}
                style={{
                  padding: "9px 14px",
                  borderRadius: "7px",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: "13px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "color var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                }}
              >
                Skip
              </button>
            </div>
          )}



        </div>
      </section>

      {/* ── Sidebar: Right analysis + puzzle queue ── */}
      <aside
        style={{
          width: "380px",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid #3c3a38",
          background: "#262421",
          overflow: "hidden",
          color: "#ffffff"
        }}
      >
        {isRating && (
          <div style={{ display: "flex", flexDirection: "column", padding: "16px", gap: "16px", borderBottom: "1px solid #3c3a38" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", paddingBottom: "8px", borderBottom: "1px solid #3c3a38" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
              </svg>
              <span style={{ fontSize: "14px", fontWeight: 700, color: "#fff" }}>Live Analysis</span>
            </div>

            <div style={{ background: "#1a1917", border: "1px solid #3c3a38", borderRadius: "8px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #3c3a38", background: "rgba(0,0,0,0.15)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: engineSearching ? "#81b64c" : "#444", animation: engineSearching ? "cgPulse 1.4s ease-in-out infinite" : "none" }} />
                  <span style={{ fontSize: "11px", fontWeight: 700, color: "#aaa", letterSpacing: "0.06em" }}>SF18</span>
                </div>
                <span style={{ fontSize: "11px", color: engineDepth > 0 ? "#81b64c" : "#555", fontVariantNumeric: "tabular-nums" }}>
                  {engineDepth > 0 ? `depth ${engineDepth}` : "loading…"}
                </span>
              </div>
              
              <div style={{ display: "flex", flexDirection: "column" }}>
                {(engineSearching && engineDepth < 6 ? [null, null, null] as (null)[] : engineLines.slice(0, 3)).map((line, idx) =>
                  line ? (
                    <div
                      key={idx}
                      onClick={() => handleApplyEngineLine(line.pvUci.length > 0 ? line.pvUci : [line.move])}
                      style={{
                        display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px",
                        background: idx === 0 ? "rgba(129,182,76,0.07)" : "transparent",
                        borderBottom: idx < 2 ? "1px solid #3c3a38" : "none",
                        cursor: "pointer", transition: "background 0.15s ease",
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = idx === 0 ? "rgba(129,182,76,0.13)" : "rgba(255,255,255,0.04)"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = idx === 0 ? "rgba(129,182,76,0.07)" : "transparent"; }}
                    >
                      <div style={{ background: line.score >= 0 ? "#ececea" : "#1a1917", color: line.score >= 0 ? "#111" : "#ccc", padding: "2px 6px", borderRadius: "4px", fontSize: "12px", fontWeight: 800, minWidth: "48px", textAlign: "center", flexShrink: 0, border: "1px solid rgba(255,255,255,0.07)" }}>
                        {formatEvalPt(line.score)}
                      </div>
                      <div style={{ overflow: "hidden", flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "1px" }}>
                        <span style={{ fontWeight: 800, fontSize: "13px", color: idx === 0 ? "#fff" : "#ccc" }}>{line.san}</span>
                        <span style={{ fontSize: "11px", color: "#666", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {line.pv.split(" ").slice(1).join(" ")}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div key={idx} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", borderBottom: idx < 2 ? "1px solid #3c3a38" : "none" }}>
                      <div style={{ width: "48px", height: "20px", borderRadius: "4px", background: "linear-gradient(90deg, #2c2b29 25%, #3a3836 50%, #2c2b29 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", flexShrink: 0 }} />
                      <div style={{ flex: 1, height: "12px", borderRadius: "3px", background: "linear-gradient(90deg, #2c2b29 25%, #3a3836 50%, #2c2b29 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite 0.2s" }} />
                    </div>
                  )
                )}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#8b8987", textAlign: "center" }}>
                How was this puzzle?
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px" }}>
                {SRS_BUTTONS.map((btn, i) => (
                  <button
                    key={btn.key}
                    onMouseEnter={() => setHoveredSrs(i)}
                    onMouseLeave={() => setHoveredSrs(null)}
                    onClick={() => handleSrsRating(btn.key)}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center",
                      padding: "10px 8px", borderRadius: "8px",
                      background: hoveredSrs === i ? btn.hoverBg : btn.bg,
                      border: `1px solid ${btn.border}`,
                      color: btn.color, cursor: "pointer", fontFamily: "inherit",
                      transition: "background var(--transition-fast), transform 0.1s", gap: "3px",
                    }}
                    onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.96)"; }}
                    onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
                  >
                    <span style={{ fontSize: "14px", fontWeight: 700 }}>{btn.label}</span>
                    <span style={{ fontSize: "10px", opacity: 0.65 }}>{btn.interval} [{btn.shortcut}]</span>
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <button
                  onClick={retryPuzzle}
                  style={{
                    padding: "5px 12px",
                    borderRadius: "5px",
                    border: "1px solid #3c3a38",
                    background: "transparent",
                    color: "#8b8987",
                    fontSize: "11px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "color 150ms",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#e8e6e2"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#8b8987"; }}
                >
                  ↺ Retry this puzzle
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid #3c3a38", fontSize: "11px", fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#8b8987" }}>
          Due Today — {puzzles.length} puzzle{puzzles.length === 1 ? "" : "s"}
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {puzzles.map((puzzle, idx) => {
            const isDone = ratedIds.has(puzzle.id);
            const isCurrent = idx === currentIndex;
            return (
              <button
                key={puzzle.id}
                onClick={() => {
                  setCurrentIndex(idx);
                }}
                style={{
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  gap: "10px",
                  padding: "9px 14px",
                  background: isCurrent ? "rgba(255,255,255,0.05)" : "transparent",
                  color: isDone ? "#8b8987" : "#e8e6e2",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  textAlign: "left",
                  border: "none",
                  borderBottom: "1px solid #3c3a38",
                  transition: "background var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  if (!isCurrent) (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.03)";
                }}
                onMouseLeave={(e) => {
                  if (!isCurrent) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                {/* Status dot */}
                <div style={{ width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0, background: isDone ? "var(--green)" : isCurrent ? "var(--accent)" : "#5a5856" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "12px", fontWeight: isCurrent ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Move {puzzle.move_number}
                    {puzzle.is_brilliant && (
                      <span style={{ marginLeft: "5px", fontSize: "10px", color: "var(--accent)" }}>★</span>
                    )}
                  </div>
                  <div style={{ fontSize: "11px", color: "#8b8987", textTransform: "capitalize" }}>
                    {phaseLabel(puzzle.phase)} · {puzzle.player_color}
                  </div>
                </div>
                {isDone && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            );
          })}
        </div>

        {/* Experimental: reset SRS */}
        <div style={{ padding: "10px 14px", borderTop: "1px solid #3c3a38", flexShrink: 0 }}>
          <button
            disabled={resetting}
            onClick={async () => {
              if (!confirm("Reset all puzzle cooldowns? This clears your SRS progress.")) return;
              setResetting(true);
              try {
                await fetch("/api/puzzles", {
                  method: "DELETE",
                  headers: { ...(await getClientAuthHeaders()) },
                });
                // Reload puzzles
                window.location.reload();
              } catch {
                setResetting(false);
              }
            }}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: "5px",
              border: "1px dashed #3c3a38",
              background: "transparent",
              color: "#5a5856",
              fontSize: "11px",
              cursor: resetting ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "5px",
              transition: "color 150ms, border-color 150ms",
            }}
            onMouseEnter={(e) => {
              if (!resetting) {
                (e.currentTarget as HTMLButtonElement).style.color = "#f05149";
                (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(240,81,73,0.4)";
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = "#5a5856";
              (e.currentTarget as HTMLButtonElement).style.borderColor = "#3c3a38";
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>
            </svg>
            {resetting ? "Resetting…" : "⚗ Experimental: Reset SRS"}
          </button>
        </div>
      </aside>
    </div>
  );
}
