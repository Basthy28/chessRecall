import path from "path";
import { createRequire } from "module";
import { Chess } from "chess.js";

export const runtime = "nodejs";

// stockfish is excluded from the Next.js bundle via serverExternalPackages,
// so createRequire works here and resolves to the CJS entry point correctly.
const _require = createRequire(import.meta.url);
const initEngine = _require(
  path.join(process.cwd(), "node_modules", "stockfish", "index.js")
) as (
  enginePath?: string | null
) => Promise<StockfishEngine>;

interface StockfishEngine {
  listener?: (line: string) => void;
  sendCommand: (cmd: string) => void;
  terminate?: () => void;
}

interface EvalLine {
  move: string;
  san: string;
  score: number;
}

const nativeFetch: typeof fetch | undefined =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;

let enginePromise: Promise<StockfishEngine> | null = null;
let engineQueue: Promise<void> = Promise.resolve();

function restoreFetch() {
  if (nativeFetch && typeof globalThis.fetch !== "function") {
    Object.defineProperty(globalThis, "fetch", {
      value: nativeFetch,
      writable: true,
      configurable: true,
    });
  }
}

function withEngineLock<T>(task: () => Promise<T>): Promise<T> {
  const nextTask = engineQueue.then(task, task);
  engineQueue = nextTask.then(
    () => undefined,
    () => undefined
  );
  return nextTask;
}

function waitForLine(
  engine: StockfishEngine,
  command: string,
  expectedLine: string,
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const previousListener = engine.listener;
    const timeout = setTimeout(() => {
      engine.listener = previousListener;
      reject(new Error(`Timeout waiting for ${expectedLine}`));
    }, timeoutMs);

    engine.listener = (line: string) => {
      previousListener?.(line);
      if (line !== expectedLine) return;
      clearTimeout(timeout);
      engine.listener = previousListener;
      resolve();
    };

    engine.sendCommand(command);
  });
}

async function getEngine(): Promise<StockfishEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const engine = await initEngine("lite-single");
      restoreFetch();
      await waitForLine(engine, "uci", "uciok", 30_000);
      await waitForLine(engine, "isready", "readyok", 30_000);
      return engine;
    })().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }

  return enginePromise;
}

function parseScore(line: string): number | null {
  const mateMatch = line.match(/\bscore mate (-?\d+)\b/);
  if (mateMatch) {
    const mateIn = parseInt(mateMatch[1], 10);
    return mateIn > 0 ? 100_000 - mateIn : -100_000 - mateIn;
  }

  const cpMatch = line.match(/\bscore cp (-?\d+)\b/);
  if (!cpMatch) return null;
  return parseInt(cpMatch[1], 10);
}

function uciToSan(fen: string, uciMove: string): string {
  const chess = new Chess(fen);
  const move = chess.move({
    from: uciMove.slice(0, 2),
    to: uciMove.slice(2, 4),
    promotion: uciMove.length > 4 ? uciMove[4] : undefined,
  });

  if (!move) {
    throw new Error(`Invalid move ${uciMove}`);
  }

  return move.san;
}

async function analyzeFen(fen: string): Promise<{
  best: EvalLine;
  second: EvalLine | null;
  depth: number;
  turn: "w" | "b";
}> {
  return withEngineLock(async () => {
    const engine = await getEngine();
    const turn = new Chess(fen).turn();

    return new Promise<{
      best: EvalLine;
      second: EvalLine | null;
      depth: number;
      turn: "w" | "b";
    }>((resolve, reject) => {
      const previousListener = engine.listener;
      const pvByIndex = new Map<number, EvalLine>();
      let bestDepth = 0;
      let analysisStarted = false;

      const cleanup = () => {
        clearTimeout(timeout);
        engine.listener = previousListener;
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Live analysis timeout"));
      }, 45_000);

      engine.listener = (line: string) => {
        previousListener?.(line);

        if (line === "readyok" && !analysisStarted) {
          analysisStarted = true;
          engine.sendCommand("position fen " + fen);
          engine.sendCommand("go depth 12");
          return;
        }

        if (line.startsWith("info") && line.includes("multipv")) {
          const depthMatch = line.match(/\bdepth (\d+)\b/);
          const pvMatch = line.match(/\bpv (\S+)/);
          const multipvMatch = line.match(/\bmultipv (\d+)\b/);
          const depth = depthMatch ? parseInt(depthMatch[1], 10) : 0;
          const pvIndex = multipvMatch ? parseInt(multipvMatch[1], 10) : 0;
          const score = parseScore(line);

          if (!pvMatch || !pvIndex || pvIndex > 2 || score === null) return;
          if (depth < bestDepth) return;

          if (depth > bestDepth) {
            bestDepth = depth;
            pvByIndex.clear();
          }

          pvByIndex.set(pvIndex, {
            move: pvMatch[1],
            san: uciToSan(fen, pvMatch[1]),
            score,
          });
          return;
        }

        if (!line.startsWith("bestmove")) return;

        const best = pvByIndex.get(1);
        if (!best) {
          cleanup();
          reject(new Error("No live analysis result received"));
          return;
        }

        cleanup();
        resolve({
          best,
          second: pvByIndex.get(2) ?? null,
          depth: bestDepth,
          turn,
        });
      };

      engine.sendCommand("ucinewgame");
      engine.sendCommand("setoption name MultiPV value 2");
      engine.sendCommand("isready");
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  const fen = typeof raw.fen === "string" ? raw.fen.trim() : "";

  if (!fen) {
    return Response.json({ error: "Missing fen" }, { status: 400 });
  }

  try {
    new Chess(fen);
  } catch {
    return Response.json({ error: "Invalid FEN" }, { status: 422 });
  }

  try {
    const result = await analyzeFen(fen);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not analyze this position.",
      },
      { status: 500 }
    );
  }
}
