#!/usr/bin/env node
/**
 * scripts/download-eco.mjs
 * Downloads the Lichess chess-openings dataset and generates a FEN-keyed
 * JSON lookup map at src/lib/ecoBook.json
 * 
 * Run once: node scripts/download-eco.mjs
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "../src/lib/ecoBook.json");

// Hayatbiralem's FEN-keyed ECO JSON (derived from official Lichess TSV files)
const BASE_URL =
  "https://raw.githubusercontent.com/hayatbiralem/eco.json/master/eco";
const FILES = ["A", "B", "C", "D", "E"];

async function download() {
  const merged = {};
  let total = 0;

  for (const letter of FILES) {
    const url = `${BASE_URL}${letter}.json`;
    console.log(`Fetching ${url}...`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const count = Object.keys(data).length;
      console.log(`  → ${count} positions`);
      total += count;
      for (const [fen, entry] of Object.entries(data)) {
        // Key: position part of FEN only (strip move counters to normalise)
        // But keep full FEN as key for now — chess.js also produces full FEN
        merged[fen] = { eco: entry.eco, name: entry.name };
      }
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    }
  }

  console.log(`\nTotal positions: ${total}`);
  writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 0));
  console.log(`Written to: ${OUTPUT_PATH}`);
}

download();
