#!/usr/bin/env node
/**
 * ilink-wechat standalone server CLI.
 *
 * Usage (after `npm run build`):
 *   node dist/src/server/index.js [command]
 *
 * Or use the npm scripts (which build automatically):
 *   npm run login    # scan QR code and save credentials
 *   npm run serve    # start the long-poll server
 *
 * Commands:
 *   login    Scan QR code and save credentials (first-time setup).
 *   start    Start the long-poll monitor and forward messages to the
 *            configured external provider.  This is the default command.
 *
 * Options (environment variables):
 *   OPENCLAW_STATE_DIR   Override the state directory (default: ~/.openclaw)
 *   OPENCLAW_LOG_LEVEL   Log level: TRACE|DEBUG|INFO|WARN|ERROR  (default: INFO)
 *   ILINK_CONFIG         Path to config file
 *                        (default: ~/.openclaw/openclaw.json or ./ilink-wechat.json)
 *
 * Config file (JSON, two supported formats):
 *
 *   Option A — use the existing openclaw.json:
 *     { "channels": { "openclaw-weixin": { "provider": { "type": "rest", "endpoint": "..." } } } }
 *
 *   Option B — standalone ilink-wechat.json:
 *     { "provider": { "type": "rest", "endpoint": "..." }, "accountId": "optional" }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

import { loadWeixinAccount, listIndexedWeixinAccountIds, saveWeixinAccount, registerWeixinAccountId, clearStaleAccountsForUserId, DEFAULT_BASE_URL, CDN_BASE_URL } from "../auth/accounts.js";
import { clearContextTokensForAccount } from "../messaging/inbound.js";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "../auth/login-qr.js";
import { createReplyProvider } from "../providers/index.js";
import { runStandaloneMonitor } from "./standalone-monitor.js";
import { startCallbackServer } from "./callback-server.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

type ProviderConfig = {
  type: string;
  endpoint?: string;
  authToken?: string;
  authHeader?: string;
  timeoutMs?: number;
  fallbackMessage?: string;
  requestFormat?: string;
  mode?: string;
  callbackPort?: number;
  callbackPath?: string;
  callbackAuthToken?: string;
};

type AccountConfig = {
  /** Account ID (required). */
  accountId: string;
  /** Optional per-account provider override. If not set, uses the top-level provider. */
  provider?: ProviderConfig;
};

type StandaloneConfig = {
  /** Explicit account ID to use (optional when only one account is registered). */
  accountId?: string;
  /** Multiple accounts configuration. When set, each account runs its own monitor. */
  accounts?: AccountConfig[];
  /** Provider config (used as default for all accounts). */
  provider: ProviderConfig;
};

type ResolvedAccount = {
  accountId: string;
  account: ReturnType<typeof loadWeixinAccount>;
  provider: ProviderConfig;
};

function resolveConfigPath(): string {
  const env = process.env.ILINK_CONFIG?.trim();
  if (env) return env;

  // Look for standalone ilink-wechat.json in current dir first.
  const localPath = path.resolve("ilink-wechat.json");
  if (fs.existsSync(localPath)) return localPath;

  // Fall back to the shared openclaw.json.
  return path.join(resolveStateDir(), "openclaw.json");
}

