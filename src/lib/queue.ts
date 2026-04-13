/**
 * queue.ts — BullMQ producer helper
 *
 * Used by API routes to enqueue game analysis jobs.
 * Workers read from the same queue (see analyzeGame.worker.ts).
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { AnalyzeGameJobData, AnalyzeGameJobResult } from "@/types";
import { ANALYZE_QUEUE_NAME } from "@/lib/constants";

interface EnqueueOptions {
  force?: boolean;
}

const FORCE_REQUEUE_LOCK_TTL_MS = 60_000;

function createRedisClient(options: {
  connectTimeout: number;
  maxRetriesPerRequest: number | null;
}): IORedis {
  const redisUrl = process.env.REDIS_URL?.trim();
  const tls = process.env.REDIS_TLS === "true" ? {} : undefined;

  if (redisUrl) {
    return new IORedis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: options.connectTimeout,
      maxRetriesPerRequest: options.maxRetriesPerRequest,
      retryStrategy: (times) => (times > 2 ? null : Math.min(times * 250, 1000)),
      ...(tls ? { tls } : {}),
    });
  }

  return new IORedis({
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: options.connectTimeout,
    maxRetriesPerRequest: options.maxRetriesPerRequest,
    retryStrategy: (times) => (times > 2 ? null : Math.min(times * 250, 1000)),
    ...(tls ? { tls } : {}),
  });
}

// Singleton Redis connection for the Next.js server process
let _redis: IORedis | null = null;

function getRedis(): IORedis {
  if (!_redis) {
    _redis = createRedisClient({ connectTimeout: 8000, maxRetriesPerRequest: null });

    // Avoid noisy ECONNREFUSED flooding when Redis is intentionally down in local dev.
    _redis.on("error", () => {
      // Connection health is reported by API responses; keep console quiet here.
    });
  }
  return _redis;
}

// Singleton Queue instance
let _queue: Queue<AnalyzeGameJobData, AnalyzeGameJobResult> | null = null;

export function getAnalyzeQueue(): Queue<AnalyzeGameJobData, AnalyzeGameJobResult> {
  if (!_queue) {
    _queue = new Queue(ANALYZE_QUEUE_NAME, { connection: getRedis() });
  }
  return _queue;
}

export async function enqueueGameAnalysis(
  data: AnalyzeGameJobData,
  options?: EnqueueOptions
): Promise<string> {
  const queue = getAnalyzeQueue();
  const force = options?.force === true;
  const jobId = force
    ? `game-${data.gameId}-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : `game-${data.gameId}`;
  const job = await queue.add("analyze", data, {
    jobId,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });
  return job.id!;
}

export async function reserveForcedRequeueSlot(gameId: string): Promise<boolean> {
  const key = `analyze:force-requeue:${gameId}`;
  const result = await getRedis().set(
    key,
    String(Date.now()),
    "PX",
    FORCE_REQUEUE_LOCK_TTL_MS,
    "NX"
  );
  return result === "OK";
}

export async function isRedisQueueAvailable(timeoutMs: number = 5000): Promise<boolean> {
  const probe = createRedisClient({ connectTimeout: timeoutMs, maxRetriesPerRequest: 1 });

  try {
    await probe.connect();
    await Promise.race([
      probe.ping(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Redis ping timeout")), timeoutMs);
      }),
    ]);
    console.log("[queue] Redis probe: connected OK");
    return true;
  } catch (err) {
    console.error("[queue] Redis probe failed:", (err as Error).message);
    return false;
  } finally {
    probe.disconnect();
  }
}
