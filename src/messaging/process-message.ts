import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-runtime";
import {
  resolveSenderCommandAuthorizationWithRuntime,
  resolveDirectDmAuthorizationOutcome,
} from "openclaw/plugin-sdk/command-auth";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { sendTyping } from "../api/api.js";
import type { WeixinMessage } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { loadWeixinAccount } from "../auth/accounts.js";
import { readFrameworkAllowFromList } from "../auth/pairing.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { resolveReplyProgressMessagesEnabled } from "../config/reply-progress.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { callbackRegistry, DEFAULT_CALLBACK_TIMEOUT_MS, DEFAULT_CALLBACK_TIMEOUT_MESSAGE } from "../providers/callback-registry.js";
import type { ReplyProvider } from "../providers/types.js";
import { logger } from "../util/logger.js";
import { redactBody, redactToken } from "../util/redact.js";

import { isDebugMode } from "./debug-mode.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { applyWeixinMessageSendingHook, emitWeixinMessageSent } from "./outbound-hooks.js";
import {
  setContextToken,
  weixinMessageToMsgContext,
  getContextTokenFromMsgContext,
  isMediaItem,
} from "./inbound.js";
import type { WeixinInboundMediaOpts } from "./inbound.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { StreamingMarkdownFilter } from "./markdown-filter.js";
import { sendMessageWeixin } from "./send.js";
import { WeixinReplyProgressSender } from "./reply-progress-sender.js";
import { handleSlashCommand } from "./slash-commands.js";

const MEDIA_OUTBOUND_TEMP_DIR = path.join(resolvePreferredOpenClawTmpDir(), "weixin/media/outbound-temp");

/** Dependencies for processOneMessage, injected by the monitor loop. */
export type ProcessMessageDeps = {
  accountId: string;
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  /**
   * OpenClaw channel runtime. Required for the default OpenClaw AI dispatch path.
   * When `replyProvider` is set and this is undefined, the standalone path is used
   * (no OpenClaw gateway required).
   */
  channelRuntime?: PluginRuntime["channel"];
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (m: string) => void;
  /**
   * When set, the external provider is used to generate replies instead of the
   * default OpenClaw agent pipeline (dispatchReplyFromConfig).
   * Configure via channels.openclaw-weixin.provider in openclaw.json.
   */
  replyProvider?: ReplyProvider;
  /** Callback timeout in ms (default: 300000 = 5 minutes). Set to 0 to disable. */
  callbackTimeoutMs?: number;
  /** Message sent when callback times out. */
  callbackTimeoutMessage?: string;
};

