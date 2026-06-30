/**
 * In-memory registry of pending async callbacks.
 *
 * When the REST provider operates in async mode it POSTs the inbound message to the
 * external server and immediately returns a `pendingCallbackId`.  The caller then
 * registers the WeChat send-context here so that the callback server can look it up
 * when the external server eventually calls back with the reply.
 *
 * Entries expire after `ENTRY_TTL_MS` to avoid unbounded memory growth when the
 * external server never calls back.  The same requestId can be consumed multiple
 * times within the TTL window (to support multi-message replies).
 */

import { logger } from "../util/logger.js";

/** The context needed to send a WeChat reply once the async callback arrives. */
export type PendingCallbackContext = {
  /** WeChat recipient user ID (the original sender). */
  to: string;
  /** Bot API base URL. */
  baseUrl: string;
  /** Bot API auth token. */
  token: string;
  /** WeChat conversation context token — must be echoed in sendMessage. */
  contextToken?: string;
  /** Bot account ID (for logging). */
  accountId: string;
  /** Bot CDN base URL — required for media file uploads. */
  cdnBaseUrl: string;
  /** Monotonic expiry timestamp (Date.now() + TTL). */
  expiresAt: number;
};

/** Default entry TTL: 10 minutes. */
export const DEFAULT_ENTRY_TTL_MS = 10 * 60 * 1_000;

/** Cleanup interval: every 30 seconds. */
const CLEANUP_INTERVAL_MS = 30 * 1_000;

class CallbackRegistry {
  private readonly pending = new Map<string, PendingCallbackContext>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private entryTtlMs = DEFAULT_ENTRY_TTL_MS;

  /** Dump all current map keys + expiry info at DEBUG level. */
  private debugDump(op: string): void {
    const now = Date.now();
    const entries = [...this.pending.entries()].map(([id, e]) => {
      const ttlSec = Math.round((e.expiresAt - now) / 1_000);
      return `${id}(to=${e.to},ttl=${ttlSec}s)`;
    });
    logger.debug(
      `[callback-registry] ${op} — size=${this.pending.size} map=[${entries.join(", ") || "(empty)"}]`,
    );
  }

  /** Set custom entry TTL (in ms). Must be called before any registers. */
  setEntryTtl(ms: number): void {
    if (ms > 0) {
      this.entryTtlMs = ms;
      logger.info(`[callback-registry] entry TTL set to ${ms}ms`);
    }
  }

  /** Start periodic cleanup. Called once by the callback server. */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    logger.debug(`[callback-registry] cleanup started (interval=${CLEANUP_INTERVAL_MS}ms)`);
  }

  /** Stop periodic cleanup. */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      logger.debug(`[callback-registry] cleanup stopped`);
    }
  }

  /** Register a pending callback context keyed by requestId. */
  register(requestId: string, ctx: Omit<PendingCallbackContext, "expiresAt">): void {
    this.pending.set(requestId, { ...ctx, expiresAt: Date.now() + this.entryTtlMs });
    this.debugDump(`register(${requestId})`);
  }

  /** Retrieve the context for a given requestId WITHOUT removing it, so the same
   *  requestId can be reused across multiple callbacks within the TTL window.
   *  Returns undefined if not found or expired. */
  get(requestId: string): PendingCallbackContext | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) {
      this.debugDump(`get(${requestId}) → not found`);
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.pending.delete(requestId);
      this.debugDump(`get(${requestId}) → expired, evicted`);
      return undefined;
    }
    this.debugDump(`get(${requestId}) → hit`);
    return entry;
  }

  /** Remove a specific entry by requestId (e.g. when an async POST fails before any callback). */
  remove(requestId: string): void {
    this.pending.delete(requestId);
    this.debugDump(`remove(${requestId})`);
  }

  /** Remove all expired entries. */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of this.pending) {
      if (now > entry.expiresAt) {
        this.pending.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info(`[callback-registry] cleanup: removed ${removed} expired entries`);
    }
    this.debugDump("cleanup");
  }

  /** Number of currently registered pending callbacks (for diagnostics). */
  size(): number {
    return this.pending.size;
  }
}

/** Singleton registry shared between the REST provider and the callback server. */
export const callbackRegistry = new CallbackRegistry();
