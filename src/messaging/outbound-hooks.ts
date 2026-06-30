import { logger } from "../util/logger.js";

const CHANNEL_ID = "openclaw-weixin";

/** Cached hook runner import to avoid repeated dynamic imports. */
let hookRuntimeModule: typeof import("openclaw/plugin-sdk/hook-runtime") | null = null;
let pluginRuntimeModule: typeof import("openclaw/plugin-sdk/plugin-runtime") | null = null;
let hookRuntimeLoadAttempted = false;

/**
 * Safely load hook-runtime and plugin-runtime modules.
 * Returns null if OpenClaw runtime is not available (standalone mode).
 */
async function loadHookRuntime(): Promise<{
  hookRuntime: typeof import("openclaw/plugin-sdk/hook-runtime") | null;
  pluginRuntime: typeof import("openclaw/plugin-sdk/plugin-runtime") | null;
}> {
  if (hookRuntimeLoadAttempted) {
    return { hookRuntime: hookRuntimeModule, pluginRuntime: pluginRuntimeModule };
  }
  hookRuntimeLoadAttempted = true;
  try {
    hookRuntimeModule = await import("openclaw/plugin-sdk/hook-runtime");
    pluginRuntimeModule = await import("openclaw/plugin-sdk/plugin-runtime");
    return { hookRuntime: hookRuntimeModule, pluginRuntime: pluginRuntimeModule };
  } catch {
    // OpenClaw runtime not available (standalone mode)
    return { hookRuntime: null, pluginRuntime: null };
  }
}

/**
 * Run message_sending hook before sending.
 * Returns the (possibly modified) text content plus a cancelled flag.
 * Hook errors are caught and logged — sending proceeds regardless.
 * In standalone mode (no OpenClaw runtime), hooks are skipped gracefully.
 */
export async function applyWeixinMessageSendingHook(params: {
  to: string;
  text: string;
  accountId?: string;
  mediaUrl?: string;
  runId?: string;
}): Promise<{ cancelled: boolean; text: string }> {
  const { hookRuntime, pluginRuntime } = await loadHookRuntime();
  if (!hookRuntime || !pluginRuntime) {
    // Standalone mode: no hooks available
    return { cancelled: false, text: params.text };
  }
  const hookRunner = pluginRuntime.getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return { cancelled: false, text: params.text };
  }
  try {
    const hookResult = await hookRunner.runMessageSending(
      {
        to: params.to,
        content: params.text,
        metadata: {
          channel: CHANNEL_ID,
          accountId: params.accountId,
          runId: params.runId,
          ...(params.mediaUrl ? { mediaUrls: [params.mediaUrl] } : {}),
        },
      },
      { channelId: CHANNEL_ID, accountId: params.accountId },
    );
    if (hookResult?.cancel) {
      return { cancelled: true, text: params.text };
    }
    return {
      cancelled: false,
      text: hookResult?.content ?? params.text,
    };
  } catch (err) {
    logger.warn(`message_sending hook error, proceeding with send: ${String(err)}`);
    return { cancelled: false, text: params.text };
  }
}

/**
 * Fire message_sent hook (fire-and-forget) after a send attempt.
 * In standalone mode (no OpenClaw runtime), hooks are skipped gracefully.
 */
export async function emitWeixinMessageSent(params: {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  accountId?: string;
  runId?: string;
}): Promise<void> {
  const { hookRuntime, pluginRuntime } = await loadHookRuntime();
  if (!hookRuntime || !pluginRuntime) {
    // Standalone mode: no hooks available
    return;
  }
  const hookRunner = pluginRuntime.getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sent")) return;
  const canonical = hookRuntime.buildCanonicalSentMessageHookContext({
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: CHANNEL_ID,
    accountId: params.accountId,
    conversationId: params.to,
    runId: params.runId,
  });
  hookRuntime.fireAndForgetHook(
    Promise.resolve(
      hookRunner!.runMessageSent(
        hookRuntime.toPluginMessageSentEvent(canonical),
        hookRuntime.toPluginMessageContext(canonical),
      ),
    ),
    "weixin: message_sent plugin hook failed",
  );
}
