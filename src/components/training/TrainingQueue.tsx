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
  const [importState, setImportState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [importMsg, setImportMsg] = useState("");

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
    setImportMsg(
      `${platform === "chess.com" ? "Chess.com" : "Lichess"} account linked: ${normalized}`
    );
    setImportState("success");
  }

  async function handleImport(requestedPlatform = platform) {
    const storedUsername = getLinkedUsername(linkedAccounts, requestedPlatform);
    const trimmed = (storedUsername || accountInput).trim().toLowerCase();
    if (!trimmed) return;

    if (!storedUsername) {
      const next: LinkedAccounts =
        requestedPlatform === "chess.com"
          ? { ...linkedAccounts, chessCom: trimmed }
          : { ...linkedAccounts, lichess: trimmed };
      setLinkedAccounts(next);
      saveLinkedAccounts(next);
      void syncLinkedAccountsToSupabase(next);
    }

    setImportState("loading");
    setImportMsg("");
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: trimmed, platform: requestedPlatform }),
      });
      const json = await res.json() as {
        imported?: number;
        queued?: number;
        skippedQueue?: number;
        analyzeLimit?: number;
        queueUnavailable?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setImportState("error");
        setImportMsg(json.error ?? "Sync failed.");
      } else {
        let totalsMsg = "";
        try {
          const totalsRes = await fetch("/api/import", { method: "GET" });
          if (totalsRes.ok) {
            const totals = await totalsRes.json() as { games?: number; puzzles?: number };
            totalsMsg = ` Total: ${totals.games ?? 0} games, ${totals.puzzles ?? 0} puzzles.`;
          }
        } catch {
          // Ignore totals lookup failures and keep primary import feedback.
        }

        setImportState("success");
        const base = `Synced ${json.imported ?? 0} games, ${json.queued ?? 0} queued for analysis.`;
        const throttleHint = (json.skippedQueue ?? 0) > 0
          ? ` Deferred ${(json.skippedQueue ?? 0)} games (queue limit ${json.analyzeLimit ?? 0}).`
          : "";
        const queueHint = json.queueUnavailable
          ? " Redis queue offline: games were stored but not all jobs were enqueued."
          : "";
        setImportMsg(`${base}${throttleHint}${queueHint}${totalsMsg}`);
      }
    } catch {
      setImportState("error");
      setImportMsg("Network error while syncing.");
    }
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

      {/* ── Accounts + sync section ── */}
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
              onClick={() => {
                setPlatform(p);
                setImportState("idle");
              }}
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

        <div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}>
          <input
            type="text"
            placeholder={platform === "lichess" ? "Lichess account" : "Chess.com account"}
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
            variant="secondary"
            size="sm"
            onClick={linkAccount}
            disabled={!accountInput.trim()}
          >
            Link
          </Button>
        </div>

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "6px" }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleImport(platform)}
            disabled={
              importState === "loading" ||
              !(getLinkedUsername(linkedAccounts, platform) || accountInput.trim())
            }
          >
            {importState === "loading" ? "…" : `Sync ${platform === "lichess" ? "Lichess" : "Chess.com"}`}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void (async () => {
                if (linkedAccounts.lichess) await handleImport("lichess");
                if (linkedAccounts.chessCom) await handleImport("chess.com");
              })();
            }}
            disabled={importState === "loading" || (!linkedAccounts.lichess && !linkedAccounts.chessCom)}
          >
            Sync Linked Accounts
          </Button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", color: "var(--text-muted)" }}>
          <span>Lichess: {linkedAccounts.lichess || "not linked"}</span>
          <span>Chess.com: {linkedAccounts.chessCom || "not linked"}</span>
        </div>

        {/* Status message */}
        {importMsg && (
          <div
            style={{
              marginTop: "6px",
              fontSize: "11px",
              color: importState === "error" ? "var(--red)" : "var(--green)",
              lineHeight: 1.4,
            }}
          >
            {importMsg}
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
