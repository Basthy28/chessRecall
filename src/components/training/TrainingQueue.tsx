"use client";

import { useEffect, useState } from "react";
import type { Puzzle, PuzzlePhase } from "@/types";
import Badge from "@/components/ui/Badge";
import StatPill from "@/components/ui/StatPill";
import Button from "@/components/ui/Button";
import {
  getLinkedUsername,
  readLinkedAccounts,
  saveLinkedAccounts,
  syncLinkedAccountsToSupabase,
  type LinkedAccounts,
} from "@/lib/linkedAccounts";

interface TrainingQueueProps {
  puzzles: Puzzle[];
  activePuzzleId: string | null;
  onSelect: (puzzle: Puzzle) => void;
}

const PHASE_SYMBOL: Record<PuzzlePhase, string> = {
  opening: "♙",
  middlegame: "♟",
  endgame: "♚",
};

function getSrsLabel(puzzle: Puzzle): "new" | "learning" | "review" {
  if (puzzle.times_seen === 0) return "new";
  if (puzzle.times_seen < 3) return "learning";
  return "review";
}

function getEvalSeverity(drop: number): { color: string; bars: number } {
  if (drop >= 300) return { color: "var(--red)", bars: 3 };
  if (drop >= 150) return { color: "var(--orange)", bars: 2 };
  return { color: "var(--accent)", bars: 1 };
}

