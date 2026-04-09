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

// Singleton Redis connection for the Next.js server process
let _redis: IORedis | null = null;

function getRedis(): IORedis {
  if (!_redis) {
    _redis = new IORedis({
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => (times > 2 ? null : Math.min(times * 250, 1000)),
    });

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

export async function enqueueGameAnalysis(data: AnalyzeGameJobData): Promise<string> {
  const queue = getAnalyzeQueue();
  const job = await queue.add("analyze", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });
  return job.id!;
}

export async function isRedisQueueAvailable(timeoutMs: number = 1200): Promise<boolean> {
  const probe = new IORedis({
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await probe.connect();
    await Promise.race([
      probe.ping(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Redis ping timeout")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
