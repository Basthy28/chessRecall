export type LinkedPlatform = "lichess" | "chess.com";

export interface LinkedAccounts {
  lichess: string;
  chessCom: string;
}

const STORAGE_KEY = "chessRecall:linkedAccounts";

const EMPTY_ACCOUNTS: LinkedAccounts = {
  lichess: "",
  chessCom: "",
};

function normalizeUsername(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function readLinkedAccounts(): LinkedAccounts {
  if (typeof window === "undefined") return EMPTY_ACCOUNTS;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_ACCOUNTS;

    const parsed = JSON.parse(raw) as Partial<LinkedAccounts>;
    return {
      lichess: normalizeUsername(parsed.lichess),
      chessCom: normalizeUsername(parsed.chessCom),
    };
  } catch {
    return EMPTY_ACCOUNTS;
  }
}

export function saveLinkedAccounts(accounts: LinkedAccounts): void {
  if (typeof window === "undefined") return;

  const normalized: LinkedAccounts = {
    lichess: normalizeUsername(accounts.lichess),
    chessCom: normalizeUsername(accounts.chessCom),
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

/**
 * Persist linked accounts to Supabase user_metadata so they sync across devices.
 * Falls back silently if auth is unavailable.
 */
export async function syncLinkedAccountsToSupabase(
  accounts: LinkedAccounts
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const { createBrowserClient } = await import("@/lib/supabase");
    const supabase = createBrowserClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return; // guest — nothing to sync
    await supabase.auth.updateUser({
      data: { linkedAccounts: accounts },
    });
  } catch (err) {
    console.warn("[linkedAccounts] Failed to sync to Supabase:", err);
  }
}

/**
 * Restore linked accounts from Supabase user_metadata into localStorage.
 * Call this after login if localStorage is empty.
 */
export async function restoreLinkedAccountsFromSupabase(): Promise<LinkedAccounts | null> {
  if (typeof window === "undefined") return null;
  try {
    const { createBrowserClient } = await import("@/lib/supabase");
    const supabase = createBrowserClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const meta = user.user_metadata as Record<string, unknown> | null;
    const stored = meta?.linkedAccounts as Partial<LinkedAccounts> | undefined;
    if (!stored) return null;

    const accounts: LinkedAccounts = {
      lichess: normalizeUsername(stored.lichess),
      chessCom: normalizeUsername(stored.chessCom),
    };

    // Only restore if we have something meaningful
    if (!accounts.lichess && !accounts.chessCom) return null;

    return accounts;
  } catch (err) {
    console.warn("[linkedAccounts] Failed to restore from Supabase:", err);
    return null;
  }
}

export function getLinkedUsername(
  accounts: LinkedAccounts,
  platform: LinkedPlatform
): string {
  return platform === "chess.com" ? accounts.chessCom : accounts.lichess;
}

export function getAllViewerUsernames(accounts: LinkedAccounts): string[] {
  const values = [accounts.lichess, accounts.chessCom]
    .map((value) => normalizeUsername(value))
    .filter(Boolean);

  return Array.from(new Set(values));
}

export function inferPlatformFromGameId(gameId: string): LinkedPlatform {
  return gameId.startsWith("cc_") ? "chess.com" : "lichess";
}

export function usernameMatchesPlayer(username: string, player: string): boolean {
  if (!username || !player) return false;
  return normalizeUsername(username) === normalizeUsername(player);
}
