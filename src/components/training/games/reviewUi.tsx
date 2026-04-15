"use client";

import { useEffect, useState } from "react";
import { evalWinningChances } from "@/lib/analysis";

type ReviewGameStatus = "pending" | "processing" | "analyzed" | "failed";

export function statusColor(status: ReviewGameStatus): string {
  if (status === "analyzed") return "var(--green)";
  if (status === "processing") return "var(--blue)";
  if (status === "failed") return "var(--red)";
  return "var(--orange)";
}

export function formatEval(score: number): string {
  if (Math.abs(score) >= 99_990) {
    const mateIn = 100_000 - Math.abs(score);
    return `${score > 0 ? "+" : "-"}M${mateIn}`;
  }
  if (score === 0) return "0.0";
  const pawns = score / 100;
  return pawns > 0 ? `+${pawns.toFixed(2)}` : pawns.toFixed(2);
}

export function parseInitialClockSeconds(timeControl: string | null | undefined): number | null {
  if (!timeControl) return null;
  const match = timeControl.match(/^(\d+)(?:\+\d+)?$/);
  if (!match) return null;
  const seconds = Number.parseInt(match[1], 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function formatClock(totalSeconds: number | null): string {
  if (totalSeconds === null) return "--:--";
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const CLASSIFICATION_COLOR: Record<string, string> = {
  brilliant: "#1baca6",
  great: "#5c8fe0",
  best: "#81b64c",
  excellent: "#96bc4b",
  good: "#5cb85c",
  inaccuracy: "#e8b84b",
  mistake: "#e8802a",
  blunder: "#f05149",
  miss: "#f05149",
  book: "#b09f87",
};

const CLASSIFICATION_SYMBOL: Record<string, string> = {
  brilliant: "!!",
  great: "!",
  best: "★",
  excellent: "✦",
  good: "✓",
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
  book: "♟",
};

export function ClassificationIcon({ cls, size = 20 }: { cls: string; size?: number }) {
  const color = CLASSIFICATION_COLOR[cls] ?? "#888";
  const symbol = CLASSIFICATION_SYMBOL[cls] ?? "•";
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ fontSize: size * 0.42, fontWeight: 900, color: "#fff", lineHeight: 1, letterSpacing: "-0.02em", fontFamily: "monospace" }}>
        {symbol}
      </span>
    </div>
  );
}

const AVATAR_PALETTE = ["#5c8fe0", "#81b64c", "#e8802a", "#1baca6", "#e8b84b", "#a56de2", "#f05149"];

function playerAvatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

const avatarCache = new Map<string, string | null>();

async function fetchAvatarUrl(username: string): Promise<string | null> {
  const key = username.toLowerCase();
  if (avatarCache.has(key)) return avatarCache.get(key)!;
  avatarCache.set(key, null);
  return null;
}

export function PlayerAvatar({
  name,
  size = 22,
}: {
  name: string;
  size?: number;
  platform?: "lichess" | "chess.com" | "all";
}) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAvatarUrl(name).then((url) => {
      if (!cancelled) setPhotoUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const bg = playerAvatarColor(name);
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: bg, flexShrink: 0, overflow: "hidden", border: "2px solid rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
      ) : (
        <span style={{ fontWeight: 700, fontSize: size * 0.42, color: "#fff", textTransform: "uppercase", lineHeight: 1 }}>
          {name.slice(0, 1)}
        </span>
      )}
    </div>
  );
}

function evalBarWhiteRatio(score: number): number {
  if (Math.abs(score) >= 99_000) return score > 0 ? 1 : 0;
  const clamped = Math.max(-800, Math.min(800, score));
  return (clamped + 800) / 1600;
}

export function EvalBar({
  score,
  orientation,
  gameResult,
}: {
  score: number;
  orientation: "white" | "black";
  gameResult?: string | null;
}) {
  const displayScore = gameResult === "1-0" ? 99999 : gameResult === "0-1" ? -99999 : gameResult === "½-½" ? 0 : score;
  const whiteRatio = evalBarWhiteRatio(displayScore);
  const blackRatio = 1 - whiteRatio;
  const isWhiteWinning = displayScore >= 0;
  const labelColor = isWhiteWinning ? "#111" : "#fff";
  const whiteOnTop = orientation === "black";
  const topRatio = whiteOnTop ? whiteRatio : blackRatio;
  const topBg = whiteOnTop ? "#fff" : "#333";
  const bottomRatio = whiteOnTop ? blackRatio : whiteRatio;
  const bottomBg = whiteOnTop ? "#333" : "#fff";
  const labelOnTop = isWhiteWinning ? whiteOnTop : !whiteOnTop;

  return (
    <div style={{ width: "30px", height: "100%", minHeight: "240px", borderTopLeftRadius: "4px", borderBottomLeftRadius: "4px", overflow: "hidden", border: "none", background: "#333", display: "flex", flexDirection: "column", flexShrink: 0, position: "relative" }}>
      <div style={{ flex: topRatio, background: topBg, width: "100%", transition: "flex 0.5s ease-in-out" }} />
      <div style={{ flex: bottomRatio, background: bottomBg, width: "100%", transition: "flex 0.5s ease-in-out" }} />
      <div style={{ position: "absolute", top: labelOnTop ? "4px" : "auto", bottom: labelOnTop ? "auto" : "4px", left: 0, right: 0, textAlign: "center", fontSize: "10px", fontWeight: 700, color: labelColor, lineHeight: 1, padding: "0 2px", whiteSpace: "nowrap" }}>
        {gameResult ?? formatEval(score)}
      </div>
    </div>
  );
}

