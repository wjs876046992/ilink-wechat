/**
 * External reply providers — REST and WebSocket implementations.
 *
 * REST provider:
 *   POST JSON to an HTTP(S) endpoint and read the text reply from the response.
 *   Supports two request formats:
 *     - "simple" (default): { from, body, contextToken, accountId, mediaPath?, mediaType? }
 *       Expected response: { reply?: string, text?: string, content?: string, mediaUrl?: string }
 *       Also accepts a bare plain-text response body.
 *     - "openai": OpenAI chat-completions format — sends { model, messages }
 *       and parses choices[0].message.content from the response.
 *
 * WebSocket provider:
 *   Opens a WebSocket connection, sends one JSON message, waits for one reply, then closes.
 *   Send:    { type: "message", from, body, contextToken, accountId, mediaPath?, mediaType? }
 *   Receive: { type: "reply", text: string } — or any object with a text/reply/content field,
 *            or a bare string frame.
 *   Node.js ≥22 global WebSocket is used (no external ws package needed).
 */

import { logger } from "../util/logger.js";
import type { ExternalReplyRequest, ExternalReplyResponse, ReplyProvider } from "./types.js";
import { generateId } from "../util/random.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FALLBACK_MESSAGE = "❌ 服务暂时不可用，请稍后再试～";

// ---------------------------------------------------------------------------
// REST provider
// ---------------------------------------------------------------------------

export interface RestProviderConfig {
  type: "rest";
  endpoint: string;
  /** Header name to use for the auth token (default: "Authorization"). */
  authHeader?: string;
  /** Value for the auth header. */
  authToken?: string;
  /** Request timeout in ms (default: 30 000). */
  timeoutMs?: number;
  /** Message sent to the user when the external API fails or returns empty. */
  fallbackMessage?: string;
  /**
   * Request body format.
   * - "simple" (default): simple JSON with `from` / `body` / `contextToken` etc.
   * - "openai": OpenAI chat-completions compatible format.
   */
  requestFormat?: "simple" | "openai";
  /**
   * Reply delivery mode.
   * - "sync" (default): the bot waits for the HTTP response and sends its content to WeChat.
   * - "async": the bot fires the POST and returns immediately.  The external server is
   *   expected to call back to the bot's callback endpoint (configured via callbackPort /
   *   callbackPath / callbackAuthToken) with the reply when it is ready.
   */
  mode?: "sync" | "async";
  /**
   * Port for the async callback HTTP server (default: 8765).
   * Only used when mode="async".
   */
  callbackPort?: number;
  /**
   * URL path for the async callback endpoint (default: "/callback").
   * Only used when mode="async".
   */
  callbackPath?: string;
  /**
   * Auth token that the external server must include in the Authorization header
   * when calling the callback endpoint.  When omitted, the callback endpoint is
   * unprotected (not recommended in production).
   * Only used when mode="async".
   */
  callbackAuthToken?: string;
}

export class RestReplyProvider implements ReplyProvider {
  readonly type = "rest";

  constructor(private readonly cfg: RestProviderConfig) {}

  async generateReply(req: ExternalReplyRequest): Promise<ExternalReplyResponse> {
    if (this.cfg.mode === "async") {
      return this.generateReplyAsync(req);
    }
    return this.generateReplySync(req);
  }

  // ---------------------------------------------------------------------------
  // Async mode: fire-and-forget POST, return a pendingCallbackId immediately
  // ---------------------------------------------------------------------------

  private async generateReplyAsync(req: ExternalReplyRequest): Promise<ExternalReplyResponse> {
    const requestId = generateId("cb");

    // Pre-register before the POST so the callback context is available even if the
    // external server calls back before (or concurrently with) the HTTP ACK.
    req.onAsyncRequestId?.(requestId);

    const payload = this.buildRequestBody(req, requestId);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.authToken?.trim()) {
      const headerName = this.cfg.authHeader?.trim() || "Authorization";
      headers[headerName] = this.cfg.authToken.trim();
    }

    logger.debug(
      `[external-rest/async] POST ${this.cfg.endpoint} requestId=${requestId}`,
    );

