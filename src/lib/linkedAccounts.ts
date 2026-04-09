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
