import { readFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";

const ALLOWED_FILES = new Map<string, string>([
  ["stockfish-18.js", "application/javascript; charset=utf-8"],
  ["stockfish-18.wasm", "application/wasm"],
  ["stockfish-18-single.js", "application/javascript; charset=utf-8"],
  ["stockfish-18-single.wasm", "application/wasm"],
  ["stockfish-18-lite-single.js", "application/javascript; charset=utf-8"],
  ["stockfish-18-lite-single.wasm", "application/wasm"],
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ file: string }> }
): Promise<Response> {
  const { file } = await context.params;
  const contentType = ALLOWED_FILES.get(file);

  if (!contentType) {
    return new Response("Not found", { status: 404 });
  }

  const filePath = path.join(
    process.cwd(),
    "node_modules",
    "stockfish",
    "bin",
    file
  );

  try {
    const body = await readFile(filePath);
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
