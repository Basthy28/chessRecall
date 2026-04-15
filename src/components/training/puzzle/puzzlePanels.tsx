"use client";

import type { Puzzle, PuzzleProgressStats, PuzzleTrainingMode } from "@/types";
import {
  formatDueLabel,
  getPuzzleStageMeta,
  MiniStatCard,
  type PuzzleStageMeta,
  StagePill,
  TrainingKindPill,
  TrainingModeSelector,
} from "@/components/training/puzzle/puzzleUi";

export function PuzzleHeaderBar({
  puzzle,
  phaseText,
  currentIndex,
  totalCount,
  sessionProgressPercent,
  isCompactLayout,
  isSolving,
  isWrong,
  isCorrect,
  showPlayedMove,
  playedInGameLabel,
  onTogglePlayedMove,
  onOpenAssociatedReview,
}: {
  puzzle: Puzzle;
  phaseText: string;
  currentIndex: number;
  totalCount: number;
  sessionProgressPercent: number;
  isCompactLayout: boolean;
  isSolving: boolean;
  isWrong: boolean;
  isCorrect: boolean;
  showPlayedMove: boolean;
  playedInGameLabel: string;
  onTogglePlayedMove: () => void;
  onOpenAssociatedReview?: () => void;
}) {
  return (
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
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "var(--text-primary)" }}>
          Move {puzzle.move_number}
        </span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: "9px",
              height: "9px",
              borderRadius: "50%",
              background: puzzle.player_color === "white" ? "#e8e6e2" : "#1a1a1a",
              border: "1.5px solid var(--border)",
              verticalAlign: "middle",
              marginRight: "4px",
            }}
          />
          You missed the strongest continuation as {puzzle.player_color}
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
          {phaseText}
        </span>
        <TrainingKindPill puzzle={puzzle} />
        {puzzle.is_brilliant && (
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
        {(puzzle.game_white_username || puzzle.game_black_username) && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <button
              type="button"
              onClick={onOpenAssociatedReview}
              disabled={!onOpenAssociatedReview}
              style={{
                padding: "2px 8px",
                borderRadius: "999px",
                border: "1px solid rgba(129,182,76,0.35)",
                background: "rgba(129,182,76,0.12)",
                color: "#81b64c",
                fontSize: "11px",
                fontWeight: 700,
                cursor: onOpenAssociatedReview ? "pointer" : "default",
                fontFamily: "inherit",
              }}
            >
              {puzzle.game_white_username ?? "?"} vs {puzzle.game_black_username ?? "?"}
            </button>
          </>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: isCompactLayout ? 0 : "220px", justifyContent: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", minWidth: isCompactLayout ? 0 : "140px" }}>
          <span style={{ fontSize: "12px", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
            Puzzle {currentIndex + 1} of {totalCount}
          </span>
          <div style={{ width: "100%", maxWidth: "160px", height: "6px", borderRadius: "999px", background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
            <div style={{ width: `${sessionProgressPercent}%`, height: "100%", background: "linear-gradient(90deg, #81b64c 0%, #c0a060 100%)", transition: "width 180ms ease" }} />
          </div>
        </div>
        {isSolving && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "4px 10px", borderRadius: "6px", background: "rgba(192,160,96,0.1)", border: "1px solid rgba(192,160,96,0.25)", fontSize: "12px", fontWeight: 600, color: "var(--accent)" }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {puzzle.is_brilliant ? "Find the brilliant move!!" : "Your turn"}
          </div>
        )}
        {isWrong && (
          <div style={{ padding: "4px 10px", borderRadius: "6px", background: "var(--red-dim)", border: "1px solid rgba(185,64,64,0.35)", fontSize: "12px", fontWeight: 600, color: "var(--red)" }}>
            Incorrect — try again
          </div>
        )}
        {isCorrect && (
          <div style={{ padding: "4px 10px", borderRadius: "6px", background: "var(--green-dim)", border: "1px solid rgba(134,166,102,0.35)", fontSize: "12px", fontWeight: 600, color: "var(--green)" }}>
            Correct!
          </div>
        )}
        {puzzle.blunder_move && (
          <button
            type="button"
            onClick={onTogglePlayedMove}
            style={{
              padding: "4px 10px",
              borderRadius: "6px",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.1)",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
            title={showPlayedMove ? `Played in game (UCI): ${puzzle.blunder_move}` : "Reveal the move that was played in the game"}
          >
            {showPlayedMove ? `Played in game: ${playedInGameLabel}` : "Reveal played move"}
          </button>
        )}
      </div>
    </div>
  );
}

export function PuzzleRouteList({
  puzzles,
  currentIndex,
  ratedIds,
  phaseLabel,
  onSelectIndex,
}: {
  puzzles: Puzzle[];
  currentIndex: number;
  ratedIds: Set<string>;
  phaseLabel: (phase: string) => string;
  onSelectIndex: (index: number) => void;
}) {
  return (
    <>
      <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid #3c3a38", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#8b8987" }}>
          Training Route — {puzzles.length} puzzle{puzzles.length === 1 ? "" : "s"}
        </span>
        <span style={{ fontSize: "11px", color: "#5a5856", fontVariantNumeric: "tabular-nums" }}>
          {puzzles.length - ratedIds.size} left
        </span>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {puzzles.map((puzzle, idx) => {
          const isDone = ratedIds.has(puzzle.id);
          const isCurrent = idx === currentIndex;
          const stage = getPuzzleStageMeta(puzzle);
          const dueLabel = formatDueLabel(puzzle.srs_due_at);
          return (
            <button
              key={puzzle.id}
              onClick={() => onSelectIndex(idx)}
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
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0, background: isDone ? "var(--green)" : isCurrent ? "var(--accent)" : "#5a5856" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0, marginBottom: "3px" }}>
                  <div style={{ fontSize: "12px", fontWeight: isCurrent ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    Move {puzzle.move_number}
                    {puzzle.is_brilliant && <span style={{ marginLeft: "5px", fontSize: "10px", color: "var(--accent)" }}>★</span>}
                  </div>
                  {!isDone && <StagePill stage={stage} compact />}
                </div>
                <div style={{ fontSize: "11px", color: "#8b8987", textTransform: "capitalize" }}>
                  {phaseLabel(puzzle.phase)} · {puzzle.player_color} · {puzzle.training_kind === "practice" ? "Practice" : "Strict"}
                  {puzzle.game_white_username && puzzle.game_black_username
                    ? ` · ${puzzle.game_white_username} vs ${puzzle.game_black_username}`
                    : ""}
                </div>
                {dueLabel && !isDone && (
                  <div style={{ fontSize: "10px", color: "#5a5856", marginTop: "3px" }}>
                    {dueLabel}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function PuzzleProgressSection({
  progressStats,
  trainingMode,
  onTrainingModeChange,
  sessionSolvedCount,
  sessionProgressPercent,
  routeSummary,
  currentStage,
  phaseTitle,
  currentReason,
  focusCards,
  compactModeSelector,
}: {
  progressStats: PuzzleProgressStats | null;
  trainingMode: PuzzleTrainingMode;
  onTrainingModeChange: (mode: PuzzleTrainingMode) => void;
  sessionSolvedCount: number;
  sessionProgressPercent: number;
  routeSummary: string;
  currentStage: PuzzleStageMeta;
  phaseTitle: string;
  currentReason: string;
  focusCards: Array<{ label: string; value: string | number }>;
  compactModeSelector?: boolean;
}) {
  if (!progressStats) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "14px", borderBottom: "1px solid #3c3a38" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ fontSize: "10px", color: "#8b8987", textTransform: "uppercase", letterSpacing: "0.08em" }}>Training Mode</div>
        <TrainingModeSelector mode={trainingMode} onChange={onTrainingModeChange} compact={compactModeSelector} />
      </div>

      <div
        style={{
          padding: "14px",
          borderRadius: "10px",
          border: "1px solid rgba(192,160,96,0.22)",
          background: "linear-gradient(135deg, rgba(192,160,96,0.12) 0%, rgba(255,255,255,0.03) 100%)",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <div>
            <div style={{ fontSize: "10px", color: "#a7a29a", textTransform: "uppercase", letterSpacing: "0.08em" }}>Today&apos;s Route</div>
            <div style={{ marginTop: "4px", fontSize: "17px", fontWeight: 800, color: "#fff" }}>
              {sessionSolvedCount} solved this session
            </div>
          </div>
          <StagePill stage={currentStage} compact />
        </div>
        <div style={{ height: "8px", borderRadius: "999px", background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
          <div style={{ width: `${sessionProgressPercent}%`, height: "100%", background: "linear-gradient(90deg, #81b64c 0%, #c0a060 100%)", transition: "width 180ms ease" }} />
        </div>
        <div style={{ fontSize: "12px", color: "#c9c6c1", lineHeight: 1.5 }}>
          {routeSummary}
        </div>
      </div>

      <div
        style={{
          padding: "14px",
          borderRadius: "10px",
          border: `1px solid ${currentStage.border}`,
          background: "linear-gradient(135deg, rgba(255,255,255,0.02) 0%, rgba(0,0,0,0.18) 100%)",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "10px", color: "#8b8987", textTransform: "uppercase", letterSpacing: "0.08em" }}>Current Focus</div>
            <div style={{ marginTop: "4px", fontSize: "17px", fontWeight: 800, color: "#fff" }}>
              {phaseTitle}
            </div>
          </div>
          <StagePill stage={currentStage} compact />
        </div>
        <div style={{ fontSize: "12px", color: "#c9c6c1", lineHeight: 1.5 }}>
          {currentReason}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "8px" }}>
          {focusCards.map((item) => (
            <MiniStatCard key={item.label} label={item.label} value={item.value} />
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
        {[
          { label: "Review Due", value: progressStats.due_now, title: "Positions ready to review right now, including unseen ones." },
          { label: "Mastered", value: progressStats.mastered },
          { label: "Clean Rate", value: `${Math.round(progressStats.accuracy * 100)}%`, title: "How often you solved without reveal or mistakes." },
          { label: "New", value: progressStats.unseen, title: "Never reviewed yet." },
          { label: "In Rotation", value: progressStats.learning, title: "Seen before and still actively cycling in SRS." },
          { label: "Library", value: progressStats.total, title: "Total puzzles stored for this account." },
        ].map((item) => (
          <MiniStatCard key={item.label} label={item.label} value={item.value} title={item.title} />
        ))}
      </div>
    </div>
  );
}
