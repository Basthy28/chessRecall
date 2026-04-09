"use client";

import { useState, useCallback } from "react";
import ChessBoard from "@/components/board/ChessBoard";
import TrainingQueue from "@/components/training/TrainingQueue";
import GamesPanel from "@/components/training/GamesPanel";
import PuzzleTrainer from "@/components/training/PuzzleTrainer";
import Button from "@/components/ui/Button";
import AuthModal from "@/components/auth/AuthModal";
import { useAuth } from "@/hooks/useAuth";
import { createBrowserClient } from "@/lib/supabase";
import {
  readLinkedAccounts,
  saveLinkedAccounts,
  restoreLinkedAccountsFromSupabase,
} from "@/lib/linkedAccounts";
import type { Puzzle } from "@/types";

// Placeholder puzzles — will be replaced by real Supabase data in Phase 2
const MOCK_PUZZLES: Puzzle[] = [
  {
    id: "1",
    game_id: "g1",
    user_id: "u1",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    blunder_move: "f3g5",
    solution_move: "d1e2",
    solution_san: "Qe2",
    solution_line_uci: ["d1e2"],
    solution_line_san: ["Qe2"],
    is_brilliant: false,
    eval_before: 30,
    eval_after: -180,
    eval_best: 25,
    eval_second_best: -40,
    eval_drop: 210,
    move_number: 7,
    player_color: "white",
    phase: "opening",
    status: "validated",
    times_seen: 0,
    times_correct: 0,
    srs_due_at: null,
    srs_ease: 2.5,
    last_reviewed_at: null,
    created_at: new Date().toISOString(),
  },
  {
    id: "2",
    game_id: "g2",
    user_id: "u1",
    fen: "r2q1rk1/pp2ppbp/2n3p1/3pPb2/3P1B2/2NB1N2/PP3PPP/R2QR1K1 w - - 2 12",
    blunder_move: "d3h7",
    solution_move: "e5e6",
    solution_san: "e6!",
    solution_line_uci: ["e5e6", "f7e6", "d3h7"],
    solution_line_san: ["e6!", "fxe6", "Bxh7+"],
    is_brilliant: false,
    eval_before: 120,
    eval_after: -250,
    eval_best: 180,
    eval_second_best: 40,
    eval_drop: 370,
    move_number: 24,
    player_color: "white",
    phase: "middlegame",
    status: "validated",
    times_seen: 2,
    times_correct: 1,
    srs_due_at: new Date(Date.now() + 86400000).toISOString(),
    srs_ease: 2.3,
    last_reviewed_at: new Date(Date.now() - 86400000).toISOString(),
    created_at: new Date().toISOString(),
  },
  {
    id: "3",
    game_id: "g3",
    user_id: "u1",
    fen: "8/5kpp/4p3/3pP3/3P2P1/5K2/8/8 w - - 0 40",
    blunder_move: "f3e3",
    solution_move: "g4g5",
    solution_san: "g5",
    solution_line_uci: ["g4g5", "h7g6", "f3f4"],
    solution_line_san: ["g5", "hxg6", "Kf4"],
    is_brilliant: false,
    eval_before: 80,
    eval_after: -60,
    eval_best: 150,
    eval_second_best: 30,
    eval_drop: 140,
    move_number: 40,
    player_color: "white",
    phase: "endgame",
    status: "validated",
    times_seen: 5,
    times_correct: 4,
    srs_due_at: new Date(Date.now() + 3 * 86400000).toISOString(),
    srs_ease: 2.7,
    last_reviewed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    created_at: new Date().toISOString(),
  },
];

// ── SVG Knight icon ──────────────────────────────────────────────────────────
function KnightIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 45 45"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18"
        fill="var(--accent)"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10"
        fill="var(--accent)"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="25.5" r="0.5" fill="#1a1510" />
      <path
        d="M 24.55,10.4 L 24.1,11.85 L 24.6,12 C 27.75,13 29.25,14.95 29.5,18.5 L 29.5,18.5 C 29.5,18.5 29,19.5 28,19.5 C 26,19.5 24.5,18.5 24,18.5 C 23.5,18.5 22.5,19.5 21.5,19.5 C 20.5,19.5 19.5,18.5 19,18.5"
        stroke="#1a1510"
        strokeWidth="0.5"
        fill="none"
      />
    </svg>
  );
}

