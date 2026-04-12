import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Exclude native/CJS-only packages from server bundle so require() works normally.
  serverExternalPackages: ["stockfish"],
  turbopack: {
    // Pin the root so Turbopack doesn't walk up to a parent lockfile
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Required for SharedArrayBuffer (multi-threaded Stockfish WASM)
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
