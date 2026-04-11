/**
 * PGN codec — strips redundant headers, gzip-compresses, base64-encodes.
 *
 * Format stored in DB:  "gz2:<base64(gzip(moves_only_pgn))>"
 * Legacy uncompressed:  anything not starting with "gz2:" → returned as-is.
 *
 * Headers (White, Black, Date, etc.) are already stored in their own columns
 * so we only keep the moves section. Clock annotations {[%clk h:mm:ss]} live
 * in move comments and are preserved.
 *
 * Compression level 9 gives ~85% reduction vs raw PGN for typical games.
 * Decompression is always fast (<1ms) regardless of level used during encode.
 */

import { gzipSync, gunzipSync } from "zlib";

const PREFIX = "gz2:";

/** Extract the moves section from a full PGN (everything after the blank line). */
function extractMoves(pgn: string): string {
  const sep = pgn.indexOf("\n\n");
  return sep === -1 ? pgn.trim() : pgn.slice(sep + 2).trim();
}

/**
 * Encode a PGN string for DB storage.
 * Strips headers → gzip level 9 → base64.
 */
export function encodePgn(pgn: string): string {
  const moves = extractMoves(pgn);
  const compressed = gzipSync(Buffer.from(moves, "utf8"), { level: 9 });
  return PREFIX + compressed.toString("base64");
}

/**
 * Decode a stored PGN back to the moves-only string.
 * Handles legacy uncompressed values transparently.
 */
export function decodePgn(stored: string): string {
  if (!stored.startsWith(PREFIX)) {
    // Legacy: full or partial PGN stored uncompressed — still parseable by chess.js
    return stored;
  }
  const b64 = stored.slice(PREFIX.length);
  const buf = gunzipSync(Buffer.from(b64, "base64"));
  return buf.toString("utf8");
}
