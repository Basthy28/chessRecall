/**
 * /api/auth — Server-side session check
 *
 * GET → returns { user: { id: string, email: string } | null }
 */

import { getUserFromRequest } from "@/lib/supabase";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return Response.json({ user: null });
    return Response.json({ user: { id: user.id, email: user.email ?? null } });
  } catch (err) {
    console.error("[auth] getUser error:", err);
    return Response.json({ user: null });
  }
}