export default function TrainingQueue({
  puzzles,
  activePuzzleId,
  onSelect,
}: TrainingQueueProps) {
  const [platform, setPlatform] = useState<"lichess" | "chess.com">("lichess");
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccounts>({
    lichess: "",
    chessCom: "",
  });
  const [accountInput, setAccountInput] = useState("");

  useEffect(() => {
    const accounts = readLinkedAccounts();
    setLinkedAccounts(accounts);
    setAccountInput(getLinkedUsername(accounts, "lichess"));
  }, []);

  useEffect(() => {
    setAccountInput(getLinkedUsername(linkedAccounts, platform));
  }, [linkedAccounts, platform]);

  function linkAccount() {
    const normalized = accountInput.trim().toLowerCase();
    if (!normalized) return;
    const next: LinkedAccounts =
      platform === "chess.com"
        ? { ...linkedAccounts, chessCom: normalized }
        : { ...linkedAccounts, lichess: normalized };
    setLinkedAccounts(next);
    saveLinkedAccounts(next);
    void syncLinkedAccountsToSupabase(next);
    setAccountInput(normalized);
  }

  function unlinkAccount(p: "lichess" | "chess.com") {
    const next: LinkedAccounts =
      p === "chess.com"
        ? { ...linkedAccounts, chessCom: "" }
        : { ...linkedAccounts, lichess: "" };
    setLinkedAccounts(next);
    saveLinkedAccounts(next);
    void syncLinkedAccountsToSupabase(next);
    if (p === platform) setAccountInput("");
  }

  const due = puzzles.filter(
    (p) => p.srs_due_at === null || new Date(p.srs_due_at) <= new Date()
  );
  const upcoming = puzzles.filter(
    (p) => p.srs_due_at !== null && new Date(p.srs_due_at) > new Date()
  );

  const doneCount = puzzles.filter((p) => p.times_seen > 0).length;
  const correctRate =
    puzzles.length > 0
      ? Math.round(
          (puzzles.reduce((s, p) => s + p.times_correct, 0) /
            Math.max(
              puzzles.reduce((s, p) => s + p.times_seen, 0),
              1
            )) *
            100
        )
      : 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-surface)",
      }}
    >
      {/* ── Session header ── */}
      <div
        style={{
          padding: "16px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <div
          style={{
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            marginBottom: "10px",
          }}
        >
          Today&apos;s Session
        </div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <StatPill label="Due" value={due.length} accent="red" />
          <StatPill label="Done" value={doneCount} accent="green" />
          <StatPill label="Rate" value={`${correctRate}%`} accent="gold" />
        </div>
      </div>

      {/* ── Accounts section ── */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-elevated)",
        }}
      >
        {/* Platform toggle */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "8px" }}>
          {(["lichess", "chess.com"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              style={{
                flex: 1,
                padding: "4px 8px",
                borderRadius: "5px",
                border: platform === p
                  ? "1px solid var(--accent)"
                  : "1px solid var(--border)",
                background: platform === p ? "var(--accent-dim)" : "transparent",
                color: platform === p ? "var(--accent)" : "var(--text-muted)",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
                letterSpacing: "0.03em",
                transition: "all var(--transition-fast)",
              }}
            >
              {p === "lichess" ? "Lichess" : "Chess.com"}
            </button>
          ))}
        </div>

        {getLinkedUsername(linkedAccounts, platform) ? (
          /* Linked state — show username + unlink */
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{
              flex: 1, fontSize: "12px", fontWeight: 600,
              color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {getLinkedUsername(linkedAccounts, platform)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => unlinkAccount(platform)}
            >
              Unlink
            </Button>
          </div>
        ) : (
          /* Unlinked state — show input + link */
          <div style={{ display: "flex", gap: "6px" }}>
            <input
              type="text"
              placeholder={platform === "lichess" ? "Lichess username" : "Chess.com username"}
              value={accountInput}
              onChange={(e) => setAccountInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && linkAccount()}
              style={{
                flex: 1,
                background: "var(--bg-base)",
                border: "1px solid var(--border)",
                borderRadius: "5px",
                padding: "6px 10px",
                fontSize: "12px",
                color: "var(--text-primary)",
                outline: "none",
                minWidth: 0,
                fontFamily: "inherit",
              }}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={linkAccount}
              disabled={!accountInput.trim()}
            >
              Link
            </Button>
          </div>
        )}
      </div>

      {/* ── Puzzle list ── */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* Due now section */}
        {due.length > 0 && (
          <div
            style={{
              padding: "8px 16px 4px",
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
            }}
          >
            Due Now
          </div>
        )}

        {due.length === 0 && (
          <div
            style={{
              padding: "32px 16px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: "13px",
            }}
          >
            <div style={{ fontSize: "28px", marginBottom: "8px", opacity: 0.4 }}>♟</div>
            No puzzles due.
            <br />
            Link an account and sync games to get started.
          </div>
        )}

        {due.map((puzzle) => (
          <PuzzleCard
            key={puzzle.id}
            puzzle={puzzle}
            isActive={puzzle.id === activePuzzleId}
            onClick={() => onSelect(puzzle)}
          />
        ))}

        {/* Upcoming section */}
        {upcoming.length > 0 && (
          <>
            <div
              style={{
                padding: "10px 16px 4px",
                fontSize: "10px",
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--text-muted)",
                borderTop: "1px solid var(--border-subtle)",
                marginTop: "4px",
              }}
            >
              Upcoming
            </div>
            {upcoming.map((puzzle) => (
              <PuzzleCard
                key={puzzle.id}
                puzzle={puzzle}
                isActive={puzzle.id === activePuzzleId}
                onClick={() => onSelect(puzzle)}
                muted
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function PuzzleCard({
  puzzle,
  isActive,
  onClick,
  muted = false,
}: {
  puzzle: Puzzle;
  isActive: boolean;
  onClick: () => void;
  muted?: boolean;
}) {
  const srsLabel = getSrsLabel(puzzle);
  const { color: severityColor, bars: severityBars } = getEvalSeverity(puzzle.eval_drop);

  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        display: "flex",
        gap: "10px",
        padding: "10px 16px",
        textAlign: "left",
        background: isActive ? "var(--bg-hover)" : "transparent",
        border: "none",
        borderBottom: "1px solid var(--border-subtle)",
        borderLeft: isActive
          ? "3px solid var(--accent)"
          : "3px solid transparent",
        cursor: "pointer",
        opacity: muted ? 0.5 : 1,
        transition: "background var(--transition-fast), border-color var(--transition-fast)",
        fontFamily: "inherit",
        paddingLeft: isActive ? "13px" : "13px",
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-hover)";
          (e.currentTarget as HTMLButtonElement).style.borderLeftColor = "var(--border)";
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          (e.currentTarget as HTMLButtonElement).style.borderLeftColor = "transparent";
        }
      }}
    >
      {/* Mini thumbnail */}
      <div
        style={{
          flexShrink: 0,
          width: "40px",
          height: "40px",
          borderRadius: "6px",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1px",
        }}
      >
        <span style={{ fontSize: "18px", lineHeight: 1 }}>
          {PHASE_SYMBOL[puzzle.phase]}
        </span>
        <span
          style={{
            fontSize: "8px",
            color: "var(--text-muted)",
            letterSpacing: "0.03em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          {puzzle.phase.slice(0, 3)}
        </span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Top row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "3px",
          }}
        >
          <span
            style={{
              fontSize: "11px",
              color: "var(--text-muted)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            Move {puzzle.move_number} ·{" "}
            {puzzle.player_color === "white" ? "White" : "Black"}
          </span>
          <Badge variant={srsLabel} />
        </div>

        {/* Solution move */}
        <div
          style={{
            fontSize: "14px",
            fontWeight: 700,
            fontFamily: "monospace",
            color: "var(--text-primary)",
            marginBottom: "5px",
            letterSpacing: "-0.01em",
          }}
        >
          {puzzle.solution_san}
        </div>

        {/* Eval drop severity bar */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ display: "flex", gap: "2px", alignItems: "center" }}>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  width: "3px",
                  height: i <= severityBars ? "10px" : "6px",
                  borderRadius: "2px",
                  background:
                    i <= severityBars ? severityColor : "var(--border)",
                  opacity: i <= severityBars ? 1 : 0.5,
                  transition: "height 0.2s",
                }}
              />
            ))}
          </div>
          <span
            style={{
              fontSize: "11px",
              color: severityColor,
              fontVariantNumeric: "tabular-nums",
              fontWeight: 600,
            }}
          >
            -{puzzle.eval_drop} cp
          </span>
        </div>
      </div>
    </button>
  );
}
