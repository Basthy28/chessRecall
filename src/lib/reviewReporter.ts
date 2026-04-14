import { Chess, KING, KNIGHT, PAWN, QUEEN, ROOK } from "chess.js";
import type { Color, Move, PieceSymbol, Square } from "chess.js";

import { classifyMove, getExpectedPointsLoss } from "@/lib/analysis";
import { isBookPosition } from "@/lib/ecoBook";
import type { MoveClassification } from "@/lib/analysis";

const MATE_THRESHOLD = 90_000;
const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 99,
};

interface BoardPiece {
  square: Square;
  type: PieceSymbol;
  color: Color;
}

interface RawMove {
  piece: PieceSymbol;
  color: Color;
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
}

export interface PositionEvaluationSnapshot {
  fen: string;
  score: number | null;
  depth: number;
  topMove?: string;
  secondScore?: number;
}

export interface ReviewedMoveInput {
  parentFen: string;
  currentFen: string;
  playedUci: string;
  previous: PositionEvaluationSnapshot;
  current: PositionEvaluationSnapshot;
  includeTheory?: boolean;
}

function flipColor(color: Color): Color {
  return color === "w" ? "b" : "w";
}

function setFenTurn(fen: string, color: Color): string {
  const parts = fen.split(" ");
  if (parts.length < 2) return fen;
  parts[1] = color;
  return parts.join(" ");
}

function getCaptureSquare(move: Move): Square {
  if (move.flags.includes("e")) {
    return `${move.to[0]}${move.from[1]}` as Square;
  }
  return move.to;
}

function toRawMove(move: Move): RawMove {
  return {
    piece: move.piece,
    color: move.color,
    from: move.from,
    to: move.to,
    promotion: move.promotion,
  };
}

function toBoardPiece(move: RawMove): BoardPiece {
  return {
    square: move.from,
    type: move.piece,
    color: move.color,
  };
}

function getBoardPieces(board: Chess): BoardPiece[] {
  const rows = board.board();
  const pieces: BoardPiece[] = [];
  for (const row of rows) {
    for (const piece of row) {
      if (piece) pieces.push(piece);
    }
  }
  return pieces;
}

function sameMove(a: RawMove, b: RawMove): boolean {
  return (
    a.piece === b.piece &&
    a.color === b.color &&
    a.from === b.from &&
    a.to === b.to &&
    a.promotion === b.promotion
  );
}

function xorMoves(a: RawMove[], b: RawMove[]): RawMove[] {
  const onlyA = a.filter((left) => !b.some((right) => sameMove(left, right)));
  const onlyB = b.filter((right) => !a.some((left) => sameMove(left, right)));
  return [...onlyA, ...onlyB];
}

function minByValue<T>(items: T[], pick: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const value = pick(item);
    if (value < bestValue) {
      bestValue = value;
      best = item;
    }
  }
  return best;
}

function currentTurnSubjectiveScore(score: number, turnBefore: "w" | "b") {
  const signed = score * (turnBefore === "w" ? 1 : -1);
  if (Math.abs(score) >= MATE_THRESHOLD) {
    const mateDistance = 100_000 - Math.abs(score);
    return {
      type: "mate" as const,
      value: signed > 0 ? mateDistance : -mateDistance,
    };
  }
  return {
    type: "centipawn" as const,
    value: signed,
  };
}

function directAttackingMoves(board: Chess, piece: BoardPiece): RawMove[] {
  const attackerBoard = new Chess(setFenTurn(board.fen(), flipColor(piece.color)));
  const attackingMoves = attackerBoard.moves({ verbose: true })
    .filter((move) => getCaptureSquare(move) === piece.square)
    .map(toRawMove);

  const kingAttackerSquare = attackerBoard
    .attackers(piece.square)
    .find((square) => attackerBoard.get(square)?.type === KING);

  if (
    kingAttackerSquare &&
    !attackingMoves.some((attack) => attack.piece === KING)
  ) {
    attackingMoves.push({
      piece: KING,
      color: flipColor(piece.color),
      from: kingAttackerSquare,
      to: piece.square,
    });
  }

  return attackingMoves;
}

