/**
 * Standalone callback HTTP server.
 *
 * Listens for POST requests from the external server and forwards the reply to
 * the WeChat user via sendMessageWeixin.
 *
 * Expected request format (POST <callbackPath>):
 *   Content-Type: application/json
 *   Authorization: <callbackAuthToken>   (optional, when configured)
 *
 *   {
 *     "requestId": "<id returned in the original POST to the external server>",
 *     "text": "Reply text to send to the user",
 *     "mediaUrl": "optional — single media URL (backward compatible)",
 *     "mediaUrls": ["optional", "array of media URLs for multi-file support"]
 *   }
 *
 * Response:
 *   200 OK:   { "ok": true }
 *   400:      { "ok": false, "error": "..." }  — malformed body
 *   401:      { "ok": false, "error": "unauthorized" }
 *   404:      { "ok": false, "error": "unknown or expired requestId" }
 *   405:      { "ok": false, "error": "method not allowed" }
 *   500:      { "ok": false, "error": "..." }  — internal error
 */

import http from "node:http";
import path from "node:path";

import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";

import { callbackRegistry } from "../providers/callback-registry.js";
import { sendMessageWeixin } from "../messaging/send.js";
import { sendWeixinMediaFile } from "../messaging/send-media.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { logger } from "../util/logger.js";

const MEDIA_OUTBOUND_TEMP_DIR = path.join(resolvePreferredOpenClawTmpDir(), "weixin/media/outbound-temp");

/** Returns true when mediaUrl refers to a local filesystem path (absolute or relative). */
function isLocalFilePath(mediaUrl: string): boolean {
  return !mediaUrl.includes("://");
}

/** Resolve the effective filePath from a mediaUrl. */
function resolveMediaFilePath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) return new URL(mediaUrl).pathname;
  if (!path.isAbsolute(mediaUrl)) return path.resolve(mediaUrl);
  return mediaUrl;
}

export type CallbackServerConfig = {
  /** Port to listen on (default: 8765). */
  port?: number;
  /** URL path to accept callbacks on (default: "/callback"). */
  path?: string;
  /**
   * When set, every request must include "Authorization: <callbackAuthToken>" header.
   * Requests without this header receive 401.
   */
  authToken?: string;
};

export type CallbackServerHandle = {
  close(): Promise<void>;
};

const DEFAULT_PORT = 8765;
const DEFAULT_PATH = "/callback";

/**
 * Start the callback HTTP server.  Returns a handle that can be used to shut it down.
 */
export function startCallbackServer(cfg: CallbackServerConfig = {}): CallbackServerHandle {
  const port = cfg.port ?? DEFAULT_PORT;
  const cbPath = cfg.path ?? DEFAULT_PATH;
  const authToken = cfg.authToken?.trim() || undefined;

  // Periodically clean up expired registry entries (every minute).
  const cleanupInterval = setInterval(() => callbackRegistry.cleanup(), 60_000);

  const server = http.createServer((req, res) => {
    const respond = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    // Only accept POST on the configured path.
    if (req.method !== "POST") {
      respond(405, { ok: false, error: "method not allowed" });
      return;
    }
    if (req.url?.split("?")[0] !== cbPath) {
      respond(404, { ok: false, error: "not found" });
      return;
    }

    // Auth check.
    if (authToken) {
      const incoming = req.headers["authorization"]?.trim() ?? "";
      if (incoming !== authToken) {
        respond(401, { ok: false, error: "unauthorized" });
        return;
      }
      logger.debug(`[callback-server] auth OK`);
    }

    // Read body.
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
      } catch {
        respond(400, { ok: false, error: "invalid JSON body" });
        return;
      }
      logger.debug(`[callback-server] body parsed: keys=[${Object.keys(body).join(",")}]`);

      const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
      if (!requestId) {
        respond(400, { ok: false, error: "missing requestId" });
        return;
      }

      const replyText = typeof body.text === "string" ? body.text.trim() : "";
      const mediaUrl = typeof body.mediaUrl === "string" ? body.mediaUrl.trim() : "";
      // 支持 mediaUrls 数组（多图/多文件）
      const mediaUrlsRaw = Array.isArray(body.mediaUrls) ? body.mediaUrls : [];
      const mediaUrls = mediaUrlsRaw.filter((u: unknown): u is string => typeof u === "string" && u.trim() !== "");
      // 合并为统一的列表：mediaUrl 优先，然后 mediaUrls
      const allMediaUrls = mediaUrl ? [mediaUrl, ...mediaUrls] : mediaUrls;

      if (!replyText && allMediaUrls.length === 0) {
        respond(400, { ok: false, error: "text or mediaUrl(s) is required" });
        return;
      }

      logger.debug(
        `[callback-server] looking up requestId=${requestId} registry_size=${callbackRegistry.size()}`,
      );
      const ctx = callbackRegistry.get(requestId);
      if (!ctx) {
        logger.warn(`[callback-server] unknown or expired requestId=${requestId}`);
        respond(404, { ok: false, error: "unknown or expired requestId" });
        return;
      }

      logger.info(
        `[callback-server] delivering async reply: requestId=${requestId} to=${ctx.to} textLen=${replyText.length} mediaCount=${allMediaUrls.length}`,
      );

      // Fire-and-forget: send the reply to WeChat.
      Promise.resolve()
        .then(async () => {
          const sendOpts = {
            baseUrl: ctx.baseUrl,
            token: ctx.token,
            contextToken: ctx.contextToken,
          };

          if (allMediaUrls.length > 0) {
            for (let i = 0; i < allMediaUrls.length; i++) {
              const url = allMediaUrls[i];
              // 只在第一条媒体附带文本 caption
              const caption = i === 0 ? (replyText || "") : "";

              let filePath: string;
              if (isLocalFilePath(url)) {
                filePath = resolveMediaFilePath(url);
                logger.debug(`[callback-server] local media file=${filePath}`);
              } else if (url.startsWith("http://") || url.startsWith("https://")) {
                logger.debug(`[callback-server] downloading remote media=${url.slice(0, 80)}`);
                filePath = await downloadRemoteImageToTemp(url, MEDIA_OUTBOUND_TEMP_DIR);
                logger.debug(`[callback-server] remote media downloaded to=${filePath}`);
              } else {
                logger.warn(`[callback-server] unsupported mediaUrl scheme: ${url.slice(0, 80)}, skipping`);
                continue;
              }

              await sendWeixinMediaFile({
                filePath,
                to: ctx.to,
                text: caption,
                opts: sendOpts,
                cdnBaseUrl: ctx.cdnBaseUrl,
              });
              logger.info(`[callback-server] media[${i + 1}/${allMediaUrls.length}] sent OK to=${ctx.to} requestId=${requestId}`);
            }
          } else if (replyText) {
            // Text-only reply
            await sendMessageWeixin({
              to: ctx.to,
              text: replyText,
              opts: sendOpts,
            });
            logger.info(`[callback-server] text sent OK to=${ctx.to} requestId=${requestId}`);
          }
        })
        .catch((err: unknown) => {
          logger.error(`[callback-server] failed to send reply to=${ctx.to}: ${String(err)}`);
        });

      respond(200, { ok: true });
    });

    req.on("error", (err: Error) => {
      logger.error(`[callback-server] request error: ${String(err)}`);
    });
  });

  server.listen(port, () => {
    logger.info(`[callback-server] listening on port ${port} path=${cbPath}`);
    process.stdout.write(
      `   callback: http://0.0.0.0:${port}${cbPath}\n`,
    );
  });

  return {
    close(): Promise<void> {
      clearInterval(cleanupInterval);
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
