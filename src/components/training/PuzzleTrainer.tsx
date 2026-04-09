"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import ChessBoard from "@/components/board/ChessBoard";
import { createBrowserClient } from "@/lib/supabase";
import type { Puzzle } from "@/types";

// ── Constants ────────────────────────────────────────────────────────────────
const PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000001";

// SRS intervals in milliseconds
const SRS_INTERVALS = {
  hard: 10 * 60 * 1000,          // 10 minutes
  good: 24 * 60 * 60 * 1000,     // 1 day
  easy: 4 * 24 * 60 * 60 * 1000, // 4 days
} as const;

type SrsChoice = keyof typeof SRS_INTERVALS;
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
    interval: "10 min",
  },
  {
    key: "good",
    label: "Good",
    shortcut: "2",
    bg: "rgba(134,166,102,0.15)",
    color: "var(--green)",
    border: "rgba(134,166,102,0.35)",
    hoverBg: "rgba(134,166,102,0.25)",
    interval: "1 day",
  },
  {
    key: "easy",
    label: "Easy",
    shortcut: "3",
    bg: "rgba(74,158,142,0.15)",
    color: "var(--teal)",
    border: "rgba(74,158,142,0.35)",
    hoverBg: "rgba(74,158,142,0.25)",
    interval: "4 days",
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
  const [puzzles, setPuzzles] = useState<Puzzle[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [state, setState] = useState<PuzzleState>("solving");
  const [displayFen, setDisplayFen] = useState<string | undefined>(undefined);
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredSrs, setHoveredSrs] = useState<number | null>(null);
  const [animatingLine, setAnimatingLine] = useState(false);
  const [lineIndex, setLineIndex] = useState(0);
  const [lineFens, setLineFens] = useState<string[]>([]);
  const [lineLastMoves, setLineLastMoves] = useState<Array<[Key, Key]>>([]);

  const wrongResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch due puzzles ─────────────────────────────────────────────────────
  useEffect(() => {
    async function fetchPuzzles() {
      setLoading(true);
      setError(null);
      try {
        const supabase = createBrowserClient();
        const now = new Date().toISOString();
        const { data, error: sbError } = await supabase
          .from("puzzles")
          .select("*")
          .eq("user_id", PLACEHOLDER_USER_ID)
          .or(`srs_due_at.is.null,srs_due_at.lte.${now}`)
          .order("srs_due_at", { ascending: true, nullsFirst: true })
          .limit(20);

        if (sbError) throw sbError;
        setPuzzles((data as Puzzle[]) ?? []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setLoading(false);
      }
    }

    fetchPuzzles();
  }, []);

  // ── Reset board when puzzle changes ──────────────────────────────────────
  const currentPuzzle = puzzles[currentIndex] ?? null;

  useEffect(() => {
    if (!currentPuzzle) return;
    setDisplayFen(currentPuzzle.fen);
    setLastMove(undefined);
    setState("solving");
    setAnimatingLine(false);
    setLineIndex(0);
    setLineFens([]);
    setLineLastMoves([]);
  }, [currentPuzzle]);

  // ── Keyboard shortcuts for SRS rating ────────────────────────────────────
  useEffect(() => {
    if (state !== "rating") return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "1") handleSrsRating("hard");
      else if (e.key === "2") handleSrsRating("good");
      else if (e.key === "3") handleSrsRating("easy");
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // ── Cleanup timers on unmount ─────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (wrongResetTimerRef.current) clearTimeout(wrongResetTimerRef.current);
      if (lineAnimTimerRef.current) clearTimeout(lineAnimTimerRef.current);
    };
  }, []);

  // ── Animate solution line after correct move ──────────────────────────────
  const animateSolutionLine = useCallback((puzzle: Puzzle) => {
    setAnimatingLine(true);

    // Build the sequence of FENs for the solution line
    const fens: string[] = [];
    const moves: Array<[Key, Key]> = [];
    let fen = puzzle.fen;

    // First apply the solution move itself
    const solutionFen = applyUciMove(fen, puzzle.solution_move);
    if (solutionFen) {
      fens.push(solutionFen);
      moves.push(uciToSquares(puzzle.solution_move));
      fen = solutionFen;
    }

    // Then apply the rest of the PV line (skip first element which is solution_move)
    for (let i = 1; i < puzzle.solution_line_uci.length; i++) {
      const uci = puzzle.solution_line_uci[i];
      const nextFen = applyUciMove(fen, uci);
      if (!nextFen) break;
      fens.push(nextFen);
      moves.push(uciToSquares(uci));
      fen = nextFen;
    }

    setLineFens(fens);
    setLineLastMoves(moves);
    setLineIndex(0);

    // Show first move immediately
    if (fens.length > 0) {
      setDisplayFen(fens[0]);
      setLastMove(moves[0]);
    }

    // Animate subsequent moves
    let idx = 1;
    function step() {
      if (idx >= fens.length) {
        setAnimatingLine(false);
        return;
      }
      lineAnimTimerRef.current = setTimeout(() => {
        setDisplayFen(fens[idx]);
        setLastMove(moves[idx]);
        setLineIndex(idx);
        idx++;
        step();
      }, 700);
    }
    if (fens.length > 1) {
      lineAnimTimerRef.current = setTimeout(step, 700);
    } else {
      setAnimatingLine(false);
    }
  }, []);

  // ── Handle user move ──────────────────────────────────────────────────────
  const handleMove = useCallback((orig: Key, dest: Key) => {
    if (!currentPuzzle) return;
    if (state !== "solving") return;

    const moveUci = `${orig}${dest}`;
    const isCorrect = moveUci === currentPuzzle.solution_move;

    if (isCorrect) {
      setLastMove([orig, dest]);
      const newFen = applyUciMove(currentPuzzle.fen, moveUci);
      if (newFen) setDisplayFen(newFen);
      setState("correct");
      // Start animating the solution line after a short pause
      setTimeout(() => animateSolutionLine(currentPuzzle), 400);
    } else {
      // Show wrong move briefly then snap back
      setState("wrong");
      const wrongFen = applyUciMove(currentPuzzle.fen, moveUci);
      if (wrongFen) {
        setDisplayFen(wrongFen);
        setLastMove([orig, dest]);
      }
      wrongResetTimerRef.current = setTimeout(() => {
        setDisplayFen(currentPuzzle.fen);
        setLastMove(undefined);
        setState("solving");
      }, 900);
    }
  }, [currentPuzzle, state, animateSolutionLine]);

  // ── Reveal solution manually ──────────────────────────────────────────────
  const handleRevealSolution = useCallback(() => {
    if (!currentPuzzle) return;
    setState("correct");
    setTimeout(() => animateSolutionLine(currentPuzzle), 200);
  }, [currentPuzzle, animateSolutionLine]);

  // ── SRS rating update ─────────────────────────────────────────────────────
  const handleSrsRating = useCallback(async (choice: SrsChoice) => {
    if (!currentPuzzle) return;

    const dueAt = new Date(Date.now() + SRS_INTERVALS[choice]).toISOString();
    const isCorrect = state === "rating"; // always correct if rating panel is shown after solving

    try {
      const supabase = createBrowserClient();
      await supabase
        .from("puzzles")
        .update({
          times_seen: (currentPuzzle.times_seen ?? 0) + 1,
          times_correct: (currentPuzzle.times_correct ?? 0) + (isCorrect ? 1 : 0),
          srs_ease: 2.5,
          srs_due_at: dueAt,
          last_reviewed_at: new Date().toISOString(),
        })
        .eq("id", currentPuzzle.id);
    } catch {
      // Silently fail — puzzle still advances
    }

    // Move to next puzzle
    setCurrentIndex((prev) => prev + 1);
  }, [currentPuzzle, state]);

  // ── Trigger rating panel after correct move + line animation ────────────
  useEffect(() => {
    if (state === "correct" && !animatingLine && lineFens.length > 0) {
      // Show rating panel after animation completes
      const timer = setTimeout(() => setState("rating"), 500);
      return () => clearTimeout(timer);
    }
    if (state === "correct" && !animatingLine && lineFens.length === 0) {
      // No line to animate, show rating immediately
      const timer = setTimeout(() => setState("rating"), 600);
      return () => clearTimeout(timer);
    }
  }, [state, animatingLine, lineFens.length]);

  // ── Render ────────────────────────────────────────────────────────────────
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
          <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            You reviewed {puzzles.length} puzzle{puzzles.length === 1 ? "" : "s"}.
          </div>
        </div>
      </div>
    );
  }

  const isSolving = state === "solving";
  const isWrong = state === "wrong";
  const isCorrect = state === "correct" || state === "rating";
  const isRating = state === "rating";

  // Board is interactive only while solving
  const boardInteractive = isSolving;

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
          justifyContent: "center",
          flex: 1,
          padding: "16px 20px",
          gap: "12px",
          minWidth: 0,
          overflow: "hidden",
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
            fen={displayFen ?? currentPuzzle.fen}
            orientation={currentPuzzle.player_color}
            interactive={boardInteractive}
            onMove={handleMove}
            lastMove={lastMove}
            showCoordinates
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
                    <span
                      key={i}
                      style={{
                        padding: "1px 6px",
                        borderRadius: "4px",
                        background: i <= lineIndex
                          ? "rgba(134,166,102,0.15)"
                          : "var(--bg-elevated)",
                        border: `1px solid ${i <= lineIndex ? "rgba(134,166,102,0.3)" : "var(--border)"}`,
                        fontSize: "12px",
                        fontFamily: "monospace",
                        fontWeight: 600,
                        color: i <= lineIndex ? "var(--green)" : "var(--text-muted)",
                        transition: "background 300ms, color 300ms",
                      }}
                    >
                      {san}
                    </span>
                  ))}
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
          {/* Solving phase: reveal button */}
          {(isSolving || isWrong) && (
            <div style={{ display: "flex", gap: "8px" }}>
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

          {/* Correct phase, still animating: next puzzle button */}
          {isCorrect && !isRating && !animatingLine && (
            <button
              onClick={() => setState("rating")}
              style={{
                padding: "9px 16px",
                borderRadius: "7px",
                border: "1px solid rgba(134,166,102,0.35)",
                background: "rgba(134,166,102,0.1)",
                color: "var(--green)",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
              Next puzzle
            </button>
          )}

          {/* Rating phase: SRS buttons */}
          {isRating && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.07em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  textAlign: "center",
                }}
              >
                How was this puzzle?
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: "6px",
                }}
              >
                {SRS_BUTTONS.map((btn, i) => (
                  <button
                    key={btn.key}
                    onMouseEnter={() => setHoveredSrs(i)}
                    onMouseLeave={() => setHoveredSrs(null)}
                    onClick={() => handleSrsRating(btn.key)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      padding: "9px 8px 8px",
                      borderRadius: "7px",
                      background: hoveredSrs === i ? btn.hoverBg : btn.bg,
                      border: `1px solid ${btn.border}`,
                      color: btn.color,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      transition: "background var(--transition-fast)",
                      gap: "2px",
                    }}
                  >
                    <span style={{ fontSize: "13px", fontWeight: 700, lineHeight: 1.2 }}>
                      {btn.label}
                    </span>
                    <span style={{ fontSize: "10px", opacity: 0.65 }}>
                      {btn.interval} [{btn.shortcut}]
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Sidebar: puzzle queue ── */}
      <aside
        style={{
          width: "240px",
          minWidth: "240px",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border-subtle)",
          overflowY: "auto",
          background: "var(--bg-surface)",
        }}
      >
        <div
          style={{
            padding: "12px 14px 8px",
            borderBottom: "1px solid var(--border-subtle)",
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          Due Today — {puzzles.length} puzzle{puzzles.length === 1 ? "" : "s"}
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {puzzles.map((puzzle, idx) => {
            const isDone = idx < currentIndex;
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
                  background: isCurrent ? "var(--bg-elevated)" : "transparent",
                  color: isDone ? "var(--text-muted)" : "var(--text-primary)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  textAlign: "left",
                  border: "none",
                  borderBottom: "1px solid var(--border-subtle)",
                  transition: "background var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  if (!isCurrent) (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isCurrent) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                {/* Status dot */}
                <div
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: isDone
                      ? "var(--green)"
                      : isCurrent
                      ? "var(--accent)"
                      : "var(--border)",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "12px", fontWeight: isCurrent ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Move {puzzle.move_number}
                    {puzzle.is_brilliant && (
                      <span style={{ marginLeft: "5px", fontSize: "10px", color: "var(--accent)" }}>★</span>
                    )}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "capitalize" }}>
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
      </aside>
    </div>
  );
}
