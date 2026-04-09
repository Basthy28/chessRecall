import React from "react";

interface StatPillProps {
  label: string;
  value: string | number;
  accent?: "default" | "green" | "red" | "gold";
}

const accentColor: Record<string, string> = {
  default: "var(--text-muted)",
  green: "var(--green)",
  red: "var(--red)",
  gold: "var(--accent)",
};

export default function StatPill({ label, value, accent = "default" }: StatPillProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "6px 12px",
        borderRadius: "8px",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        minWidth: "60px",
        gap: "1px",
      }}
    >
      <span
        style={{
          fontSize: "16px",
          fontWeight: 700,
          lineHeight: 1.2,
          color: accentColor[accent],
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: "10px",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 500,
        }}
      >
        {label}
      </span>
    </div>
  );
}
