import { createClient } from "@supabase/supabase-js";

/**
 * Supabase client helpers.
 *
 * NOTE: The typed `Database` generic is intentionally omitted here.
 * Supabase v2 requires types that match its internal `GenericSchema`
 * constraint exactly — practically, this means you must run
 * `supabase gen types typescript` against the live DB.
 *
 * Phase 2: once the Supabase project + migrations are applied,
 * run `npx supabase gen types typescript --project-id <id> > src/lib/database.types.ts`
 * and swap `createClient(url, key)` → `createClient<Database>(url, key)`.
 */

// Server-side client (uses service role key — never expose to browser)
// URL can be set as SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL (same value, different name conventions)
export function createServerClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
  }
  return createClient(url, key);
}

/**
 * Server-side: extract the bearer token from the Authorization header and
 * validate it via the service-role client. Returns the Supabase User or null.
 *
 * Why this instead of auth.getUser() with no args: the service-role client has
 * no session context — it can only validate a JWT that the browser passes in.
 */
export async function getUserFromRequest(request: Request) {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    const supabase = createServerClient();
    const { data: { user } } = await supabase.auth.getUser(token);
    return user ?? null;
  } catch {
    return null;
  }
}

// Browser/client-side client (uses anon key)
export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createClient(url, key);
}

/**
 * Browser-side: returns { Authorization: "Bearer <token>" } ready to spread
 * into fetch headers. Returns {} if there is no active session.
 */
export async function getClientAuthHeaders(): Promise<Record<string, string>> {
  if (typeof window === "undefined") return {};
  const supabase = createBrowserClient();
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
