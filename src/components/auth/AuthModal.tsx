"use client";

import { useCallback, useEffect, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";

export type AuthModalMode = "signin" | "signup" | "forgot" | "reset";

interface AuthModalProps {
  onAuthSuccess: (userId: string) => void;
  onDismiss: () => void;
  initialMode?: AuthModalMode;
}

export default function AuthModal({
  onAuthSuccess,
  onDismiss,
  initialMode = "signin",
}: AuthModalProps) {
  const [mode, setMode] = useState<AuthModalMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setMode(initialMode);
    setError(null);
    setInfo(null);
    setPassword("");
    setConfirmPassword("");
  }, [initialMode]);

  const switchMode = useCallback((nextMode: AuthModalMode) => {
    setMode(nextMode);
    setError(null);
    setInfo(null);
    setPassword("");
    setConfirmPassword("");
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setInfo(null);

      const normalizedEmail = email.trim();
      const requiresEmail = mode !== "reset";
      const requiresPassword = mode !== "forgot";
      const requiresConfirmation = mode === "reset";

      if (requiresEmail && !normalizedEmail) {
        setError("Email is required.");
        return;
      }

      if (requiresPassword && !password) {
        setError("Password is required.");
        return;
      }

      if (requiresPassword && password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }

      if (requiresConfirmation && password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }

      setLoading(true);
      try {
        const supabase = createBrowserClient();

        if (mode === "signin") {
          const { data, error: authError } = await supabase.auth.signInWithPassword({
            email: normalizedEmail,
            password,
          });
          if (authError) {
            setError(authError.message);
            return;
          }
          if (data.user) {
            onAuthSuccess(data.user.id);
          }
          return;
        }

        if (mode === "signup") {
          setInfo("Sign up is coming soon. Accounts are being created manually for now.");
          switchMode("signin");
          return;
        }

        if (mode === "forgot") {
          const redirectTo =
            typeof window !== "undefined" ? `${window.location.origin}/` : undefined;
          const { error: resetError } = await supabase.auth.resetPasswordForEmail(
            normalizedEmail,
            { redirectTo }
          );
          if (resetError) {
            setError(resetError.message);
            return;
          }
          setInfo("If that email exists, we sent a password recovery link.");
          return;
        }

        const { data, error: updateError } = await supabase.auth.updateUser({ password });
        if (updateError) {
          setError(updateError.message);
          return;
        }
        setInfo("Password updated successfully.");
        if (data.user) {
          onAuthSuccess(data.user.id);
        } else {
          switchMode("signin");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "An unexpected error occurred.");
      } finally {
        setLoading(false);
      }
    },
    [mode, email, password, confirmPassword, onAuthSuccess, switchMode]
  );

  const title =
    mode === "signin"
      ? "Welcome back"
      : mode === "signup"
      ? "Create account"
      : mode === "forgot"
      ? "Recover password"
      : "Set a new password";
  const subtitle =
    mode === "signin"
      ? "Sign in to access your games and puzzles."
      : mode === "signup"
      ? "Account creation is disabled here for now."
      : mode === "forgot"
      ? "We'll email you a secure link to reset your password."
      : "Choose a new password for your account.";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
            {title}
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "rgba(255,255,255,0.5)" }}>
            {subtitle}
          </p>
        </div>

        {mode !== "reset" && (
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
            {(["signin", "signup"] as const).map((tabMode) => (
              <button
                key={tabMode}
                type="button"
                disabled={tabMode === "signup"}
                onClick={() => {
                  if (tabMode === "signup") return;
                  switchMode(tabMode);
                }}
                style={{
                  padding: "7px 12px",
                  borderRadius: "6px",
                  border: "none",
                  background: mode === tabMode ? "#81b64c" : "transparent",
                  color:
                    tabMode === "signup"
                      ? "rgba(255,255,255,0.3)"
                      : mode === tabMode
                      ? "#fff"
                      : "rgba(255,255,255,0.5)",
                  fontSize: "13px",
                  fontWeight: mode === tabMode ? 600 : 400,
                  cursor: tabMode === "signup" ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  transition: "background 0.15s, color 0.15s",
                }}
              >
                {tabMode === "signin" ? "Sign In" : "SOON"}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          {mode !== "reset" && (
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={labelStyle}>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
                style={inputStyle}
              />
            </label>
          )}

          {mode !== "forgot" && (
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={labelStyle}>
                {mode === "reset" ? "New Password" : "Password"}
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  mode === "reset"
                    ? "At least 6 characters"
                    : "Your password"
                }
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                required
                style={inputStyle}
              />
            </label>
          )}

          {mode === "reset" && (
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={labelStyle}>Confirm Password</span>
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

          {mode === "signin" && (
            <button
              type="button"
              onClick={() => switchMode("forgot")}
              style={linkButtonStyle}
            >
              Forgot password?
            </button>
          )}

          {mode === "forgot" && (
            <button
              type="button"
              onClick={() => switchMode("signin")}
              style={linkButtonStyle}
            >
              Back to sign in
            </button>
          )}

          {error && (
            <div style={errorStyle}>
              {error}
            </div>
          )}
          {info && (
            <div style={infoStyle}>
              {info}
            </div>
          )}

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
                : mode === "signup"
                ? "Coming soon…"
                : mode === "forgot"
                ? "Sending link…"
                : "Updating password…"
              : mode === "signin"
              ? "Sign In"
              : mode === "signup"
              ? "Coming Soon"
              : mode === "forgot"
              ? "Send Recovery Link"
              : "Update Password"}
          </button>
        </form>

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

const labelStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "rgba(255,255,255,0.6)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

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

const linkButtonStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: 0,
  border: "none",
  background: "transparent",
  color: "#81b64c",
  fontSize: "12px",
  cursor: "pointer",
  fontFamily: "inherit",
};

const errorStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: "7px",
  background: "rgba(185,64,64,0.15)",
  border: "1px solid rgba(185,64,64,0.35)",
  color: "#e57373",
  fontSize: "13px",
};

const infoStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: "7px",
  background: "rgba(129,182,76,0.12)",
  border: "1px solid rgba(129,182,76,0.3)",
  color: "#81b64c",
  fontSize: "13px",
};
