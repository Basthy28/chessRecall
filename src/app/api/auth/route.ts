/**
 * /api/auth — Server-side session check
 *
 * GET → returns { user: { id: string, email: string } | null }
 */

import { createServerClient } from "@/lib/supabase";

export async function GET(): Promise<Response> {
  let supabase: ReturnType<typeof createServerClient>;
  try {
    supabase = createServerClient();
  } catch {
    return Response.json({ user: null });
  }

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return Response.json({ user: null });
    }

    return Response.json({
      user: {
        id: user.id,
        email: user.email ?? null,
      },
    });
  } catch (err) {
    console.error("[auth] getUser error:", err);
    return Response.json({ user: null });
  }
}
