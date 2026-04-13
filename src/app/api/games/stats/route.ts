import { countGamesByStatusForPlatform, countGamesByUserForPlatform } from "@/lib/localDb";
import { getUserFromRequest } from "@/lib/supabase";

type Platform = "lichess" | "chess.com" | "all";

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

  const url = new URL(request.url);
  const platformParam = (url.searchParams.get("platform") ?? "all").toLowerCase();
  const platform: Platform =
    platformParam === "chess.com" || platformParam === "lichess" || platformParam === "all"
      ? (platformParam as Platform)
      : "all";
  const searchQuery = (url.searchParams.get("q") ?? "").trim();

  const [total, statusCounts] = await Promise.all([
    countGamesByUserForPlatform(sessionUser.id, platform, searchQuery),
    countGamesByStatusForPlatform(sessionUser.id, platform, searchQuery),
  ]);

  return Response.json({ total, ...statusCounts });
}