function loadConfig(): StandaloneConfig {
  const cfgPath = resolveConfigPath();
  if (!fs.existsSync(cfgPath)) {
    printError(
      `Config file not found: ${cfgPath}\n` +
        `Create an ilink-wechat.json in the current directory, or set ILINK_CONFIG.\n` +
        `\nExample ilink-wechat.json:\n` +
        JSON.stringify(
          { provider: { type: "rest", endpoint: "http://localhost:8080/chat" } },
          null,
          2,
        ),
    );
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch (err) {
    printError(`Failed to parse config file ${cfgPath}: ${String(err)}`);
    process.exit(1);
  }

  const obj = raw as Record<string, unknown>;

  // Support openclaw.json format: { channels: { "openclaw-weixin": { provider: {...} } } }
  if (obj.channels && typeof obj.channels === "object") {
    const channelSection = (obj.channels as Record<string, unknown>)["openclaw-weixin"] as Record<string, unknown> | undefined;
    if (channelSection?.provider) {
      return {
        accountId: typeof obj.accountId === "string" ? obj.accountId : undefined,
        accounts: Array.isArray(obj.accounts) ? obj.accounts as AccountConfig[] : undefined,
        provider: channelSection.provider as ProviderConfig,
      };
    }
  }

  // Support standalone format: { provider: {...}, accountId?: "...", accounts?: [...] }
  if (obj.provider && typeof obj.provider === "object") {
    return {
      accountId: typeof obj.accountId === "string" ? obj.accountId : undefined,
      accounts: Array.isArray(obj.accounts) ? obj.accounts as AccountConfig[] : undefined,
      provider: obj.provider as ProviderConfig,
    };
  }

  // openclaw.json was found but has no provider config for standalone mode.
  const localPath = path.resolve("ilink-wechat.json");
  const isOpenClawFallback = cfgPath !== localPath && cfgPath.endsWith("openclaw.json");
  if (isOpenClawFallback) {
    printError(
      `${cfgPath} exists but has no provider configured for standalone mode.\n\n` +
        `Create an ilink-wechat.json in the current directory and run again:\n\n` +
        JSON.stringify(
          { provider: { type: "rest", endpoint: "http://localhost:8080/chat", authToken: "optional-secret", timeoutMs: 30000 } },
          null,
          2,
        ) +
        `\n\nThen run: npm run serve`,
    );
  } else {
    printError(
      `Config file ${cfgPath} has no provider configuration.\n` +
        `Add a "provider" field or "channels.openclaw-weixin.provider" section.`,
    );
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

function resolveAccounts(cfg: StandaloneConfig): ResolvedAccount[] {
  const allIds = listIndexedWeixinAccountIds();

  if (allIds.length === 0) {
    printError(
      `No WeChat accounts found in ${resolveStateDir()}.\n` +
        `Run: npm run login`,
    );
    process.exit(1);
  }

  // 优先使用 accounts 数组配置
  if (cfg.accounts && cfg.accounts.length > 0) {
    const resolved: ResolvedAccount[] = [];
    for (const acc of cfg.accounts) {
      if (!acc.accountId) {
        printError(`Invalid accounts config: missing accountId`);
        process.exit(1);
      }
      const normalizedId = acc.accountId.includes("-") ? acc.accountId : normalizeAccountId(acc.accountId);
      const account = loadWeixinAccount(normalizedId);
      if (!account?.token) {
        printError(`Account "${normalizedId}" not found or has no token. Run \`login\` first.`);
        process.exit(1);
      }
      resolved.push({
        accountId: normalizedId,
        account,
        provider: acc.provider ?? cfg.provider,
      });
    }
    return resolved;
  }

  // 兼容旧格式：单 accountId
  if (cfg.accountId) {
    const normalized = cfg.accountId.includes("-") ? cfg.accountId : normalizeAccountId(cfg.accountId);
    const account = loadWeixinAccount(normalized);
    if (!account?.token) {
      printError(`Account "${normalized}" not found or has no token. Run \`login\` first.`);
      process.exit(1);
    }
    return [{ accountId: normalized, account, provider: cfg.provider }];
  }

  // 无 accountId 配置：单账号时自动使用，多账号时报错
  if (allIds.length === 1) {
    const accountId = allIds[0];
    const account = loadWeixinAccount(accountId);
    if (!account?.token) {
      printError(`Account "${accountId}" has no token. Run \`login\` first.`);
      process.exit(1);
    }
    return [{ accountId, account, provider: cfg.provider }];
  }

  // 多账号但未配置 accountId
  printError(
    `Multiple accounts registered (${allIds.join(", ")}).\n` +
      `Add "accounts" array or "accountId" to your config file.\n\n` +
      `Example:\n` +
      JSON.stringify({
        accounts: allIds.map(id => ({ accountId: id })),
        provider: cfg.provider,
      }, null, 2),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// login command
// ---------------------------------------------------------------------------

const QR_LOGIN_TIMEOUT_MS = 480_000; // 8 minutes

async function runLogin(): Promise<void> {
  print(`\n📱 Starting WeChat QR login...\n`);

  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl: DEFAULT_BASE_URL,
    botType: DEFAULT_ILINK_BOT_TYPE,
    verbose: true,
  });

  if (!startResult.qrcodeUrl) {
    printError(`Failed to get QR code: ${startResult.message}`);
    process.exit(1);
  }

  print(`\n使用微信扫描以下二维码：\n`);

  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(startResult.qrcodeUrl!, { small: true }, (qr: string) => {
        print(qr);
        resolve();
      });
    });
  } catch {
    print(`如果二维码未显示，请用浏览器打开：`);
  }
  print(startResult.qrcodeUrl!);

  print(`\n等待扫码确认...\n`);

  const waitResult = await waitForWeixinLogin({
    sessionKey: startResult.sessionKey,
    apiBaseUrl: DEFAULT_BASE_URL,
    timeoutMs: QR_LOGIN_TIMEOUT_MS,
    verbose: true,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (waitResult.connected && waitResult.botToken && waitResult.accountId) {
    const normalizedId = normalizeAccountId(waitResult.accountId);
    saveWeixinAccount(normalizedId, {
      token: waitResult.botToken,
      baseUrl: waitResult.baseUrl ?? DEFAULT_BASE_URL,
      userId: waitResult.userId,
    });
    registerWeixinAccountId(normalizedId);
    if (waitResult.userId) {
      clearStaleAccountsForUserId(normalizedId, waitResult.userId, clearContextTokensForAccount);
    }
    print(`\n✅ 登录成功！accountId=${normalizedId}`);
    print(`\n下一步：运行以下命令启动机器人：`);
    print(`  npm run serve\n`);
    print(`  (或: node dist/src/server/index.js start)\n`);
  } else {
    printError(`登录失败：${waitResult.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// start command
// ---------------------------------------------------------------------------

async function runStart(): Promise<void> {
  const cfg = loadConfig();

  // Validate provider config
  if (!cfg.provider.type || cfg.provider.type === "openclaw") {
    printError(
      `Standalone mode requires provider.type="rest" or "ws".\n` +
        `The "openclaw" provider requires the OpenClaw gateway and cannot be used in standalone mode.`,
    );
    process.exit(1);
  }

  // 解析所有需要运行的账号
  const resolvedAccounts = resolveAccounts(cfg);

  // 为每个账号创建 Provider
  const accountRunners: Array<{
    accountId: string;
    replyProvider: NonNullable<ReturnType<typeof createReplyProvider>>;
    baseUrl: string;
    cdnBaseUrl: string;
    token: string;
  }> = [];

  for (const resolved of resolvedAccounts) {
    const replyProvider = createReplyProvider(resolved.provider);
    if (!replyProvider) {
      printError(`Failed to create reply provider for account ${resolved.accountId}.`);
      process.exit(1);
    }

    const baseUrl = resolved.account?.baseUrl?.trim() || DEFAULT_BASE_URL;
    const cdnBaseUrl = CDN_BASE_URL;
    const token = resolved.account?.token ?? "";

    if (!token) {
      printError(`No token found for account ${resolved.accountId}. Run \`login\` first.`);
      process.exit(1);
    }

    accountRunners.push({
      accountId: resolved.accountId,
      replyProvider,
      baseUrl,
      cdnBaseUrl,
      token,
    });
  }

  // 打印启动信息
  print(`\n🤖 ilink-wechat standalone server`);
  print(`   accounts: ${accountRunners.map(r => r.accountId).join(", ")}`);
  print(`   provider: ${accountRunners[0].replyProvider.type}${cfg.provider.mode === "async" ? " (async)" : ""}`);
  print(`   logFile : ${logger.getLogFilePath()}`);

  // 启动回调服务器（共享）- 如果任一账号使用 async 模式
  let callbackHandle: import("./callback-server.js").CallbackServerHandle | undefined;
  const hasAsyncMode = cfg.provider.mode === "async" ||
    resolvedAccounts.some(a => a.provider.mode === "async");

  if (hasAsyncMode) {
    // 使用第一个 async provider 的配置
    const asyncConfig = resolvedAccounts.find(a => a.provider.mode === "async")?.provider ?? cfg.provider;
    callbackHandle = startCallbackServer({
      port: asyncConfig.callbackPort,
      path: asyncConfig.callbackPath,
      authToken: asyncConfig.callbackAuthToken,
    });
  }

  print(`\nPress Ctrl+C to stop.\n`);

  // 设置优雅关闭
  const ac = new AbortController();
  const shutdown = (): void => {
    print(`\n[ilink-wechat] Shutting down ${accountRunners.length} account(s)...`);
    ac.abort();
    callbackHandle?.close().catch(() => undefined);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 并行启动所有账号的 monitor
  const monitors = accountRunners.map((runner) => {
    return runStandaloneMonitor({
      baseUrl: runner.baseUrl,
      cdnBaseUrl: runner.cdnBaseUrl,
      token: runner.token,
      accountId: runner.accountId,
      replyProvider: runner.replyProvider,
      abortSignal: ac.signal,
      log: (msg) => print(`[${runner.accountId}] ${msg}`),
      errLog: (msg) => printError(`[${runner.accountId}] ${msg}`),
    }).catch((err) => {
      printError(`[${runner.accountId}] Monitor crashed: ${String(err)}`);
    });
  });

  // 等待所有 monitor 结束
  await Promise.allSettled(monitors);
  print(`\n[ilink-wechat] All accounts stopped.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function print(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function printError(msg: string): void {
  process.stderr.write(`\n❌ ${msg}\n`);
}

function printHelp(): void {
  print(`
ilink-wechat — Standalone WeChat bot server

Usage:
  npm run login              # scan QR code and save credentials
  npm run serve              # start the long-poll server

  node dist/src/server/index.js <command>

Commands:
  login    Scan WeChat QR code and save credentials
  start    Start the long-poll server (default command)
  help     Show this help message

Environment variables:
  OPENCLAW_STATE_DIR   State directory  (default: ~/.openclaw)
  OPENCLAW_LOG_LEVEL   Log level: TRACE|DEBUG|INFO|WARN|ERROR
  ILINK_CONFIG         Path to config file

Config file — single account (sync mode):
  {
    "provider": {
      "type": "rest",
      "endpoint": "http://localhost:8080/chat",
      "authToken": "optional-secret",
      "timeoutMs": 30000
    }
  }

Config file — single account (async callback mode):
  {
    "provider": {
      "type": "rest",
      "endpoint": "http://localhost:8080/chat",
      "authToken": "optional-secret",
      "mode": "async",
      "callbackPort": 8765,
      "callbackPath": "/callback",
      "callbackAuthToken": "callback-secret"
    }
  }

Config file — multiple accounts:
  {
    "accounts": [
      { "accountId": "account-1" },
      {
        "accountId": "account-2",
        "provider": { "type": "rest", "endpoint": "http://localhost:8081/chat2" }
      }
    ],
    "provider": {
      "type": "rest",
      "endpoint": "http://localhost:8080/chat",
      "mode": "async",
      "callbackPort": 8765,
      "callbackPath": "/callback"
    }
  }

  In multi-account mode:
  - Each account runs its own long-poll monitor
  - Accounts can share the same provider or have per-account providers
  - Async callback server is shared across all accounts

  In async mode the bot POSTs the message to your server and returns immediately.
  Your server calls back to http://<bot-host>:<callbackPort><callbackPath> with:
    POST /callback
    Authorization: <callbackAuthToken>
    { "requestId": "<id from original POST>", "text": "Reply text" }
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0] ?? "start";

switch (command) {
  case "login":
    await runLogin();
    break;
  case "start":
    await runStart();
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    printError(`Unknown command: ${command}. Run with --help for usage.`);
    process.exit(1);
}