// ── SRS Rating button config ─────────────────────────────────────────────────
const SRS_BUTTONS = [
  {
    label: "Missed it",
    shortcut: "1",
    bg: "rgba(185,64,64,0.15)",
    color: "var(--red)",
    border: "rgba(185,64,64,0.35)",
    hoverBg: "rgba(185,64,64,0.25)",
  },
  {
    label: "Hard",
    shortcut: "2",
    bg: "rgba(200,120,50,0.15)",
    color: "var(--orange)",
    border: "rgba(200,120,50,0.35)",
    hoverBg: "rgba(200,120,50,0.25)",
  },
  {
    label: "Got it",
    shortcut: "3",
    bg: "rgba(134,166,102,0.15)",
    color: "var(--green)",
    border: "rgba(134,166,102,0.35)",
    hoverBg: "rgba(134,166,102,0.25)",
  },
  {
    label: "Easy",
    shortcut: "4",
    bg: "rgba(74,158,142,0.15)",
    color: "var(--teal)",
    border: "rgba(74,158,142,0.35)",
    hoverBg: "rgba(74,158,142,0.25)",
  },
] as const;

// ── Main component ────────────────────────────────────────────────────────────
export default function TrainingDashboard() {
  const { userId, userEmail, loading: authLoading } = useAuth();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [activePuzzle, setActivePuzzle] = useState<Puzzle | null>(
    MOCK_PUZZLES[0] ?? null
  );
  const [showSolution, setShowSolution] = useState(false);
  const [activeNav, setActiveNav] = useState<"train" | "puzzles" | "games" | "stats" | "settings">("train");
  const [hoveredSrs, setHoveredSrs] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const handleAuthSuccess = useCallback(async (newUserId: string) => {
    setShowAuthModal(false);
    // After login: restore linked accounts from Supabase if localStorage is empty
    const local = readLinkedAccounts();
    if (!local.lichess && !local.chessCom) {
      const restored = await restoreLinkedAccountsFromSupabase();
      if (restored) {
        saveLinkedAccounts(restored);
      }
    }
    // Suppress unused variable warning — userId comes from useAuth hook reactively
    void newUserId;
  }, []);

  const handleSignOut = useCallback(async () => {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      {showAuthModal && (
        <AuthModal
          onAuthSuccess={handleAuthSuccess}
          onDismiss={() => setShowAuthModal(false)}
        />
      )}
      {/* ════════════════════════════════════════
          Header
      ════════════════════════════════════════ */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 24px",
          height: "56px",
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          position: "sticky",
          top: 0,
          zIndex: 50,
          backgroundImage:
            "linear-gradient(180deg, var(--bg-surface) 0%, color-mix(in srgb, var(--bg-surface) 80%, var(--bg-base)) 100%)",
        }}
      >
        {/* Left: Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <KnightIcon />
          <span
            style={{
              fontSize: "17px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "var(--accent)",
              lineHeight: 1,
            }}
          >
            Chess Recall
          </span>
          {/* Streak pill */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "3px 9px",
              borderRadius: "20px",
              background: "rgba(192,160,96,0.12)",
              border: "1px solid rgba(192,160,96,0.25)",
              fontSize: "11px",
              fontWeight: 700,
              color: "var(--accent)",
              letterSpacing: "0.02em",
            }}
          >
            <span>🔥</span>
            <span>7 day streak</span>
          </div>
        </div>

        {/* Center: Nav */}
        <nav style={{ display: "flex", gap: "2px" }}>
          {(["train", "puzzles", "games", "stats", "settings"] as const).map((item) => {
            const isActive = activeNav === item;
            return (
              <button
                key={item}
                onClick={() => setActiveNav(item)}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "none",
                  background: isActive ? "var(--bg-elevated)" : "transparent",
                  color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                  fontSize: "13px",
                  fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  letterSpacing: "0.01em",
                  transition: "background var(--transition-fast), color var(--transition-fast)",
                  textTransform: "capitalize",
                }}
                onMouseEnter={(e) => {
                  if (!isActive)
                    (e.currentTarget as HTMLButtonElement).style.color =
                      "var(--text-primary)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive)
                    (e.currentTarget as HTMLButtonElement).style.color =
                      "var(--text-muted)";
                }}
              >
                {item === "train" ? "Train" : item === "puzzles" ? "Puzzles" : item.charAt(0).toUpperCase() + item.slice(1)}
              </button>
            );
          })}
        </nav>

        {/* Right: actions */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <Button variant="primary" size="md">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Import Games
          </Button>

          {/* Auth controls */}
          {!authLoading && (
            userId ? (
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span
                  title={userEmail ?? userId}
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    maxWidth: "140px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {userEmail ?? "Signed in"}
                </span>
                <button
                  onClick={handleSignOut}
                  title="Sign out"
                  style={{
                    padding: "5px 10px",
                    borderRadius: "6px",
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--text-muted)",
                    fontSize: "12px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "color 0.15s, border-color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-subtle)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                  }}
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "1px solid rgba(129,182,76,0.4)",
                  background: "rgba(129,182,76,0.1)",
                  color: "#81b64c",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "background 0.15s, border-color 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(129,182,76,0.18)";
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(129,182,76,0.6)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(129,182,76,0.1)";
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(129,182,76,0.4)";
                }}
              >
                Sign In
              </button>
            )
          )}
          {activeNav === "train" && (
            <button
              onClick={() => setSidebarOpen((o) => !o)}
              title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                border: "1px solid var(--border)",
                background: sidebarOpen ? "var(--bg-elevated)" : "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {sidebarOpen
                  ? <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></>
                  : <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></>
                }
              </svg>
            </button>
          )}
        </div>
      </header>

      {/* ════════════════════════════════════════
          Main layout
      ════════════════════════════════════════ */}
      <main
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        {activeNav === "games" ? (
          <GamesPanel />
        ) : activeNav === "puzzles" ? (
          <PuzzleTrainer />
        ) : (
          <>
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
          {/* Status line above board */}
          {activePuzzle && (
            <div
              style={{
                width: "100%",
                maxWidth: "min(900px, calc(100vh - 220px))",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "13px",
                  color: "var(--text-muted)",
                }}
              >
                <span
                  style={{
                    fontVariantNumeric: "tabular-nums",
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  Move {activePuzzle.move_number}
                </span>
                <span style={{ opacity: 0.4 }}>·</span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <span
                    style={{
                      width: "10px",
                      height: "10px",
                      borderRadius: "50%",
                      background:
                        activePuzzle.player_color === "white"
                          ? "#e8e6e2"
                          : "#1a1a1a",
                      border: "1.5px solid var(--border)",
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  <span>
                    {activePuzzle.player_color === "white" ? "White" : "Black"}&apos;s
                    turn
                  </span>
                </span>
              </div>

              {/* "Your turn" badge */}
              {!showSolution && (
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
                    letterSpacing: "0.01em",
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  Your turn
                </div>
              )}
            </div>
          )}

          {/* Board card — NO inner padding wrapper; padding shifts the board
               from where chessground's cached bounds think it is, causing
               arrow-drawing to be offset. Rank coordinate clearance is
               handled by overflow: visible on the ChessBoard outer div. */}
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
              fen={activePuzzle?.fen}
              orientation={activePuzzle?.player_color ?? "white"}
              interactive={!showSolution}
            />
          </div>

          {/* Blunder detected banner (shown when solution is revealed) */}
          {showSolution && activePuzzle && (
            <div
              style={{
                width: "100%",
                maxWidth: "min(900px, calc(100vh - 220px))",
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px 14px",
                borderRadius: "7px",
                background: "rgba(185,64,64,0.1)",
                border: "1px solid rgba(185,64,64,0.25)",
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--red)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "var(--red)",
                    marginBottom: "1px",
                  }}
                >
                  Blunder detected — eval drop: {activePuzzle.eval_drop} cp
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                  }}
                >
                  Best move was{" "}
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontWeight: 700,
                      color: "var(--green)",
                    }}
                  >
                    {activePuzzle.solution_san}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Controls below board */}
          {activePuzzle && (
            <div
              style={{
                width: "100%",
                maxWidth: "min(900px, calc(100vh - 220px))",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              {/* Show/hide solution toggle */}
              {!showSolution ? (
                <div style={{ display: "flex", gap: "8px" }}>
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => setShowSolution(true)}
                    style={{ flex: 1, justifyContent: "center" }}
                  >
                    Reveal Solution
                  </Button>
                  <Button variant="ghost" size="md">
                    Skip
                  </Button>
                </div>
              ) : (
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
                    How did you do?
                  </div>
                  {/* SRS Rating buttons */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr 1fr",
                      gap: "6px",
                    }}
                  >
                    {SRS_BUTTONS.map((btn, i) => (
                      <button
                        key={btn.label}
                        onMouseEnter={() => setHoveredSrs(i)}
                        onMouseLeave={() => setHoveredSrs(null)}
                        onClick={() => setShowSolution(false)}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          padding: "8px 6px 7px",
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
                        <span
                          style={{
                            fontSize: "12px",
                            fontWeight: 700,
                            lineHeight: 1.2,
                          }}
                        >
                          {btn.label}
                        </span>
                        <span
                          style={{
                            fontSize: "10px",
                            opacity: 0.6,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          [{btn.shortcut}]
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Sidebar ── */}
        <aside
          style={{
            width: sidebarOpen ? "320px" : "0",
            minWidth: sidebarOpen ? "320px" : "0",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            borderLeft: sidebarOpen ? "1px solid var(--border-subtle)" : "none",
            overflowY: sidebarOpen ? "auto" : "hidden",
            overflowX: "hidden",
            background: "var(--bg-surface)",
            transition: "width 200ms ease, min-width 200ms ease",
          }}
        >
          {sidebarOpen && (
            <TrainingQueue
              puzzles={MOCK_PUZZLES}
              activePuzzleId={activePuzzle?.id ?? null}
              onSelect={(puzzle) => {
                setActivePuzzle(puzzle);
                setShowSolution(false);
              }}
            />
          )}
        </aside>
          </>
        )}
      </main>
    </div>
  );
}