function getAttackingMoves(board: Chess, piece: BoardPiece, transitive = true): RawMove[] {
  const attackingMoves = directAttackingMoves(board, piece);
  if (!transitive) return attackingMoves;

  const frontier = attackingMoves.map((move) => ({
    directFen: board.fen(),
    square: move.from,
    type: move.piece,
  }));

  while (frontier.length > 0) {
    const attacker = frontier.pop();
    if (!attacker || attacker.type === KING) continue;

    const transitiveBoard = new Chess(attacker.directFen);
    const oldAttacks = directAttackingMoves(transitiveBoard, piece)
      .filter((move) => move.from !== attacker.square);

    transitiveBoard.remove(attacker.square);

    const revealedAttacks = xorMoves(
      oldAttacks,
      directAttackingMoves(transitiveBoard, piece),
    );

    attackingMoves.push(...revealedAttacks);
    frontier.push(
      ...revealedAttacks.map((move) => ({
        directFen: transitiveBoard.fen(),
        square: move.from,
        type: move.piece,
      })),
    );
  }

  return attackingMoves;
}

function getDefendingMoves(board: Chess, piece: BoardPiece, transitive = true): RawMove[] {
  const defenderBoard = new Chess(board.fen());
  const attackingMoves = getAttackingMoves(defenderBoard, piece, false);

  let smallestRecapturerSet: RawMove[] | undefined;
  for (const attackingMove of attackingMoves) {
    const captureBoard = new Chess(setFenTurn(defenderBoard.fen(), flipColor(piece.color)));
    try {
      captureBoard.move(attackingMove);
    } catch {
      continue;
    }

    const recapturers = getAttackingMoves(
      captureBoard,
      {
        type: attackingMove.piece,
        color: attackingMove.color,
        square: attackingMove.to,
      },
      transitive,
    );

    if (!smallestRecapturerSet || recapturers.length < smallestRecapturerSet.length) {
      smallestRecapturerSet = recapturers;
    }
  }

  if (smallestRecapturerSet) return smallestRecapturerSet;

  const flippedPiece: BoardPiece = {
    type: piece.type,
    color: flipColor(piece.color),
    square: piece.square,
  };
  defenderBoard.put(flippedPiece, piece.square);
  return getAttackingMoves(defenderBoard, flippedPiece, transitive);
}

function isPieceSafe(board: Chess, piece: BoardPiece, playedMove?: Move): boolean {
  const directAttackers = getAttackingMoves(board, piece, false).map(toBoardPiece);
  const attackers = getAttackingMoves(board, piece, true).map(toBoardPiece);
  const defenders = getDefendingMoves(board, piece, true).map(toBoardPiece);

  if (
    playedMove?.captured &&
    piece.type === ROOK &&
    PIECE_VALUES[playedMove.captured] === PIECE_VALUES[KNIGHT] &&
    attackers.length === 1 &&
    defenders.length > 0 &&
    PIECE_VALUES[attackers[0].type] === PIECE_VALUES[KNIGHT]
  ) {
    return true;
  }

  if (directAttackers.some((attacker) => PIECE_VALUES[attacker.type] < PIECE_VALUES[piece.type])) {
    return false;
  }

  if (attackers.length <= defenders.length) return true;

  const lowestValueAttacker = minByValue(directAttackers, (attacker) => PIECE_VALUES[attacker.type]);
  if (!lowestValueAttacker) return true;

  if (
    PIECE_VALUES[piece.type] < PIECE_VALUES[lowestValueAttacker.type] &&
    defenders.some((defender) => PIECE_VALUES[defender.type] < PIECE_VALUES[lowestValueAttacker.type])
  ) {
    return true;
  }

  if (defenders.some((defender) => defender.type === PAWN)) return true;

  return false;
}

function getUnsafePieces(board: Chess, color: Color, playedMove?: Move): BoardPiece[] {
  const capturedPieceValue = playedMove?.captured ? PIECE_VALUES[playedMove.captured] : 0;
  return getBoardPieces(board).filter((piece) => (
    piece.color === color &&
    piece.type !== PAWN &&
    piece.type !== KING &&
    PIECE_VALUES[piece.type] > capturedPieceValue &&
    !isPieceSafe(board, piece, playedMove)
  ));
}

