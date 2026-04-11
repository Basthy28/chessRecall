"use client";

import { useState, useCallback } from "react";
import { createBrowserClient } from "@/lib/supabase";

interface AuthModalProps {
  onAuthSuccess: (userId: string) => void;
  onDismiss: () => void;
}

type Mode = "signin" | "signup";

export default function AuthModal({ onAuthSuccess, onDismiss }: AuthModalProps) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setInfo(null);

      if (!email.trim() || !password) {
        setError("Email and password are required.");
        return;
      }

      if (mode === "signup" && password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }

      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }

      setLoading(true);
      try {
        const supabase = createBrowserClient();

        if (mode === "signin") {
          const { data, error: authError } = await supabase.auth.signInWithPassword({
            email: email.trim(),
            password,
          });
          if (authError) {
            setError(authError.message);
            return;
          }
          if (data.user) {
            onAuthSuccess(data.user.id);
          }
        } else {
          setInfo("Sign up is coming soon. Please use Sign In for now.");
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "An unexpected error occurred.");
      } finally {
        setLoading(false);
      }
    },
    [mode, email, password, confirmPassword, onAuthSuccess]
  );

  return (
    /* Backdrop */
    <div
      role="dialog"
      aria-modal="true"
      aria-label={mode === "signin" ? "Sign in" : "Create account"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      {/* Modal card */}
      <div
        style={{
          background: "#262421",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "12px",
          padding: "32px",
          width: "100%",
          maxWidth: "400px",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h2
            style={{
              margin: 0,
              fontSize: "20px",
              fontWeight: 700,
              color: "#fff",
              letterSpacing: "-0.02em",
            }}
          >
            {mode === "signin" ? "Welcome back" : "Create account"}
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "rgba(255,255,255,0.5)" }}>
            {mode === "signin"
              ? "Sign in to access your games and puzzles."
              : "Sign up to save your progress across devices."}
          </p>
        </div>

        {/* Mode tabs */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "4px",
            background: "rgba(255,255,255,0.05)",
            borderRadius: "8px",
            padding: "4px",
          }}
        >
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={m === "signup"}
              onClick={() => {
                if (m === "signup") return;
                setMode(m);
                setError(null);
                setInfo(null);
              }}
              style={{
                padding: "7px 12px",
                borderRadius: "6px",
                border: "none",
                background: mode === m ? "#81b64c" : "transparent",
                color: m === "signup" ? "rgba(255,255,255,0.35)" : mode === m ? "#fff" : "rgba(255,255,255,0.5)",
                fontSize: "13px",
                fontWeight: mode === m ? 600 : 400,
                cursor: m === "signup" ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              {m === "signin" ? "Sign In" : "SOON"}
            </button>
          ))}
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          {/* Email */}
          <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Email
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete={mode === "signin" ? "email" : "email"}
              required
              style={inputStyle}
            />
          </label>

          {/* Password */}
          <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Password
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              style={inputStyle}
            />
          </label>

          {/* Confirm password (signup only) */}
          {mode === "signup" && (
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "rgba(255,255,255,0.6)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                Confirm Password
              </span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat password"
                autoComplete="new-password"
                required
                style={inputStyle}
              />
            </label>
          )}

          {/* Error / info */}
          {error && (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "7px",
                background: "rgba(185,64,64,0.15)",
                border: "1px solid rgba(185,64,64,0.35)",
                color: "#e57373",
                fontSize: "13px",
              }}
            >
              {error}
            </div>
          )}
          {info && (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "7px",
                background: "rgba(129,182,76,0.12)",
                border: "1px solid rgba(129,182,76,0.3)",
                color: "#81b64c",
                fontSize: "13px",
              }}
            >
              {info}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: "4px",
              padding: "10px 16px",
              borderRadius: "8px",
              border: "none",
              background: loading ? "rgba(129,182,76,0.5)" : "#81b64c",
              color: "#fff",
              fontSize: "14px",
              fontWeight: 700,
              cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              letterSpacing: "0.01em",
              transition: "background 0.15s",
            }}
          >
            {loading
              ? mode === "signin"
                ? "Signing in…"
                : "Creating account…"
              : mode === "signin"
              ? "Sign In"
              : "Create Account"}
          </button>
        </form>

        {/* Divider */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            color: "rgba(255,255,255,0.2)",
            fontSize: "12px",
          }}
        >
          <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.1)" }} />
          <span>or</span>
          <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.1)" }} />
        </div>

        {/* Continue as guest */}
        <button
          type="button"
          onClick={onDismiss}
          style={{
            padding: "9px 16px",
            borderRadius: "8px",
            border: "1px solid rgba(255,255,255,0.12)",
            background: "transparent",
            color: "rgba(255,255,255,0.55)",
            fontSize: "13px",
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: "inherit",
            transition: "border-color 0.15s, color 0.15s",
            textAlign: "center",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor =
              "rgba(255,255,255,0.25)";
            (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.8)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor =
              "rgba(255,255,255,0.12)";
            (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.55)";
          }}
        >
          Continue as guest
        </button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "7px",
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "#fff",
  fontSize: "14px",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
  transition: "border-color 0.15s",
};