    // Fire and forget — we only wait long enough to confirm the server accepted the request.
    // Use the full configured timeoutMs (no arbitrary cap) so that user-configured values
    // such as timeoutMs:30000 are fully respected.
    const controller = new AbortController();
    const ackTimeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const t = setTimeout(() => controller.abort(), ackTimeoutMs);

    try {
      const res = await fetch(this.cfg.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        logger.error(
          `[external-rest/async] HTTP ${res.status} from ${this.cfg.endpoint}: ${errText.slice(0, 200)}`,
        );
        // Ack failed — fall back to error message rather than hanging forever.
        return { text: (this.cfg.fallbackMessage ?? DEFAULT_FALLBACK_MESSAGE) + " [FB-1]" };
      }
      logger.debug(`[external-rest/async] ACK HTTP ${res.status} from ${this.cfg.endpoint}`);
      // Drain the ack response body (typically "{"ok":true}") without blocking.
      res.text().catch(() => undefined);
    } catch (err) {
      clearTimeout(t);
      if ((err as { name?: string }).name === "AbortError") {
        // ACK timed out, but the external server may have already received the POST
        // and will still call back.  Return the pending ID so no fallback is sent
        // immediately; the callback (or the registry TTL) will handle the outcome.
        logger.warn(
          `[external-rest/async] Ack timed out after ${ackTimeoutMs}ms — keeping pre-registered context, waiting for callback`,
        );
        return { pendingCallbackId: requestId };
      }
      logger.error(`[external-rest/async] Fetch error: ${String(err)}`);
      return { text: (this.cfg.fallbackMessage ?? DEFAULT_FALLBACK_MESSAGE) + " [FB-2]" };
    }