/** Extract text body from item_list (for slash command detection). */
function extractTextBody(itemList?: import("../api/types.js").MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/**
 * Standalone fallback for saving inbound media when the OpenClaw channel runtime
 * is not available.  Files are written to <os.tmpdir()>/ilink-wechat/media/<subdir>/.
 */
async function standaloneMediaSave(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  const dir = path.join(os.tmpdir(), "ilink-wechat", "media", subdir ?? "inbound");
  fs.mkdirSync(dir, { recursive: true });

  let ext = "bin";
  if (originalFilename) {
    const dot = originalFilename.lastIndexOf(".");
    if (dot >= 0) ext = originalFilename.slice(dot + 1);
  } else if (contentType) {
    // "image/jpeg; charset=…" → "jpeg"
    const bare = contentType.split(";")[0].trim();
    const slash = bare.indexOf("/");
    ext = (slash >= 0 ? bare.slice(slash + 1) : bare).split("+")[0] || "bin";
  }

  if (maxBytes != null && buffer.length > maxBytes) {
    throw new Error(`standaloneMediaSave: media too large (${buffer.length} > ${maxBytes} bytes)`);
  }

  const filename = `${Date.now()}-${randomBytes(8).toString("hex")}.${ext}`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
  logger.debug(`standaloneMediaSave: saved ${buffer.length}B to ${filePath}`);
  return { path: filePath };
}

// ---------------------------------------------------------------------------
// External provider dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a reply via an external REST or WebSocket provider.
 * Called instead of the OpenClaw dispatchReplyFromConfig path when
 * deps.replyProvider is set.
 */
async function dispatchWithExternalProvider(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
  mediaOpts: WeixinInboundMediaOpts,
  contextToken: string | undefined,
): Promise<void> {
  if (!deps.replyProvider) return;

  const to = full.from_user_id ?? "";
  const body = full.item_list ? extractTextBody(full.item_list) : "";

  logger.info(
    `[external-provider] dispatch: provider=${deps.replyProvider.type} to=${to} bodyLen=${body.length} hasMedia=${Boolean(mediaOpts.decryptedPicPath ?? mediaOpts.decryptedVideoPath ?? mediaOpts.decryptedFilePath ?? mediaOpts.decryptedVoicePath)}`,
  );

  // Determine the local media path (first available type, same priority as inbound)
  const mediaPath =
    mediaOpts.decryptedPicPath ??
    mediaOpts.decryptedVideoPath ??
    mediaOpts.decryptedFilePath ??
    mediaOpts.decryptedVoicePath;
  const mediaType = mediaOpts.decryptedPicPath
    ? "image/*"
    : mediaOpts.decryptedVideoPath
      ? "video/mp4"
      : mediaOpts.decryptedFilePath
        ? (mediaOpts.fileMediaType ?? "application/octet-stream")
        : mediaOpts.decryptedVoicePath
          ? (mediaOpts.voiceMediaType ?? "audio/wav")
          : undefined;

  // Start typing indicator (fire-and-forget)
  if (deps.typingTicket) {
    sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: { ilink_user_id: to, typing_ticket: deps.typingTicket, status: TypingStatus.TYPING },
    }).catch((err: unknown) => deps.log(`[weixin] typing start error: ${String(err)}`));
  }

  let response: import("../providers/types.js").ExternalReplyResponse;
  // Tracks whether the provider already pre-registered the callback context via
  // onAsyncRequestId (REST async mode).  When true the registration block below
  // is skipped to avoid an unnecessary overwrite.
  let asyncContextPreRegistered = false;
  // The requestId surfaced by onAsyncRequestId, kept so we can clean up the
  // pre-registered entry when the provider returns an error response instead of
  // a pendingCallbackId (e.g. non-2xx ACK or network failure).
  let preRegisteredRequestId: string | undefined;
  try {
    response = await deps.replyProvider.generateReply({
      from: to,
      body,
      contextToken,
      mediaPath,
      mediaType,
      accountId: deps.accountId,
      // Pre-register the callback context before the POST is dispatched so that an
      // external server that calls back before (or concurrently with) the HTTP ACK
      // still finds the context in the registry.
      onAsyncRequestId: (requestId) => {
        asyncContextPreRegistered = true;
        preRegisteredRequestId = requestId;

        // Calculate effective timeout
        const timeoutMs = deps.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
        const timeoutMessage = deps.callbackTimeoutMessage ?? DEFAULT_CALLBACK_TIMEOUT_MESSAGE;

        callbackRegistry.register(
          requestId,
          {
            to,
            baseUrl: deps.baseUrl,
            token: deps.token ?? "",
            contextToken,
            accountId: deps.accountId,
            cdnBaseUrl: deps.cdnBaseUrl,
          },
          timeoutMs > 0 ? timeoutMs : undefined,
          timeoutMs > 0
            ? () => {
                logger.info(
                  `[external-provider] async mode: timeout notification sent requestId=${requestId} to=${to}`,
                );
                // Send timeout notification to user
                sendMessageWeixin({
                  to,
                  text: timeoutMessage,
                  opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
                }).catch((err: unknown) => {
                  logger.error(`[external-provider] timeout notification failed: ${String(err)}`);
                });
              }
            : undefined,
        );
        logger.info(
          `[external-provider] async mode: pre-registered callback context requestId=${requestId} to=${to} timeoutMs=${timeoutMs}`,
        );
      },
    });
  } catch (err) {
    logger.error(`[external-provider] generateReply threw: ${String(err)}`);
    response = { text: "⚠️ 消息处理失败，请稍后再试。" };
  } finally {
    // Stop typing indicator (fire-and-forget)
    if (deps.typingTicket) {
      sendTyping({
        baseUrl: deps.baseUrl,
        token: deps.token,
        body: { ilink_user_id: to, typing_ticket: deps.typingTicket, status: TypingStatus.CANCEL },
      }).catch((err: unknown) => deps.log(`[weixin] typing stop error: ${String(err)}`));
    }
  }

  logger.debug(
    `[external-provider] response: text=${response.text != null ? `len=${response.text.length}` : "none"} mediaUrl=${response.mediaUrl ? "present" : "none"} pendingCallbackId=${response.pendingCallbackId ?? "none"}`,
  );

  // If the provider pre-registered a context but then returned an error response
  // (e.g. non-2xx ACK or network failure) instead of a pendingCallbackId, remove
  // the orphaned registry entry.  This prevents a future spurious reply if the
  // external server somehow still calls back after we have already sent the fallback.
  if (asyncContextPreRegistered && !response.pendingCallbackId && preRegisteredRequestId) {
    callbackRegistry.remove(preRegisteredRequestId);
    logger.info(
      `[external-provider] async mode: removed pre-registered context after error requestId=${preRegisteredRequestId}`,
    );
  }

  // Async callback mode: the external server has acknowledged the request.
  // Register the WeChat send-context so the callback server can deliver the reply later
  // (skipped when already pre-registered via onAsyncRequestId above).
  if (response.pendingCallbackId) {
    if (!asyncContextPreRegistered) {
      // Calculate effective timeout
      const timeoutMs = deps.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
      const timeoutMessage = deps.callbackTimeoutMessage ?? DEFAULT_CALLBACK_TIMEOUT_MESSAGE;

      callbackRegistry.register(
        response.pendingCallbackId,
        {
          to,
          baseUrl: deps.baseUrl,
          token: deps.token ?? "",
          contextToken,
          accountId: deps.accountId,
          cdnBaseUrl: deps.cdnBaseUrl,
        },
        timeoutMs > 0 ? timeoutMs : undefined,
        timeoutMs > 0
          ? () => {
              logger.info(
                `[external-provider] async mode: timeout notification sent requestId=${response.pendingCallbackId} to=${to}`,
              );
              // Send timeout notification to user
              sendMessageWeixin({
                to,
                text: timeoutMessage,
                opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
              }).catch((err: unknown) => {
                logger.error(`[external-provider] timeout notification failed: ${String(err)}`);
              });
            }
          : undefined,
      );
    }
    logger.info(
      `[external-provider] async mode: registered pending callback requestId=${response.pendingCallbackId} to=${to} timeoutMs=${deps.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS}`,
    );
    return;
  }

  const replyText = response.text?.trim() ?? "";
  const replyMediaUrl = response.mediaUrl?.trim() ?? "";

  if (!replyText && !replyMediaUrl) {
    logger.info(`[external-provider] provider returned empty reply, nothing to send`);
    return;
  }

  // Apply markdown filter (same as OpenClaw path)
  const filteredText = (() => {
    const f = new StreamingMarkdownFilter();
    return f.feed(replyText) + f.flush();
  })();

  const sendOpts = { baseUrl: deps.baseUrl, token: deps.token, contextToken };

  // Apply outbound hook (message_sending)
  const sendingResult = await applyWeixinMessageSendingHook({
    to,
    text: filteredText,
    accountId: deps.accountId,
    mediaUrl: replyMediaUrl,
  });
  if (sendingResult.cancelled) {
    logger.info(`[external-provider] outbound: cancelled by message_sending hook to=${to}`);
    return;
  }
  const hookedText = sendingResult.text;

  try {
    if (replyMediaUrl) {
      let filePath: string;
      if (!replyMediaUrl.includes("://") || replyMediaUrl.startsWith("file://")) {
        filePath = replyMediaUrl.startsWith("file://")
          ? new URL(replyMediaUrl).pathname
          : !path.isAbsolute(replyMediaUrl)
            ? path.resolve(replyMediaUrl)
            : replyMediaUrl;
        logger.debug(`[external-provider] outbound local file=${filePath}`);
      } else if (replyMediaUrl.startsWith("http://") || replyMediaUrl.startsWith("https://")) {
        logger.debug(`[external-provider] downloading remote mediaUrl=${replyMediaUrl.slice(0, 80)}`);
        filePath = await downloadRemoteImageToTemp(replyMediaUrl, MEDIA_OUTBOUND_TEMP_DIR);
        logger.debug(`[external-provider] remote image downloaded to ${filePath}`);
      } else {
        logger.warn(`[external-provider] unrecognised mediaUrl scheme, falling back to text-only`);
        await sendMessageWeixin({ to, text: hookedText, opts: sendOpts });
        void emitWeixinMessageSent({ to, content: hookedText, success: true, accountId: deps.accountId });
        return;
      }
      await sendWeixinMediaFile({
        filePath,
        to,
        text: hookedText,
        opts: sendOpts,
        cdnBaseUrl: deps.cdnBaseUrl,
      });
      void emitWeixinMessageSent({ to, content: hookedText, success: true, accountId: deps.accountId });
      logger.info(`[external-provider] media sent OK to=${to}`);
    } else {
      await sendMessageWeixin({ to, text: hookedText, opts: sendOpts });
      void emitWeixinMessageSent({ to, content: hookedText, success: true, accountId: deps.accountId });
      logger.info(`[external-provider] text sent OK to=${to}`);
    }
  } catch (err) {
    logger.error(`[external-provider] send FAILED to=${to} err=${String(err)}`);
    void emitWeixinMessageSent({ to, content: hookedText, success: false, error: String(err), accountId: deps.accountId });
    const errMsg = err instanceof Error ? err.message : String(err);
    await sendWeixinErrorNotice({
      to,
      contextToken,
      message: `⚠️ 消息发送失败：${errMsg}`,
      baseUrl: deps.baseUrl,
      token: deps.token,
      errLog: deps.errLog,
    });
  }
}

