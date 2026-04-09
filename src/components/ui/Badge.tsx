import React from "react";

type BadgeVariant = "new" | "learning" | "review" | "due" | "opening" | "middlegame" | "endgame";

interface BadgeProps {
  variant: BadgeVariant;
  children?: React.ReactNode;
}

const badgeConfig: Record<BadgeVariant, { bg: string; color: string; label: string }> = {
  new: { bg: "rgba(123,158,189,0.15)", color: "#7b9ebd", label: "New" },
  learning: { bg: "rgba(192,160,96,0.15)", color: "var(--accent)", label: "Learning" },
  review: { bg: "rgba(134,166,102,0.15)", color: "var(--green)", label: "Review" },
  due: { bg: "rgba(185,64,64,0.15)", color: "var(--red)", label: "Due" },
  opening: { bg: "rgba(123,158,189,0.15)", color: "#7b9ebd", label: "Opening" },
  middlegame: { bg: "rgba(192,160,96,0.12)", color: "var(--accent)", label: "Middlegame" },
  endgame: { bg: "rgba(134,166,102,0.12)", color: "var(--green)", label: "Endgame" },
};

export default function Badge({ variant, children }: BadgeProps) {
  const cfg = badgeConfig[variant];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 7px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.04em",
        background: cfg.bg,
        color: cfg.color,
        border: `1px solid ${cfg.color}30`,
        textTransform: "uppercase",
        lineHeight: 1.5,
      }}
    >
      {children ?? cfg.label}
    </span>
  );
}