    // Return the pending callback ID so that dispatchWithExternalProvider can register
    // the send context in the callback registry.
    return { pendingCallbackId: requestId };
  }

  // ---------------------------------------------------------------------------
  // Sync mode (original behaviour)
  // ---------------------------------------------------------------------------

  private async generateReplySync(req: ExternalReplyRequest): Promise<ExternalReplyResponse> {
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fallbackMessage = this.cfg.fallbackMessage ?? DEFAULT_FALLBACK_MESSAGE;

    const payload = this.buildRequestBody(req);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.authToken?.trim()) {
      const headerName = this.cfg.authHeader?.trim() || "Authorization";
      headers[headerName] = this.cfg.authToken.trim();
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      logger.debug(
        `[external-rest] POST ${this.cfg.endpoint} format=${this.cfg.requestFormat ?? "simple"}`,
      );
      const res = await fetch(this.cfg.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(t);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        logger.error(
          `[external-rest] HTTP ${res.status} from ${this.cfg.endpoint}: ${errText.slice(0, 200)}`,
        );
        return { text: fallbackMessage + " [FB-3]" };
      }

      const rawText = await res.text();
      return this.parseResponse(rawText, fallbackMessage);
    } catch (err) {
      clearTimeout(t);
      if ((err as { name?: string }).name === "AbortError") {
        logger.error(`[external-rest] Request timed out after ${timeoutMs}ms`);
      } else {
        logger.error(`[external-rest] Fetch error: ${String(err)}`);
      }
      return { text: fallbackMessage + " [FB-4]" };
    }
  }

  private buildRequestBody(req: ExternalReplyRequest, requestId?: string): unknown {
    if (this.cfg.requestFormat === "openai") {
      return {
        model: "gpt-3.5-turbo",
        messages: [
          { role: "user", content: req.body || "(media message)" },
        ],
      };
    }
    // simple format
    return {
      from: req.from,
      body: req.body,
      contextToken: req.contextToken,
      accountId: req.accountId,
      ...(requestId ? { requestId } : {}),
      ...(req.mediaPath ? { mediaPath: req.mediaPath, mediaType: req.mediaType } : {}),
    };
  }

  private parseResponse(rawText: string, fallbackMessage: string): ExternalReplyResponse {
    if (!rawText.trim()) {
      logger.warn(`[external-rest] Empty response body`);
      return { text: fallbackMessage + " [FB-5]" };
    }
    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;

      if (this.cfg.requestFormat === "openai") {
        // OpenAI chat completions: choices[0].message.content
        const choices = parsed.choices as Array<{ message?: { content?: string } }> | undefined;
        const content = choices?.[0]?.message?.content?.trim();
        if (content) return { text: content };
        logger.warn(`[external-rest] OpenAI response has no choices[0].message.content`);
        return { text: fallbackMessage + " [FB-6]" };
      }

      // simple format: reply | text | content field
      const text = (parsed.reply ?? parsed.text ?? parsed.content) as string | undefined;
      const mediaUrl = parsed.mediaUrl as string | undefined;
      if (!text?.trim() && !mediaUrl) {
        logger.warn(
          `[external-rest] Response has no reply/text/content field: ${rawText.slice(0, 200)}`,
        );
        return { text: fallbackMessage + " [FB-7]" };
      }
      logger.debug(`[external-rest] parseResponse: textLen=${text?.trim().length ?? 0} hasMediaUrl=${Boolean(mediaUrl)}`);
      return { text: text?.trim(), mediaUrl };
    } catch {
      // Treat the response as plain text
      const text = rawText.trim();
      if (!text) return { text: fallbackMessage + " [FB-8]" };
      return { text };
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket provider
// ---------------------------------------------------------------------------

export interface WsProviderConfig {
  type: "ws";
  endpoint: string;
  /** Bearer token sent in the Authorization header on connect. */
  authToken?: string;
  /** Per-request timeout in ms (default: 30 000). */
  timeoutMs?: number;
  /** Message sent to the user when the WS server fails or times out. */
  fallbackMessage?: string;
}

export class WsReplyProvider implements ReplyProvider {
  readonly type = "ws";

  constructor(private readonly cfg: WsProviderConfig) {}

  async generateReply(req: ExternalReplyRequest): Promise<ExternalReplyResponse> {
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fallbackMessage = this.cfg.fallbackMessage ?? DEFAULT_FALLBACK_MESSAGE;

    if (typeof globalThis.WebSocket === "undefined") {
      logger.error(
        `[external-ws] global WebSocket is not available. ` +
          `Ensure you are running Node.js ≥22 or provide a polyfill.`,
      );
      return { text: fallbackMessage + " [FB-9]" };
    }

    try {
      logger.debug(`[external-ws] connecting to ${this.cfg.endpoint}`);
      const text = await this.exchangeMessage(req, timeoutMs);
      if (!text?.trim()) {
        logger.warn(`[external-ws] Empty or missing reply from server`);
        return { text: fallbackMessage + " [FB-10]" };
      }
      return { text: text.trim() };
    } catch (err) {
      logger.error(`[external-ws] Error: ${String(err)}`);
      return { text: fallbackMessage + " [FB-11]" };
    }
  }

  private exchangeMessage(
    req: ExternalReplyRequest,
    timeoutMs: number,
  ): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      // Node.js 22's native WebSocket does not support custom headers in the constructor.
      // Authentication must be embedded in the URL (e.g. ws://host/ws?token=xyz) or
      // validated server-side from the authToken field in the message payload below.
      const ws = new globalThis.WebSocket(this.cfg.endpoint);

      const t = setTimeout(() => {
        ws.close();
        reject(new Error(`WebSocket timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.onerror = (event: Event) => {
        clearTimeout(t);
        reject(new Error(`WebSocket error: ${String(event)}`));
      };

      ws.onopen = () => {
        const payload = JSON.stringify({
          type: "message",
          from: req.from,
          body: req.body,
          contextToken: req.contextToken,
          accountId: req.accountId,
          // authToken is included in the payload so the server can validate the request.
          // For URL-based auth, embed the token directly in the endpoint field
          // (e.g. "ws://localhost:8080/ws?token=your-secret-token").
          ...(this.cfg.authToken?.trim() ? { authToken: this.cfg.authToken.trim() } : {}),
          ...(req.mediaPath ? { mediaPath: req.mediaPath, mediaType: req.mediaType } : {}),
        });
        ws.send(payload);
      };

      ws.onmessage = (event: MessageEvent<unknown>) => {
        clearTimeout(t);
        ws.close();
        const raw = String(event.data ?? "");
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          resolve(
            ((parsed.text ?? parsed.reply ?? parsed.content) as string | undefined) || undefined,
          );
        } catch {
          // Treat frame as plain text
          resolve(raw || undefined);
        }
      };
    });
  }
}
