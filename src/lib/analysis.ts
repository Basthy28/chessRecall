export type MoveClassification =
  | "blunder"
  | "mistake"
  | "inaccuracy"
  | "good"
  | "excellent"
  | "best"
  | "great"
  | "brilliant"
  | "book"
  | "miss"
  | "none";

// ─────────────────────────────────────────────────────────────────────────────
// Win-probability formula — matches Lichess source exactly:
//   ui/lib/src/ceval/winningChances.ts :: rawWinningChances
//
// Maps cp (side-to-move perspective, clamped to [-1000, 1000]) to
// a winning-chances value in the range (-1 … +1):
//   cp = 0    → 0.00 (equal)
//   cp = +800 → ~0.89 (clearly winning)
//   cp = -800 → ~-0.89 (clearly losing)
//
// To get a win-probability in [0, 1]: (rawChances + 1) / 2
// ─────────────────────────────────────────────────────────────────────────────
const MULTIPLIER = -0.00368208;

function rawWinningChances(cp: number): number {
  return 2 / (1 + Math.exp(MULTIPLIER * cp)) - 1;
}

function cpWinningChances(cp: number): number {
  return rawWinningChances(Math.min(Math.max(-1000, cp), 1000));
}

/** Lichess mate evaluation: smooth curve instead of ±Infinity */
function mateWinningChances(mate: number): number {
  const cp = (21 - Math.min(10, Math.abs(mate))) * 100;
  return rawWinningChances(cp * (mate > 0 ? 1 : -1));
}

/** Returns winning chances in (-1, +1) for a given score (white's POV) */
export function evalWinningChances(score: number, isMate = false): number {
  if (isMate) return mateWinningChances(score);
  return cpWinningChances(score);
}

/**
 * Lichess `povDiff` — difference in winning chances from a player's POV.
 * Matches: `(povChances(color, bestEval) - povChances(color, playedEval)) / 2`
 *
 * Returns a value in (-1, +1); positive = player did worse than best move.
 *
 * @param bestScore  Engine's best-move eval (white's POV, centipawns)
 * @param playedScore  Eval after the played move (white's POV, centipawns)
 * @param turn  The color of the player who moved
 */
export function povDiff(
  bestScore: number,
  playedScore: number,
  turn: "w" | "b"
): number {
  const wBest = cpWinningChances(bestScore);
  const wPlayed = cpWinningChances(playedScore);
  // toPov: flip sign for black
  const povBest = turn === "w" ? wBest : -wBest;
  const povPlayed = turn === "w" ? wPlayed : -wPlayed;
  return (povBest - povPlayed) / 2;
}

/**
 * Classify a single move.
 *
 * NOTE: prevScore and currentScore are BOTH from White's perspective (absolute).
 * The function internally converts to the player's POV.
 *
 * Thresholds from Lichess Advice.scala (winning-probability drop after /2):
 *   ≥ 0.3  → blunder
 *   ≥ 0.2  → mistake
 *   ≥ 0.1  → inaccuracy
 *   ≥ 0.05 → good  (acceptable)
 *   ≥ 0.02 → excellent
 *   else   → best
 */
export function classifyMove(
  prevScore: number,   // eval BEFORE move (white POV, cp)
  currentScore: number, // eval AFTER  move (white POV, cp)
  turnBefore: "w" | "b"
): MoveClassification {
  const isMateScore = (s: number) => Math.abs(s) >= 90_000;

  // Mate-to-mate: no change in outcome → classify as "none"
  if (isMateScore(prevScore) && isMateScore(currentScore)) {
    if (prevScore > 0 === currentScore > 0) return "none"; // same-side mate
    // Switched from winning-mate to losing-mate → treat as very large drop (blunder)
  }

  // Missed forced mate: had forced win, lost it
  if (isMateScore(prevScore) && !isMateScore(currentScore)) {
    const hadMateForPlayer =
      (turnBefore === "w" && prevScore > 0) ||
      (turnBefore === "b" && prevScore < 0);
    if (hadMateForPlayer) return "miss";
  }

  const diff = povDiff(prevScore, currentScore, turnBefore);

  if (diff >= 0.3) return "blunder";
  if (diff >= 0.2) return "mistake";
  if (diff >= 0.1) return "inaccuracy";
  if (diff >= 0.05) return "good";
  if (diff >= 0.02) return "excellent";
  return "best";
}

/** Legacy shim — kept for any callers that still use the old 0-100 scale */
export function calculateWinProbability(cp: number): number {
  return (cpWinningChances(cp) + 1) / 2 * 100;
}
