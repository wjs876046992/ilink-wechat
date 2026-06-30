/**
 * In-memory registry of pending async callbacks.
 *
 * When the REST provider operates in async mode it POSTs the inbound message to the
 * external server and immediately returns a `pendingCallbackId`.  The caller then
 * registers the WeChat send-context here so that the callback server can look it up
 * when the external server eventually calls back with the reply.
 *
 * Entries expire after `ENTRY_TTL_MS` to avoid unbounded memory growth when the
 * external server never calls back.
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
  /** Optional timeout timer reference for cancellation. */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Optional callback to invoke when the timeout fires. */
  onTimeout?: () => void;
};

/** Entries are kept for up to 10 minutes then silently dropped. */
const ENTRY_TTL_MS = 10 * 60 * 1_000;

/** Default callback timeout (5 minutes). */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

/** Default timeout notification message. */
export const DEFAULT_CALLBACK_TIMEOUT_MESSAGE = "⏰ 回调超时，消息处理失败，请稍后再试。";

class CallbackRegistry {
  private readonly pending = new Map<string, PendingCallbackContext>();

  /** Dump all current map keys + expiry info at DEBUG level. */
  private debugDump(op: string): void {
    const now = Date.now();
    const entries = [...this.pending.entries()].map(([id, e]) => {
      const ttlSec = Math.round((e.expiresAt - now) / 1_000);
      const hasTimer = Boolean(e.timeoutTimer);
      return `${id}(to=${e.to},ttl=${ttlSec}s,timer=${hasTimer})`;
    });
    logger.debug(
      `[callback-registry] ${op} — size=${this.pending.size} map=[${entries.join(", ") || "(empty)"}]`,
    );
  }

  /**
   * Register a pending callback context keyed by requestId.
   * @param requestId - Unique identifier for this callback
   * @param ctx - Callback context (without expiresAt)
   * @param timeoutMs - Optional timeout in ms (default: 5 minutes)
   * @param onTimeout - Optional callback to invoke when timeout fires
   */
  register(
    requestId: string,
    ctx: Omit<PendingCallbackContext, "expiresAt">,
    timeoutMs?: number,
    onTimeout?: () => void,
  ): void {
    // Clear any existing timer for this requestId
    this.clearTimeout(requestId);

    const entry: PendingCallbackContext = {
      ...ctx,
      expiresAt: Date.now() + ENTRY_TTL_MS,
    };

    // Set up timeout timer if requested
    if (timeoutMs && timeoutMs > 0 && onTimeout) {
      entry.onTimeout = onTimeout;
      entry.timeoutTimer = setTimeout(() => {
        logger.info(`[callback-registry] timeout fired for requestId=${requestId}`);
        onTimeout();
        this.remove(requestId);
      }, timeoutMs);
    }

    this.pending.set(requestId, entry);
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
      this.clearTimeout(requestId);
      this.pending.delete(requestId);
      this.debugDump(`get(${requestId}) → expired, evicted`);
      return undefined;
    }
    this.debugDump(`get(${requestId}) → hit`);
    return entry;
  }

  /** Remove a specific entry by requestId (e.g. when an async POST fails before any callback). */
  remove(requestId: string): void {
    this.clearTimeout(requestId);
    this.pending.delete(requestId);
    this.debugDump(`remove(${requestId})`);
  }

  /**
   * Cancel the timeout timer for a specific requestId.
   * Called when a callback is received successfully.
   */
  clearTimeout(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (entry?.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = undefined;
      entry.onTimeout = undefined;
      logger.debug(`[callback-registry] timeout cancelled for requestId=${requestId}`);
    }
  }

  /** Remove all expired entries (called periodically by the callback server). */
  cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now > entry.expiresAt) {
        this.clearTimeout(id);
        this.pending.delete(id);
      }
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