/**
 * Process a single inbound message: route → download media → dispatch reply.
 * Extracted from the monitor loop to keep monitoring and message handling separate.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  if (!deps?.channelRuntime && !deps.replyProvider) {
    logger.error(
      `processOneMessage: channelRuntime is undefined and no replyProvider set, skipping message from=${full.from_user_id}`,
    );
    deps.errLog("processOneMessage: no channelRuntime and no replyProvider, skip");
    return;
  }

  const receivedAt = Date.now();
  const debug = isDebugMode(deps.accountId);
  const debugTrace: string[] = [];
  const debugTs: Record<string, number> = { received: receivedAt };

  const textBody = extractTextBody(full.item_list);
  logger.debug(
    `[process] received: msgId=${full.message_id ?? "?"} seq=${full.seq ?? "?"} from=${full.from_user_id ?? "?"} bodyLen=${textBody.length} itemTypes=[${full.item_list?.map((i) => i.type).join(",") ?? "none"}]`,
  );
  if (textBody.startsWith("/")) {
    const slashResult = await handleSlashCommand(textBody, {
      to: full.from_user_id ?? "",
      contextToken: full.context_token,
      baseUrl: deps.baseUrl,
      token: deps.token,
      accountId: deps.accountId,
      log: deps.log,
      errLog: deps.errLog,
    }, receivedAt, full.create_time_ms);
    if (slashResult.handled) {
      logger.info(`[weixin] Slash command handled, skipping AI pipeline`);
      return;
    }
  }

  if (debug) {
    const itemTypes = full.item_list?.map((i) => i.type).join(",") ?? "none";
    debugTrace.push(
      "── 收消息 ──",
      `│ seq=${full.seq ?? "?"} msgId=${full.message_id ?? "?"} from=${full.from_user_id ?? "?"}`,
      `│ body="${textBody.slice(0, 40)}${textBody.length > 40 ? "…" : ""}" (len=${textBody.length}) itemTypes=[${itemTypes}]`,
      `│ sessionId=${full.session_id ?? "?"} contextToken=${full.context_token ? "present" : "none"}`,
    );
  }

  const mediaOpts: WeixinInboundMediaOpts = {};

  // Find the first downloadable media item (priority: IMAGE > VIDEO > FILE > VOICE).
  // When none found in the main item_list, fall back to media referenced via a quoted message.
  const hasDownloadableMedia = (m?: { encrypt_query_param?: string; full_url?: string }) =>
    m?.encrypt_query_param || m?.full_url;
  const mainMediaItem =
    full.item_list?.find(
      (i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media),
    ) ??
    full.item_list?.find(
      (i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media),
    ) ??
    full.item_list?.find(
      (i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media),
    ) ??
    full.item_list?.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        hasDownloadableMedia(i.voice_item?.media) &&
        !i.voice_item?.text,
    );
  const refMediaItem = !mainMediaItem
    ? full.item_list?.find(
        (i) =>
          i.type === MessageItemType.TEXT &&
          i.ref_msg?.message_item &&
          isMediaItem(i.ref_msg.message_item!),
      )?.ref_msg?.message_item
    : undefined;

  const mediaDownloadStart = Date.now();
  const mediaItem = mainMediaItem ?? refMediaItem;
  if (mediaItem) {
    const label = refMediaItem ? "ref" : "inbound";
    logger.debug(`[process] mediaItem found: type=${mediaItem.type} label=${label}`);
    // Standalone mode uses a simple temp-dir save when channelRuntime is unavailable.
    const saveMedia = deps.channelRuntime?.media.saveMediaBuffer ?? standaloneMediaSave;
    const downloaded = await downloadMediaFromItem(mediaItem, {
      cdnBaseUrl: deps.cdnBaseUrl,
      saveMedia,
      log: deps.log,
      errLog: deps.errLog,
      label,
    });
    Object.assign(mediaOpts, downloaded);
  }
  const mediaDownloadMs = Date.now() - mediaDownloadStart;
  logger.debug(`[process] mediaDownload: found=${Boolean(mediaItem)} cost=${mediaDownloadMs}ms`);

  if (debug) {
    debugTrace.push(mediaItem
      ? `│ mediaDownload: type=${mediaItem.type} cost=${mediaDownloadMs}ms`
      : "│ mediaDownload: none",
    );
  }

  const ctx = weixinMessageToMsgContext(full, deps.accountId, mediaOpts);

  // --- Authorization ---
  const rawBody = ctx.Body?.trim() ?? "";
  ctx.CommandBody = rawBody;

  const senderId = full.from_user_id ?? "";

  let senderAllowedForCommands: boolean;
  let commandAuthorized: boolean;

  if (deps.channelRuntime) {
    // Full OpenClaw authorization pipeline (framework command auth + pairing).
    ({ senderAllowedForCommands, commandAuthorized } =
      await resolveSenderCommandAuthorizationWithRuntime({
        cfg: deps.config,
        rawBody,
        isGroup: false,
        dmPolicy: "pairing",
        configuredAllowFrom: [],
        configuredGroupAllowFrom: [],
        senderId,
        isSenderAllowed: (id: string, list: string[]) => list.length === 0 || list.includes(id),
        /** Pairing: framework credentials `*-allowFrom.json`, with account `userId` fallback for legacy installs. */
        readAllowFromStore: async () => {
          const fromStore = readFrameworkAllowFromList(deps.accountId);
          if (fromStore.length > 0) return fromStore;
          const uid = loadWeixinAccount(deps.accountId)?.userId?.trim();
          return uid ? [uid] : [];
        },
        runtime: deps.channelRuntime.commands,
      }));

    const directDmOutcome = resolveDirectDmAuthorizationOutcome({
      isGroup: false,
      dmPolicy: "pairing",
      senderAllowedForCommands,
    });

    if (directDmOutcome === "disabled" || directDmOutcome === "unauthorized") {
      logger.info(
        `authorization: dropping message from=${senderId} outcome=${directDmOutcome}`,
      );
      return;
    }
  } else {
    // Standalone mode: simple file-based allowFrom list (no OpenClaw runtime).
    const allowFrom = readFrameworkAllowFromList(deps.accountId);
    const fallbackUserId = loadWeixinAccount(deps.accountId)?.userId?.trim();
    let effectiveList: string[];
    if (allowFrom.length > 0) {
      effectiveList = allowFrom;
    } else if (fallbackUserId) {
      effectiveList = [fallbackUserId];
    } else {
      effectiveList = [];
    }
    senderAllowedForCommands = effectiveList.length === 0 || effectiveList.includes(senderId);
    commandAuthorized = senderAllowedForCommands;
    if (!senderAllowedForCommands) {
      logger.info(`standalone auth: dropping message from=${senderId} (not in allowFrom)`);
      return;
    }
  }

  ctx.CommandAuthorized = commandAuthorized;
  logger.debug(
    `authorization: senderId=${senderId} commandAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowedForCommands)}`,
  );

  // Always persist the context token regardless of dispatch path
  const contextToken = getContextTokenFromMsgContext(ctx);
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
  }

  // -------------------------------------------------------------------------
  // External provider path — bypasses OpenClaw route/session/dispatch
  // -------------------------------------------------------------------------
  if (deps.replyProvider) {
    if (debug) {
      debugTrace.push(
        "── 鉴权 & 路由 ──",
        `│ auth: cmdAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowedForCommands)}`,
        `│ route: external provider=${deps.replyProvider.type}`,
      );
    }
    await dispatchWithExternalProvider(full, deps, mediaOpts, contextToken);
    if (debug && contextToken) {
      const dispatchDoneAt = Date.now();
      const eventTs = full.create_time_ms ?? 0;
      debugTrace.push(
        "── 耗时 ──",
        `├ 平台→插件: ${eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A"}`,
        `├ 总耗时: ${eventTs > 0 ? `${dispatchDoneAt - eventTs}ms` : `${dispatchDoneAt - receivedAt}ms`}`,
        `└ provider: ${deps.replyProvider.type}`,
      );
      try {
        await sendMessageWeixin({
          to: full.from_user_id ?? "",
          text: `⏱ Debug 全链路\n${debugTrace.join("\n")}`,
          opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
        });
      } catch (debugErr) {
        logger.error(`debug-timing: send FAILED err=${String(debugErr)}`);
      }
    }
    return;
  }

  // -------------------------------------------------------------------------
  // OpenClaw dispatch path (default) — channelRuntime must be present here.
  // -------------------------------------------------------------------------

  // Unreachable in standalone mode (replyProvider would have returned above).
  // TypeScript guard to keep the type system happy.
  if (!deps.channelRuntime) {
    logger.error("processOneMessage: reached OpenClaw path without channelRuntime — should not happen");
    return;
  }

  if (debug) {
    debugTrace.push(
      "── 鉴权 & 路由 ──",
      `│ auth: cmdAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowedForCommands)}`,
    );
  }

  const route = deps.channelRuntime.routing.resolveAgentRoute({
    cfg: deps.config,
    channel: "openclaw-weixin",
    accountId: deps.accountId,
    peer: { kind: "direct", id: ctx.To },
  });
  logger.debug(
    `resolveAgentRoute: agentId=${route.agentId ?? "(none)"} sessionKey=${route.sessionKey ?? "(none)"} mainSessionKey=${route.mainSessionKey ?? "(none)"}`,
  );
  if (!route.agentId) {
    logger.error(
      `resolveAgentRoute: no agentId resolved for peer=${ctx.To} accountId=${deps.accountId} — message will not be dispatched`,
    );
  }

  if (debug) {
    debugTrace.push(
      `│ route: agent=${route.agentId ?? "none"} session=${route.sessionKey ?? "none"}`,
    );
    debugTs.preDispatch = Date.now();
  }
  // Propagate the resolved session key into ctx so dispatchReplyFromConfig uses
  // the correct session (matching the dmScope from config) instead of falling back
  // to agent:main:main.
  ctx.SessionKey = route.sessionKey;
  const storePath = deps.channelRuntime.session.resolveStorePath(deps.config.session?.store, {
    agentId: route.agentId,
  });
  const finalized = deps.channelRuntime.reply.finalizeInboundContext(
    ctx as Parameters<typeof deps.channelRuntime.reply.finalizeInboundContext>[0],
  );

  logger.info(
    `inbound: from=${finalized.From} to=${finalized.To} bodyLen=${(finalized.Body ?? "").length} hasMedia=${Boolean(finalized.MediaPath ?? finalized.MediaUrl)}`,
  );
  logger.debug(`inbound context: ${redactBody(JSON.stringify(finalized))}`);

  await deps.channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: finalized as Parameters<typeof deps.channelRuntime.session.recordInboundSession>[0]["ctx"],
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: "openclaw-weixin",
      to: ctx.To,
      accountId: deps.accountId,
    },
    onRecordError: (err) => deps.errLog(`recordInboundSession: ${String(err)}`),
  });
  logger.debug(
    `recordInboundSession: done storePath=${storePath} sessionKey=${route.sessionKey ?? "(none)"}`,
  );

  // contextToken was already obtained and persisted above, before the provider branch.
  // Re-use it here for the OpenClaw path without re-declaring.
  const runId = randomUUID();
  const replyProgressSender = resolveReplyProgressMessagesEnabled(deps.config)
    ? new WeixinReplyProgressSender({
        runId,
        to: ctx.To,
        accountId: deps.accountId,
        opts: {
          baseUrl: deps.baseUrl,
          token: deps.token,
          contextToken,
        },
      })
    : undefined;
  const humanDelay = deps.channelRuntime.reply.resolveHumanDelayConfig(deps.config, route.agentId);

  const hasTypingTicket = Boolean(deps.typingTicket);
  const typingCallbacks = createTypingCallbacks({
    start: hasTypingTicket
      ? () =>
          sendTyping({
            baseUrl: deps.baseUrl,
            token: deps.token,
            body: {
              ilink_user_id: ctx.To,
              typing_ticket: deps.typingTicket!,
              status: TypingStatus.TYPING,
            },
          })
      : async () => {},
    stop: hasTypingTicket
      ? () =>
          sendTyping({
            baseUrl: deps.baseUrl,
            token: deps.token,
            body: {
              ilink_user_id: ctx.To,
              typing_ticket: deps.typingTicket!,
              status: TypingStatus.CANCEL,
            },
          })
      : async () => {},
    onStartError: (err) => deps.log(`[weixin] typing send error: ${String(err)}`),
    onStopError: (err) => deps.log(`[weixin] typing cancel error: ${String(err)}`),
    keepaliveIntervalMs: 5000,
  });

  /** Delivery records populated synchronously at deliver() entry, safe to read in finally. */
  const debugDeliveries: Array<{ textLen: number; media: string; preview: string; ts: number }> = [];

  const { dispatcher, replyOptions, markDispatchIdle } =
    deps.channelRuntime.reply.createReplyDispatcherWithTyping({
      humanDelay,
      typingCallbacks,
      deliver: async (payload) => {
        const rawText = payload.text ?? "";
        let text = (() => {
          const f = new StreamingMarkdownFilter();
          return f.feed(rawText) + f.flush();
        })();
        const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
        logger.debug(`outbound payload: ${redactBody(JSON.stringify(payload))}`);
        logger.info(
          `outbound: to=${ctx.To} contextToken=${redactToken(contextToken)} textLen=${text.length} mediaUrl=${mediaUrl ? "present" : "none"}`,
        );

        if (debug) {
          debugDeliveries.push({
            textLen: text.length,
            media: mediaUrl ? "present" : "none",
            preview: `${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`,
            ts: Date.now(),
          });
        }

        // Apply outbound hook (message_sending)
        const sendingResult = await applyWeixinMessageSendingHook({
          to: ctx.To,
          text,
          accountId: deps.accountId,
          mediaUrl,
          runId,
        });
        if (sendingResult.cancelled) {
          logger.info(`outbound: cancelled by message_sending hook to=${ctx.To}`);
          return;
        }
        text = sendingResult.text;

        try {
          if (mediaUrl) {
            let filePath: string;
            if (!mediaUrl.includes("://") || mediaUrl.startsWith("file://")) {
              // Local path: absolute, relative, or file:// URL
              if (mediaUrl.startsWith("file://")) {
                filePath = new URL(mediaUrl).pathname;
              } else if (!path.isAbsolute(mediaUrl)) {
                filePath = path.resolve(mediaUrl);
                logger.debug(`outbound: resolved relative path ${mediaUrl} -> ${filePath}`);
              } else {
                filePath = mediaUrl;
              }
              logger.debug(`outbound: local file path resolved filePath=${filePath}`);
            } else if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
              logger.debug(`outbound: downloading remote mediaUrl=${mediaUrl.slice(0, 80)}...`);
              filePath = await downloadRemoteImageToTemp(mediaUrl, MEDIA_OUTBOUND_TEMP_DIR);
              logger.debug(`outbound: remote image downloaded to filePath=${filePath}`);
            } else {
              logger.warn(
                `outbound: unrecognized mediaUrl scheme, sending text only mediaUrl=${mediaUrl.slice(0, 80)}`,
              );
              await sendMessageWeixin({ to: ctx.To, text, opts: {
                baseUrl: deps.baseUrl,
                token: deps.token,
                contextToken,
                runId,
              }});
              void emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
              logger.info(`outbound: text sent to=${ctx.To}`);
              return;
            }
            await sendWeixinMediaFile({
              filePath,
              to: ctx.To,
              text,
              opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId },
              cdnBaseUrl: deps.cdnBaseUrl,
            });
            void emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
            logger.info(`outbound: media sent OK to=${ctx.To}`);
          } else {
            logger.debug(`outbound: sending text message to=${ctx.To}`);
            await sendMessageWeixin({ to: ctx.To, text, opts: {
              baseUrl: deps.baseUrl,
              token: deps.token,
              contextToken,
              runId,
            }});
            void emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
            logger.info(`outbound: text sent OK to=${ctx.To}`);
          }
        } catch (err) {
          logger.error(
            `outbound: FAILED to=${ctx.To} mediaUrl=${mediaUrl ?? "none"} err=${String(err)} stack=${(err as Error).stack ?? ""}`,
          );
          throw err;
        }
      },
      onError: (err, info) => {
        deps.errLog(`weixin reply ${info.kind}: ${String(err)}`);
        const errMsg = err instanceof Error ? err.message : String(err);
        let notice: string;
        if (errMsg.includes("remote media download failed") || errMsg.includes("fetch")) {
          notice = `⚠️ 媒体文件下载失败，请检查链接是否可访问。`;
        } else if (
          errMsg.includes("getUploadUrl") ||
          errMsg.includes("CDN upload") ||
          errMsg.includes("upload_param")
        ) {
          notice = `⚠️ 媒体文件上传失败，请稍后重试。`;
        } else {
          notice = `⚠️ 消息发送失败：${errMsg}`;
        }
        void sendWeixinErrorNotice({
          to: ctx.To,
          contextToken,
          message: notice,
          baseUrl: deps.baseUrl,
          token: deps.token,
          runId,
          errLog: deps.errLog,
        });
      },
    });

  logger.debug(`dispatchReplyFromConfig: starting agentId=${route.agentId ?? "(none)"}`);
  try {
    await deps.channelRuntime.reply.withReplyDispatcher({
      dispatcher,
      run: () =>
        deps.channelRuntime.reply.dispatchReplyFromConfig({
          ctx: finalized,
          cfg: deps.config,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            ...(replyProgressSender?.replyOptions ?? {}),
            disableBlockStreaming: true,
          },
        }),
    });
    logger.debug(`dispatchReplyFromConfig: done agentId=${route.agentId ?? "(none)"}`);
  } catch (err) {
    logger.error(
      `dispatchReplyFromConfig: error agentId=${route.agentId ?? "(none)"} err=${String(err)}`,
    );
    throw err;
  } finally {
    markDispatchIdle();
    await replyProgressSender?.finalize();

    logger.info(
      `debug-check: accountId=${deps.accountId} debug=${String(debug)} hasContextToken=${Boolean(contextToken)}`,
    );

    if (debug && contextToken) {
      const dispatchDoneAt = Date.now();
      const eventTs = full.create_time_ms ?? 0;
      const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
      const inboundProcessMs = (debugTs.preDispatch ?? receivedAt) - receivedAt;
      const aiMs = dispatchDoneAt - (debugTs.preDispatch ?? receivedAt);
      const totalTime = eventTs > 0 ? `${dispatchDoneAt - eventTs}ms` : `${dispatchDoneAt - receivedAt}ms`;

      if (debugDeliveries.length > 0) {
        debugTrace.push("── 回复 ──");
        for (const d of debugDeliveries) {
          debugTrace.push(
            `│ textLen=${d.textLen} media=${d.media}`,
            `│ text="${d.preview}"`,
          );
        }
        const firstTs = debugDeliveries[0].ts;
        debugTrace.push(`│ deliver耗时: ${dispatchDoneAt - firstTs}ms`);
      } else {
        debugTrace.push("── 回复 ──", "│ (deliver未捕获)");
      }

      debugTrace.push(
        "── 耗时 ──",
        `├ 平台→插件: ${platformDelay}`,
        `├ 入站处理(auth+route+media): ${inboundProcessMs}ms (mediaDownload: ${mediaDownloadMs}ms)`,
        `├ AI生成+回复: ${aiMs}ms`,
        `├ 总耗时: ${totalTime}`,
        `└ eventTime: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
      );

      const timingText = `⏱ Debug 全链路\n${debugTrace.join("\n")}`;

      logger.info(`debug-timing: sending to=${ctx.To}`);
      try {
        await sendMessageWeixin({
          to: ctx.To,
          text: timingText,
          opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
        });
        logger.info(`debug-timing: sent OK`);
      } catch (debugErr) {
        logger.error(`debug-timing: send FAILED err=${String(debugErr)}`);
      }
    }
  }
}