function relativeUnsafePieceAttacks(
  board: Chess,
  threatenedPiece: BoardPiece,
  color: Color,
  playedMove?: Move,
): RawMove[] {
  return getUnsafePieces(board, color, playedMove)
    .filter((unsafePiece) => (
      unsafePiece.square !== threatenedPiece.square &&
      PIECE_VALUES[unsafePiece.type] >= PIECE_VALUES[threatenedPiece.type]
    ))
    .flatMap((unsafePiece) => getAttackingMoves(board, unsafePiece, false));
}

function moveCreatesGreaterThreat(
  board: Chess,
  threatenedPiece: BoardPiece,
  actingMove: RawMove,
): boolean {
  const actionBoard = new Chess(board.fen());
  const previousRelativeAttacks = relativeUnsafePieceAttacks(
    actionBoard,
    threatenedPiece,
    actingMove.color,
  );

  try {
    const bakedMove = actionBoard.move(actingMove);
    const relativeAttacks = relativeUnsafePieceAttacks(
      actionBoard,
      threatenedPiece,
      actingMove.color,
      bakedMove,
    );
    const newRelativeAttacks = xorMoves(relativeAttacks, previousRelativeAttacks);
    if (newRelativeAttacks.length > 0) return true;

    return (
      PIECE_VALUES[threatenedPiece.type] < PIECE_VALUES[QUEEN] &&
      actionBoard.moves().some((move) => move.includes("#"))
    );
  } catch {
    return false;
  }
}

function moveLeavesGreaterThreat(
  board: Chess,
  threatenedPiece: BoardPiece,
  actingMove: RawMove,
): boolean {
  const actionBoard = new Chess(board.fen());
  try {
    actionBoard.move(actingMove);
  } catch {
    return false;
  }

  const relativeAttacks = relativeUnsafePieceAttacks(
    actionBoard,
    threatenedPiece,
    actingMove.color,
  );
  if (relativeAttacks.length > 0) return true;

  return (
    PIECE_VALUES[threatenedPiece.type] < PIECE_VALUES[QUEEN] &&
    actionBoard.moves().some((move) => move.includes("#"))
  );
}

function hasDangerLevels(
  board: Chess,
  threatenedPiece: BoardPiece,
  actingMoves: RawMove[],
  equalityStrategy: "creates" | "leaves" = "leaves",
): boolean {
  return actingMoves.every((actingMove) => (
    equalityStrategy === "creates"
      ? moveCreatesGreaterThreat(board, threatenedPiece, actingMove)
      : moveLeavesGreaterThreat(board, threatenedPiece, actingMove)
  ));
}

function isPieceTrapped(board: Chess, piece: BoardPiece, dangerLevels = true): boolean {
  const calibratedBoard = new Chess(setFenTurn(board.fen(), piece.color));
  const standingPieceSafety = isPieceSafe(calibratedBoard, piece);
  const pieceMoves = calibratedBoard.moves({ square: piece.square, verbose: true });

  const allMovesUnsafe = pieceMoves.every((move) => {
    if (move.captured === KING) return false;

    const escapeBoard = new Chess(calibratedBoard.fen());
    if (dangerLevels && moveCreatesGreaterThreat(escapeBoard, piece, toRawMove(move))) {
      return true;
    }

    const escapeMove = escapeBoard.move(move);
    return !isPieceSafe(
      escapeBoard,
      { ...piece, square: escapeMove.to },
      escapeMove,
    );
  });

  return !standingPieceSafety && allMovesUnsafe;
}

function isMoveCriticalCandidate(
  previousBoard: Chess,
  playedMove: Move,
  previousScore: number,
  currentScore: number,
  secondScore?: number,
): boolean {
  const turnBefore = previousBoard.turn();
  const currentSubjective = currentTurnSubjectiveScore(currentScore, turnBefore);
  const secondSubjective = secondScore !== undefined
    ? currentTurnSubjectiveScore(secondScore, turnBefore)
    : null;

  if (secondSubjective) {
    if (secondSubjective.type === "centipawn" && secondSubjective.value >= 700) return false;
  } else if (currentSubjective.type === "centipawn" && currentSubjective.value >= 700) {
    return false;
  }

  if (currentSubjective.value < 0) return false;
  if (playedMove.promotion === QUEEN) return false;
  if (previousBoard.isCheck()) return false;

  return true;
}

