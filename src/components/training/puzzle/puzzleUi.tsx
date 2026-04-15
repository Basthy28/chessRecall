"use client";

import type { Puzzle, PuzzleTrainingMode } from "@/types";

export type PuzzleStageMeta = {
  label: string;
  note: string;
  color: string;
  bg: string;
  border: string;
};

export type PuzzleTrainingKindMeta = {
  label: string;
  color: string;
  bg: string;
  border: string;
};

export function formatDueLabel(value: string | null): string | null {
  if (!value) return null;
  const diffMs = new Date(value).getTime() - Date.now();
  const absMs = Math.abs(diffMs);

  if (absMs < 15 * 60_000) return "Due now";

  const mins = Math.round(absMs / 60_000);
  if (mins < 60) return diffMs < 0 ? `${mins}m overdue` : `In ${mins}m`;

  const hours = Math.round(absMs / 3_600_000);
  if (hours < 24) return diffMs < 0 ? `${hours}h overdue` : `In ${hours}h`;

  const days = Math.round(absMs / 86_400_000);
  return diffMs < 0 ? `${days}d overdue` : `In ${days}d`;
}

export function getPuzzleStageMeta(puzzle: Puzzle): PuzzleStageMeta {
  const seen = puzzle.times_seen ?? 0;
  const correct = puzzle.times_correct ?? 0;
  const accuracy = seen > 0 ? correct / seen : 0;

  if (seen === 0) {
    return {
      label: "Fresh",
      note: "Brand-new motif from one of your games.",
      color: "#c0a060",
      bg: "rgba(192,160,96,0.12)",
      border: "rgba(192,160,96,0.3)",
    };
  }

  if (correct === 0 || accuracy < 0.35) {
    return {
      label: "Repair",
      note: "Still not stable. Clean execution matters here.",
      color: "#f6b43d",
      bg: "rgba(246,180,61,0.14)",
      border: "rgba(246,180,61,0.32)",
    };
  }

  if (seen < 3 || accuracy < 0.75) {
    return {
      label: "Learning",
      note: "The idea is there, but it still needs repetition.",
      color: "#81b64c",
      bg: "rgba(129,182,76,0.13)",
      border: "rgba(129,182,76,0.3)",
    };
  }

  if (puzzle.srs_ease >= 2.7 && accuracy >= 0.85 && correct >= 3) {
    return {
      label: "Mastery",
      note: "Long-term retention check. Keep it clean.",
      color: "#4a9e8e",
      bg: "rgba(74,158,142,0.15)",
      border: "rgba(74,158,142,0.32)",
    };
  }

  return {
    label: "Reinforce",
    note: "Known pattern, back now to make it stick.",
    color: "#5c8bb0",
    bg: "rgba(92,139,176,0.15)",
    border: "rgba(92,139,176,0.32)",
  };
}

export function getPuzzleTrainingKindMeta(puzzle: Puzzle): PuzzleTrainingKindMeta {
  if (puzzle.training_kind === "practice") {
    return {
      label: "Practice",
      color: "#7fb7d6",
      bg: "rgba(127,183,214,0.14)",
      border: "rgba(127,183,214,0.32)",
    };
  }

  return {
    label: "Strict",
    color: "#c0a060",
    bg: "rgba(192,160,96,0.12)",
    border: "rgba(192,160,96,0.3)",
  };
}

export function getPuzzleReason(puzzle: Puzzle, stage: PuzzleStageMeta): string {
  if (puzzle.training_kind === "practice" && puzzle.times_seen === 0) {
    return "Practical correction from one of your games.";
  }
  if (puzzle.times_seen === 0) return "Fresh extraction from one of your games.";
  if (puzzle.times_correct === 0) return "You still have not solved this motif cleanly.";

  const gap = puzzle.eval_second_best === null ? null : Math.abs(puzzle.eval_best - puzzle.eval_second_best);
  if (gap !== null && gap >= 120) return "This is close to an only-move decision, so precision matters.";

  if (puzzle.srs_due_at && new Date(puzzle.srs_due_at).getTime() <= Date.now()) {
    return "Its review window expired, so it is back now before the idea fades.";
  }

  return stage.note;
}

export function MiniStatCard({
  label,
  value,
  title,
}: {
  label: string;
  value: string | number;
  title?: string;
}) {
  return (
    <div
      title={title}
      style={{
        padding: "10px 8px",
        background: "#1a1917",
        border: "1px solid #3c3a38",
        borderRadius: "8px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "10px", color: "#8b8987", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ marginTop: "4px", fontSize: "15px", fontWeight: 800, color: "#fff", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

export function StagePill({ stage, compact = false }: { stage: PuzzleStageMeta; compact?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: compact ? "1px 6px" : "3px 8px",
        borderRadius: "999px",
        background: stage.bg,
        border: `1px solid ${stage.border}`,
        color: stage.color,
        fontSize: compact ? "10px" : "11px",
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {stage.label}
    </span>
  );
}

export function TrainingKindPill({ puzzle, compact = false }: { puzzle: Puzzle; compact?: boolean }) {
  const meta = getPuzzleTrainingKindMeta(puzzle);
  return (
    <span
      title={puzzle.training_kind === "practice" ? "Lila-style practical correction from your game" : "Strict tactical puzzle extracted from your game"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: compact ? "1px 6px" : "3px 8px",
        borderRadius: "999px",
        background: meta.bg,
        border: `1px solid ${meta.border}`,
        color: meta.color,
        fontSize: compact ? "10px" : "11px",
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

export const TRAINING_MODE_OPTIONS: Array<{
  key: PuzzleTrainingMode;
  label: string;
  description: string;
}> = [
  { key: "mixed", label: "Mixed", description: "Balanced route: due first, then weak spots, then fresh puzzles." },
  { key: "review", label: "Review", description: "Only positions that are due for spaced repetition now." },
  { key: "new", label: "New", description: "Fresh positions you have never trained before." },
  { key: "weak", label: "Weak Spots", description: "Previously seen positions that still look shaky." },
];

export function TrainingModeSelector({
  mode,
  onChange,
  compact = false,
}: {
  mode: PuzzleTrainingMode;
  onChange: (mode: PuzzleTrainingMode) => void;
  compact?: boolean;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: "6px" }}>
      {TRAINING_MODE_OPTIONS.map((option) => {
        const active = option.key === mode;
        return (
          <button
            key={option.key}
            type="button"
            title={option.description}
            onClick={() => onChange(option.key)}
            style={{
              padding: compact ? "8px 10px" : "7px 10px",
              borderRadius: "8px",
              border: active ? "1px solid rgba(192,160,96,0.35)" : "1px solid #3c3a38",
              background: active ? "rgba(192,160,96,0.12)" : "#1a1917",
              color: active ? "#f0d892" : "#a7a29a",
              fontSize: compact ? "12px" : "11px",
              fontWeight: active ? 700 : 600,
              cursor: "pointer",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
