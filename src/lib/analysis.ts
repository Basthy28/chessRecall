import { Chess } from "chess.js";
import type { Square } from "chess.js";

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
// Win-probability formula — matches WintrChess / Lichess source exactly.
// gradient = 0.0035 (WintrChess uses 0.0035, Lichess uses 0.00368208 — we
// follow WintrChess for consistency with their classification thresholds).
// ─────────────────────────────────────────────────────────────────────────────

/** Returns winning chances in [0, 1] for a given white-POV centipawn score. */
export function getExpectedPoints(cp: number): number {
  if (Math.abs(cp) >= 90_000) return cp > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-0.0035 * cp));
}

/**
 * Expected point loss for a move, from the moving player's perspective.
 * Both scores are white's POV centipawns. Returns a value in [0, 1].
 */
export function getExpectedPointsLoss(
  prevScore: number,
  currScore: number,
  turnBefore: "w" | "b",
): number {
  const winBefore = getExpectedPoints(prevScore);
  const winAfter  = getExpectedPoints(currScore);
  if (turnBefore === "w") return Math.max(0, winBefore - winAfter);
  return Math.max(0, winAfter - winBefore);
}

/** Returns winning chances in (-1, +1) for use in the eval graph. */
export function evalWinningChances(score: number): number {
  if (Math.abs(score) >= 90_000) return score > 0 ? 1 : -1;
  return 2 * getExpectedPoints(score) - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sacrifice detection
// ─────────────────────────────────────────────────────────────────────────────

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 99 };

/**
 * Returns true when the move constitutes a material sacrifice:
 *  - Not a promotion
 *  - After the move the piece is under attack
 *  - Net material given up (piece value > captured piece value)
 *  - At least one attacker has lower or equal piece value (true threat)
 */
export function isSacrificeMove(fenBefore: string, uciMove: string): boolean {
  try {
    if (uciMove.length > 4) return false; // no promotions
    const chess = new Chess(fenBefore);
    const from = uciMove.slice(0, 2) as Square;
    const to   = uciMove.slice(2, 4) as Square;

    const movingPiece = chess.get(from);
    if (!movingPiece || movingPiece.type === "p" || movingPiece.type === "k") return false;

    const capturedPiece  = chess.get(to);
    const movingValue    = PIECE_VALUES[movingPiece.type] ?? 0;
    const capturedValue  = capturedPiece ? (PIECE_VALUES[capturedPiece.type] ?? 0) : 0;

    // Only a sacrifice if we give up more material than we capture
    if (movingValue <= capturedValue) return false;

    chess.move({ from, to });
    const after = new Chess(chess.fen());
    const opponentColor = movingPiece.color === "w" ? "b" : "w";
    const attackers = after.attackers(to, opponentColor);

    if (attackers.length === 0) return false;

    // At least one attacker of equal or lower value (a real threat)
    return attackers.some(sq => {
      const attacker = after.get(sq as Square);
      return attacker && (PIECE_VALUES[attacker.type] ?? 99) <= movingValue;
    });
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Move classification — WintrChess exact algorithm
// Source: wintrchess/shared/src/lib/reporter/classification/
// ─────────────────────────────────────────────────────────────────────────────

const MATE_THRESHOLD = 90_000;

function isMate(score: number): boolean {
  return Math.abs(score) >= MATE_THRESHOLD;
}

/**
 * Classify a single move.
 *
 * @param prevScore      White-POV eval BEFORE the move (cp or mate-encoded)
 * @param currentScore   White-POV eval AFTER the move
 * @param turnBefore     Who made the move
 * @param isSacrifice    Whether the move sacrifices material (see isSacrificeMove)
 * @param legalMoveCount Legal moves available before this move; ≤1 → forced
 */
export function classifyMove(
  prevScore: number,
  currentScore: number,
  turnBefore: "w" | "b",
  isSacrifice = false,
  legalMoveCount?: number,
): MoveClassification {
  // Forced move (only one legal option) — classify as best regardless of eval
  if (legalMoveCount !== undefined && legalMoveCount <= 1) return "best";

  const sign          = turnBefore === "w" ? 1 : -1;
  const prevWinning   = prevScore    * sign > 0;
  const currWinning   = currentScore * sign > 0;
  const prevMate      = isMate(prevScore);
  const currMate      = isMate(currentScore);

  // ── Mate → Mate ────────────────────────────────────────────────────────────
  if (prevMate && currMate) {
    // Was mating, now being mated — catastrophic
    if (prevWinning && !currWinning) {
      const mateIn = 100_000 - Math.abs(currentScore);
      return mateIn > 3 ? "mistake" : "blunder";
    }
    // Measure mate distance change (negative = improved, positive = worsened)
    const mateLoss = (prevScore - currentScore) * sign;
    if (mateLoss < 0) return "best";
    if (mateLoss < 2) return "excellent";
    if (mateLoss < 7) return "good";
    return "inaccuracy";
  }

  // ── Mate → Centipawn (had a forced mate, played a non-mate move) ───────────
  if (prevMate && !currMate) {
    const currSubjective = currentScore * sign;
    if (prevWinning) {
      // Missed the win
      if (currSubjective >= 800) return "excellent";
      if (currSubjective >= 400) return "good";
      if (currSubjective >= 200) return "inaccuracy";
      if (currSubjective >= 0)   return "mistake";
      return "blunder";
    }
    // Was losing to mate, escaped to centipawn eval — excellent escape
    return currSubjective >= 0 ? "best" : "excellent";
  }

  // ── Centipawn → Mate (found or walked into a mate) ────────────────────────
  if (!prevMate && currMate) {
    if (currWinning) return "best"; // found a winning mate
    const mateIn = 100_000 - Math.abs(currentScore);
    if (mateIn <= 2) return "blunder";
    if (mateIn <= 5) return "mistake";
    return "inaccuracy";
  }

  // ── Centipawn → Centipawn (standard case) ─────────────────────────────────
  const pointLoss = getExpectedPointsLoss(prevScore, currentScore, turnBefore);

  let base: MoveClassification;
  if      (pointLoss < 0.01)  base = "best";
  else if (pointLoss < 0.045) base = "excellent";
  else if (pointLoss < 0.08)  base = "good";
  else if (pointLoss < 0.12)  base = "inaccuracy";
  else if (pointLoss < 0.22)  base = "mistake";
  else                         base = "blunder";

  // Brilliant: best/excellent AND a genuine material sacrifice
  if (isSacrifice && (base === "best" || base === "excellent")) return "brilliant";

  return base;
}

/** Legacy shim */
export function calculateWinProbability(cp: number): number {
  return getExpectedPoints(cp) * 100;
}
