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

// Browser/client-side client (uses anon key)
export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createClient(url, key);
}