export function PlayerChip({
  player,
  viewerColor,
}: {
  player: { color: "white" | "black"; name: string; rating: number | null; clock: string };
  viewerColor: "white" | "black" | null;
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "6px 10px", borderRadius: "999px", background: "rgba(24,22,20,0.82)", border: "1px solid rgba(255,255,255,0.14)", color: "#fff", fontSize: "12px", fontWeight: 800, backdropFilter: "blur(6px)", maxWidth: "100%", pointerEvents: "auto" }}>
      <PlayerAvatar name={player.name} size={22} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        {player.name}
        {typeof player.rating === "number" ? ` (${player.rating})` : ""}
      </span>
      <span style={{ marginLeft: "2px", padding: "1px 7px", borderRadius: "999px", border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.22)", color: "#ddd", fontSize: "11px", fontWeight: 800, flexShrink: 0 }}>
        {player.clock}
      </span>
      {viewerColor === player.color && (
        <span style={{ padding: "1px 7px", borderRadius: "999px", background: "rgba(129,182,76,0.26)", border: "1px solid rgba(129,182,76,0.6)", fontSize: "10px", fontWeight: 900, flexShrink: 0 }}>
          You
        </span>
      )}
    </div>
  );
}

export function EvalGraph({
  positionEvals,
  moves,
  currentIndex,
  onSeek,
}: {
  positionEvals: (number | null)[];
  moves: Array<{ classification: string; ply: number }>;
  currentIndex: number;
  onSeek: (index: number) => void;
}) {
  const W = 400;
  const H = 72;
  const midY = H / 2;
  const n = positionEvals.length;
  if (n < 2) return null;

  function evalToY(ev: number | null): number {
    if (ev === null) return midY;
    if (Math.abs(ev) >= 99_000) return ev > 0 ? 2 : H - 2;
    const chance = (evalWinningChances(ev) + 1) / 2;
    return H - chance * H;
  }

  const xs = positionEvals.map((_, i) => (i / (n - 1)) * W);
  const ys = positionEvals.map(evalToY);
  const pts = ys.map((y, i) => `${xs[i].toFixed(1)},${y.toFixed(1)}`).join(" ");
  const whitePolyPts = `0,0 ${pts} ${W},0`;
  const blackPolyPts = `0,${H} ${pts} ${W},${H}`;
  const cursorX = (currentIndex / (n - 1)) * W;
  const dotClasses = new Set(["brilliant", "great", "blunder", "mistake", "inaccuracy"]);
  const dotsByPos = new Map<number, string>();
  for (const move of moves) {
    if (dotClasses.has(move.classification)) dotsByPos.set(move.ply, move.classification);
  }

  function handleClick(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(relX * (n - 1));
    onSeek(Math.max(0, Math.min(n - 1, idx)));
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} onClick={handleClick} style={{ cursor: "crosshair", display: "block", userSelect: "none" }} preserveAspectRatio="none">
      <rect x="0" y="0" width={W} height={H} fill="#1a1816" />
      <polygon points={whitePolyPts} fill="rgba(220,200,170,0.14)" />
      <polygon points={blackPolyPts} fill="rgba(0,0,0,0.3)" />
      <line x1="0" y1={midY} x2={W} y2={midY} stroke="#444" strokeWidth="0.6" />
      <polyline points={pts} fill="none" stroke="#777" strokeWidth="1.2" strokeLinejoin="round" />
      {Array.from(dotsByPos.entries()).map(([posIdx, cls]) => {
        if (posIdx >= n) return null;
        return <circle key={posIdx} cx={xs[posIdx].toFixed(1)} cy={ys[posIdx].toFixed(1)} r="3.5" fill={CLASSIFICATION_COLOR[cls] ?? "#888"} stroke="#1a1816" strokeWidth="1" />;
      })}
      <line x1={cursorX.toFixed(1)} y1="0" x2={cursorX.toFixed(1)} y2={H} stroke="rgba(255,255,255,0.55)" strokeWidth="1" strokeDasharray="3,2" />
    </svg>
  );
}
