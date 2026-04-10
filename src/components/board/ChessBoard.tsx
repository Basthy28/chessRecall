"use client";

import { useEffect, useRef } from "react";
import { Chess } from "chess.js";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { Color, Key } from "chessground/types";

export interface MoveAnnotationOverlay {
  square: Key;   // destination square of the annotated move
  symbol: string; // "!!", "?", "!?", "★", etc.
  color: string;  // CSS color
}

interface ChessBoardProps {
  fen?: string;
  orientation?: Color;
  lastMove?: [Key, Key];
  onMove?: (orig: Key, dest: Key) => void;
  interactive?: boolean;
  allowAnyColorMoves?: boolean;
  className?: string;
  showCoordinates?: boolean;
  annotation?: MoveAnnotationOverlay;
}

function getLegalDests(fen: string): Map<Key, Key[]> {
  const chess = new Chess(fen);
  const dests = new Map<Key, Key[]>();
  for (const move of chess.moves({ verbose: true })) {
    const froms = dests.get(move.from as Key) ?? [];
    froms.push(move.to as Key);
    dests.set(move.from as Key, froms);
  }
  return dests;
}

function swapFenTurn(fen: string): string {
  const parts = fen.split(" ");
  if (parts.length < 2) return fen;
  parts[1] = parts[1] === "w" ? "b" : "w";
  return parts.join(" ");
}

function getAllSideDests(fen: string): Map<Key, Key[]> {
  const merged = new Map<Key, Key[]>();
  const addFrom = (source: Map<Key, Key[]>) => {
    for (const [from, toSquares] of source.entries()) {
      const current = merged.get(from) ?? [];
      for (const to of toSquares) {
        if (!current.includes(to)) current.push(to);
      }
      merged.set(from, current);
    }
  };

  addFrom(getLegalDests(fen));
  addFrom(getLegalDests(swapFenTurn(fen)));
  return merged;
}

function getTurnColor(fen: string): Color {
  return new Chess(fen).turn() === "w" ? "white" : "black";
}

function getCheckColor(fen: string): Color | false {
  const chess = new Chess(fen);
  if (!chess.inCheck()) return false;
  return chess.turn() === "w" ? "white" : "black";
}

function squareToPercent(square: Key, orientation: Color): { left: string; top: string } {
  const file = square.charCodeAt(0) - 97; // a=0..h=7
  const rank = parseInt(square[1], 10) - 1; // 1=0..8=7
  const col = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  return {
    left: `${col * 12.5 + 9}%`,
    top: `${row * 12.5 + 0.5}%`,
  };
}

