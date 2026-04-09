"use client";

import React from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: "var(--accent)",
    color: "#1a1510",
    border: "1px solid var(--accent)",
    fontWeight: 600,
  },
  secondary: {
    background: "var(--bg-elevated)",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
  },
  danger: {
    background: "rgba(185,64,64,0.15)",
    color: "var(--red)",
    border: "1px solid rgba(185,64,64,0.3)",
  },
  ghost: {
    background: "transparent",
    color: "var(--text-muted)",
    border: "1px solid transparent",
  },
};

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: "4px 10px", fontSize: "12px", borderRadius: "5px" },
  md: { padding: "7px 14px", fontSize: "13px", borderRadius: "6px" },
  lg: { padding: "10px 20px", fontSize: "14px", borderRadius: "7px" },
};

export default function Button({
  variant = "secondary",
  size = "md",
  children,
  style,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        cursor: "pointer",
        fontFamily: "inherit",
        lineHeight: 1.4,
        transition: "opacity 0.15s, filter 0.15s",
        letterSpacing: "0.01em",
        ...variantStyles[variant],
        ...sizeStyles[size],
        ...style,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.filter = "brightness(1.12)";
        props.onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.filter = "brightness(1)";
        props.onMouseLeave?.(e);
      }}
    >
      {children}
    </button>
  );
}
