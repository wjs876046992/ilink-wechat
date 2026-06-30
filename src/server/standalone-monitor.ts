/**
 * Standalone WeChat long-poll monitor — runs without the OpenClaw gateway.
 *
 * This module is the core of the standalone server mode.  It mirrors
 * `monitorWeixinProvider` from `src/monitor/monitor.ts` but omits the
 * `waitForWeixinRuntime()` dependency so the bot can run as a plain Node.js
 * process without OpenClaw installed or running.
 *
 * Constraints / differences from the OpenClaw-hosted monitor:
 *   - A `replyProvider` (REST or WebSocket) MUST be supplied — the OpenClaw AI
 *     pipeline is not available in standalone mode.
 *   - `channelRuntime` is NOT used; auth is done via the file-based allowFrom
 *     list and inbound media is saved to `os.tmpdir()/ilink-wechat/media/`.
 *   - Status callbacks (`setStatus`) are optional; defaults to console.log.
 */

import { getUpdates, classifyFetchError } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { STALE_TOKEN_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import { restoreContextTokens } from "../messaging/inbound.js";
import { processOneMessage } from "../messaging/process-message.js";
import type { ReplyProvider } from "../providers/types.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type StandaloneMonitorOpts = {
  /** WeChat API base URL from account credentials. */
  baseUrl: string;
  /** WeChat CDN base URL from account credentials. */
  cdnBaseUrl: string;
  /** WeChat bot token from account credentials. */
  token: string;
  /** Normalized account ID (e.g. "abc123-im-bot"). */
  accountId: string;
  /** External reply provider (must be "rest" or "ws"). */
  replyProvider: ReplyProvider;
  /** AbortSignal to stop the monitor loop cleanly. */
  abortSignal?: AbortSignal;
  /** Long-poll timeout override (default: 35 000 ms). */
  longPollTimeoutMs?: number;
  /** Optional log callback; defaults to process.stdout. */
  log?: (msg: string) => void;
  /** Optional error-log callback; defaults to process.stderr. */
  errLog?: (msg: string) => void;
};

/**
 * Run the standalone WeChat long-poll monitor until `abortSignal` fires or the
 * process exits.  Never throws (errors are logged and retried).
 */
export async function runStandaloneMonitor(opts: StandaloneMonitorOpts): Promise<void> {
  const {
    baseUrl,
    cdnBaseUrl,
    token,
    accountId,
    replyProvider,
    abortSignal,
    longPollTimeoutMs,
  } = opts;

  const log = opts.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const errLog = opts.errLog ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const aLog = logger.withAccount(accountId);

  restoreContextTokens(accountId);

  log(`[ilink-wechat] standalone monitor started — account=${accountId} provider=${replyProvider.type}`);
  aLog.info(`standalone monitor started: baseUrl=${baseUrl} provider=${replyProvider.type}`);

  const syncFilePath = getSyncBufFilePath(accountId);
  const previousBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousBuf ?? "";

  if (previousBuf) {
    aLog.debug(`resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  }

  // Minimal OpenClawConfig stub — only the provider section is needed; auth
  // is handled directly by processOneMessage in standalone mode.  The config
  // object is only passed through so processOneMessage can forward it to the
  // OpenClaw path, which is never reached in standalone mode (the replyProvider
  // branch returns early before any config property is accessed).
  const configStub = {} as import("openclaw/plugin-sdk/core").OpenClawConfig;

  const configManager = new WeixinConfigManager({ baseUrl, token }, log);

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE;

        if (isSessionExpired) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          errLog(
            `[ilink-wechat] session expired (errcode ${STALE_TOKEN_ERRCODE}), pausing ${Math.ceil(pauseMs / 60_000)} min`,
          );
          aLog.error(`standalone: session expired, pausing ${Math.ceil(pauseMs / 60_000)} min`);
          consecutiveFailures = 0;
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        errLog(
          `[ilink-wechat] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        aLog.error(
          `standalone getUpdates failed: ${redactBody(JSON.stringify(resp))}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(`[ilink-wechat] backing off 30s after ${MAX_CONSECUTIVE_FAILURES} failures`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;
      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      for (const full of resp.msgs ?? []) {
        aLog.info(
          `inbound: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
        );

        const fromUserId = full.from_user_id ?? "";
        const cachedConfig = await configManager.getForUser(fromUserId, full.context_token);

        await processOneMessage(full, {
          accountId,
          config: configStub,
          // channelRuntime is intentionally omitted — standalone path is used.
          baseUrl,
          cdnBaseUrl,
          token,
          typingTicket: cachedConfig.typingTicket,
          log,
          errLog,
          replyProvider,
        });
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        aLog.info(`standalone monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      const classified = classifyFetchError(err);
      errLog(
        `[ilink-wechat] error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""}`,
      );
      aLog.error(`standalone loop error: ${String(err)}, type=${classified.type} code=${classified.code ?? "none"}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  aLog.info(`standalone monitor ended`);
  log(`[ilink-wechat] monitor stopped`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