export default function ChessBoard({
  fen,
  orientation = "white",
  lastMove,
  onMove,
  interactive = true,
  allowAnyColorMoves = false,
  className = "",
  showCoordinates = false,
  annotation,
}: ChessBoardProps) {
  const innerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);

  // Sync onMove ref
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  // ── Initialize once after mount ────────────────────────────────────
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    const currentFen = fen ?? "start";
    const turnColor = getTurnColor(currentFen);
    const checkColor = getCheckColor(currentFen);
    const dests = interactive
      ? allowAnyColorMoves
        ? getAllSideDests(currentFen)
        : getLegalDests(currentFen)
      : new Map();

    const config: Config = {
      fen: currentFen,
      orientation,
      turnColor,
      check: checkColor,
      coordinates: false,
      movable: {
        free: false,
        color: interactive ? (allowAnyColorMoves ? "both" : turnColor) : undefined,
        dests,
        showDests: true,
      },
      animation: { enabled: true, duration: 150 },
      highlight: { lastMove: true, check: true },
      premovable: { enabled: false },
      draggable: { enabled: interactive },
      selectable: { enabled: interactive },
      events: {
        move: (orig, dest) => onMoveRef.current?.(orig, dest),
      },
    };

    apiRef.current = Chessground(el, config);

    /*
     * Arrow-drawing coordinate fix.
     *
     * Chessground caches `cg-board.getBoundingClientRect()` at init time.
     * If the board's screen position changes after init (layout shifts, sticky
     * headers settling, flex reflows), the cached bounds become stale. Arrow
     * drawing uses these cached bounds to map click coordinates → squares,
     * causing the "one-square-off" bug. Piece movement does NOT show this bug
     * because pieces are positioned with percentage-based transforms relative
     * to the board element, which are always visually correct regardless of
     * cached absolute bounds.
     *
     * Fix: call `redrawAll()` (which clears the bounds cache) via:
     *   1. A `requestAnimationFrame` immediately after init — catches the
     *      first post-layout-paint position.
     *   2. A `ResizeObserver` on the board container — catches any subsequent
     *      layout shifts (window resize, sidebar toggle, etc.).
     */
    const rafId = requestAnimationFrame(() => {
      apiRef.current?.redrawAll();
    });

    const resizeObserver = new ResizeObserver(() => {
      apiRef.current?.redrawAll();
    });
    resizeObserver.observe(el);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      apiRef.current?.destroy();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync prop changes to the running instance ──────────────────────
  useEffect(() => {
    if (!apiRef.current) return;

    const currentFen = fen ?? "start";
    const turnColor = getTurnColor(currentFen);
    const checkColor = getCheckColor(currentFen);
    const dests = interactive
      ? allowAnyColorMoves
        ? getAllSideDests(currentFen)
        : getLegalDests(currentFen)
      : new Map();

    apiRef.current.set({
      fen: currentFen,
      orientation,
      turnColor,
      check: checkColor,
      lastMove: lastMove ?? undefined,
      movable: {
        free: false,
        color: interactive ? (allowAnyColorMoves ? "both" : turnColor) : undefined,
        dests,
        showDests: true,
      },
    });
  }, [fen, orientation, lastMove, interactive, allowAnyColorMoves]);

  return (
    <div
      className={`chess-recall-board relative ${className}`}
      style={{
        paddingBottom: "100%",
        overflow: "visible",
        borderRadius: "6px",
      }}
    >
      {showCoordinates && (
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 3 }}>
          {(() => {
            const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
            const ranks = ["1", "2", "3", "4", "5", "6", "7", "8"];

            const fileOrder = orientation === "white" ? files : [...files].reverse();
            const rankOrderTopToBottom = orientation === "white" ? [...ranks].reverse() : ranks;

            const fileIndex = (file: string) => files.indexOf(file);
            const rankIndex = (rank: string) => ranks.indexOf(rank);
            const isDarkSquare = (file: string, rank: string) => {
              const f = fileIndex(file);
              const r = rankIndex(rank);
              if (f < 0 || r < 0) return false;
              return (f + r) % 2 === 0;
            };

            const labelColorForSquare = (file: string, rank: string) =>
              isDarkSquare(file, rank) ? "rgba(240, 217, 181, 0.92)" : "rgba(181, 136, 99, 0.92)";

            return (
              <>
                {fileOrder.map((file, idx) => {
                  const rank = orientation === "white" ? "1" : "8";
                  return (
                    <span
                      key={`file-${file}`}
                      style={{
                        position: "absolute",
                        bottom: "2px",
                        left: `calc(${idx * 12.5}% + 3px)`,
                        fontSize: "11px",
                        fontWeight: 800,
                        letterSpacing: "0.02em",
                        color: labelColorForSquare(file, rank),
                        textShadow: "0 1px 1px rgba(0,0,0,0.45)",
                        userSelect: "none",
                        lineHeight: 1,
                      }}
                    >
                      {file}
                    </span>
                  );
                })}

                {rankOrderTopToBottom.map((rank, idx) => {
                  const displayFile = orientation === "white" ? "h" : "a";
                  return (
                    <span
                      key={`rank-${rank}`}
                      style={{
                        position: "absolute",
                        top: `calc(${idx * 12.5}% + 3px)`,
                        right: "2px",
                        fontSize: "11px",
                        fontWeight: 800,
                        letterSpacing: "0.02em",
                        color: labelColorForSquare(displayFile, rank),
                        textShadow: "0 1px 1px rgba(0,0,0,0.45)",
                        userSelect: "none",
                        lineHeight: 1,
                      }}
                    >
                      {rank}
                    </span>
                  );
                })}
              </>
            );
          })()}
        </div>
      )}
      <div
        ref={innerRef}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
      />
      {annotation && (() => {
        const pos = squareToPercent(annotation.square, orientation);
        return (
          <div
            style={{
              position: "absolute",
              left: pos.left,
              top: pos.top,
              pointerEvents: "none",
              zIndex: 5,
              background: annotation.color,
              color: "#fff",
              borderRadius: "50%",
              width: "22%",
              maxWidth: "28px",
              aspectRatio: "1",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "clamp(8px, 1.8vw, 13px)",
              fontWeight: 900,
              boxShadow: "0 1px 4px rgba(0,0,0,0.7)",
              lineHeight: 1,
              transform: "translate(-2px, -2px)",
            }}
          >
            {annotation.symbol}
          </div>
        );
      })()}
    </div>
  );
}