function considerCriticalClassification(
  previousBoard: Chess,
  currentBoard: Chess,
  playedMove: Move,
  previousScore: number,
  currentScore: number,
  secondScore?: number,
): boolean {
  if (!isMoveCriticalCandidate(previousBoard, playedMove, previousScore, currentScore, secondScore)) {
    return false;
  }

  const turnBefore = previousBoard.turn();
  const currentSubjective = currentTurnSubjectiveScore(currentScore, turnBefore);
  if (currentSubjective.type === "mate" && currentSubjective.value > 0) return false;

  if (playedMove.captured) {
    const capturedPieceSafe = isPieceSafe(
      previousBoard,
      {
        color: flipColor(playedMove.color),
        square: getCaptureSquare(playedMove),
        type: playedMove.captured,
      },
    );
    if (!capturedPieceSafe) return false;
  }

  if (secondScore === undefined) return false;

  return getExpectedPointsLoss(previousScore, secondScore, turnBefore) >= 0.1;
}

function considerBrilliantClassification(
  previousBoard: Chess,
  currentBoard: Chess,
  playedMove: Move,
  previousScore: number,
  currentScore: number,
  secondScore?: number,
): boolean {
  if (!isMoveCriticalCandidate(previousBoard, playedMove, previousScore, currentScore, secondScore)) {
    return false;
  }

  if (playedMove.promotion) return false;

  const previousUnsafePieces = getUnsafePieces(previousBoard, playedMove.color);
  const unsafePieces = getUnsafePieces(currentBoard, playedMove.color, playedMove);

  if (!currentBoard.isCheck() && unsafePieces.length < previousUnsafePieces.length) return false;

  const dangerLevelsProtected = unsafePieces.every((unsafePiece) => hasDangerLevels(
    currentBoard,
    unsafePiece,
    getAttackingMoves(currentBoard, unsafePiece, false),
  ));
  if (dangerLevelsProtected) return false;

  const previousTrappedPieces = previousUnsafePieces.filter((unsafePiece) => (
    isPieceTrapped(previousBoard, unsafePiece)
  ));
  const trappedPieces = unsafePieces.filter((unsafePiece) => (
    isPieceTrapped(currentBoard, unsafePiece)
  ));

  const movedPieceTrapped = previousTrappedPieces.some((piece) => (
    piece.square === playedMove.from
  ));

  if (
    trappedPieces.length === unsafePieces.length ||
    movedPieceTrapped ||
    trappedPieces.length < previousTrappedPieces.length
  ) {
    return false;
  }

  return unsafePieces.length > 0;
}

function parseUciMove(board: Chess, uci: string): Move {
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.length > 4 ? (uci[4] as PieceSymbol) : undefined;
  const move = board.move(promotion ? { from, to, promotion } : { from, to });
  if (!move) throw new Error("Invalid move");
  return move;
}

export function getMoveAccuracyFromScores(
  previousScore: number,
  currentScore: number,
  turnBefore: "w" | "b",
): number {
  const pointLoss = getExpectedPointsLoss(previousScore, currentScore, turnBefore);
  return 103.16 * Math.exp(-4 * pointLoss) - 3.17;
}

export function classifyReviewedMove({
  parentFen,
  currentFen,
  playedUci,
  previous,
  current,
  includeTheory = true,
}: ReviewedMoveInput): MoveClassification | null {
  if (previous.score === null || current.score === null) return null;

  const previousBoard = new Chess(parentFen);
  if (previousBoard.moves().length <= 1) return "best";

  if (includeTheory && isBookPosition(currentFen)) return "book";

  const currentBoard = new Chess(parentFen);
  const playedMove = parseUciMove(currentBoard, playedUci);
  if (currentBoard.isCheckmate()) return "best";

  const turnBefore = previousBoard.turn();
  const topMovePlayed = previous.topMove === playedUci;

  let classification: MoveClassification = topMovePlayed
    ? "best"
    : classifyMove(previous.score, current.score, turnBefore, false, previousBoard.moves().length);

  if (
    topMovePlayed &&
    considerCriticalClassification(
      previousBoard,
      currentBoard,
      playedMove,
      previous.score,
      current.score,
      previous.secondScore,
    )
  ) {
    classification = "great";
  }

  if (
    (classification === "best" || classification === "great") &&
    considerBrilliantClassification(
      previousBoard,
      currentBoard,
      playedMove,
      previous.score,
      current.score,
      previous.secondScore,
    )
  ) {
    classification = "brilliant";
  }

  return classification;
}
