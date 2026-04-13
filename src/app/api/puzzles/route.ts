import {
  applyPuzzleSrsRating,
  getPuzzleProgressStatsForUser,
  listDuePuzzlesForUser,
  resetPuzzleSrsForUser,
} from "@/lib/localDb";
import { getUserFromRequest } from "@/lib/supabase";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(request: Request): number {
  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(raw), MAX_LIMIT));
}

export async function GET(request: Request): Promise<Response> {
  let sessionUser;
  try {
    sessionUser = await getUserFromRequest(request);
  } catch {
    return Response.json({ error: "Auth service unavailable" }, { status: 500 });
  }
  if (!sessionUser) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();
  const puzzles = await listDuePuzzlesForUser(sessionUser.id, parseLimit(request), now);
  const stats = await getPuzzleProgressStatsForUser(sessionUser.id, now);
  return Response.json({ puzzles, stats });
}

export async function PATCH(request: Request): Promise<Response> {
  let sessionUser;
  try {
    sessionUser = await getUserFromRequest(request);
  } catch {
    return Response.json({ error: "Auth service unavailable" }, { status: 500 });
  }
  if (!sessionUser) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  const puzzleId = typeof raw.puzzleId === "string" ? raw.puzzleId : "";
  const choice = raw.choice;
  const revealed = raw.revealed === true;
  const mistakes =
    typeof raw.mistakes === "number" && Number.isFinite(raw.mistakes)
      ? Math.max(0, Math.floor(raw.mistakes))
      : 0;

  if (!puzzleId) {
    return Response.json({ error: "Missing puzzleId" }, { status: 400 });
  }

  if (choice !== "hard" && choice !== "good" && choice !== "easy") {
    return Response.json({ error: "Invalid choice" }, { status: 400 });
  }

  const ok = await applyPuzzleSrsRating(sessionUser.id, puzzleId, choice, {
    revealed,
    mistakes,
  });
  if (!ok) {
    return Response.json({ error: "Puzzle not found" }, { status: 404 });
  }

  const stats = await getPuzzleProgressStatsForUser(sessionUser.id, new Date().toISOString());
  return Response.json({ ok: true, stats });
}

export async function DELETE(request: Request): Promise<Response> {
  let sessionUser;
  try {
    sessionUser = await getUserFromRequest(request);
  } catch {
    return Response.json({ error: "Auth service unavailable" }, { status: 500 });
  }
  if (!sessionUser) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const count = await resetPuzzleSrsForUser(sessionUser.id);
  const stats = await getPuzzleProgressStatsForUser(sessionUser.id, new Date().toISOString());
  return Response.json({ reset: count, stats });
}
