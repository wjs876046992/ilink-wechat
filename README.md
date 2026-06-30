# ilink-wechat

微信消息转发服务，将微信消息接入 OpenClaw 或外部 AI 服务。

## 功能特性

- 🔄 支持 REST (HTTP) 和 WebSocket 两种外部服务连接模式
- 📷 支持图片、视频、文件、语音等多媒体消息
- 📤 支持单图/多图/多文件发送
- ⚡ 支持同步和异步回调模式
- 🔐 支持多种认证方式（Header / Query / 消息体）
- 📊 支持调试模式查看全链路耗时

---

## 快速开始

### 安装

```bash
npm install
npm run build
```

### 登录

```bash
# 扫码登录微信
openclaw channels login --channel openclaw-weixin
```

### 启动

```bash
openclaw start
```

---

## 配置说明

配置文件位置：`~/.openclaw/openclaw.json`

### 基础配置

```json
{
  "channels": {
    "openclaw-weixin": {
      "replyProgressMessages": true
    }
  }
}
```

### 外部服务 Provider 配置

#### REST 同步模式

外部服务接收请求后直接返回回复内容。

```json
{
  "channels": {
    "openclaw-weixin": {
      "provider": {
        "type": "rest",
        "endpoint": "http://localhost:3000/api/chat",
        "authHeader": "Authorization",
        "authToken": "your-api-key",
        "timeoutMs": 30000,
        "fallbackMessage": "服务暂时不可用，请稍后再试",
        "requestFormat": "simple",
        "mode": "sync"
      }
    }
  }
}
```

#### REST 异步模式

外部服务收到请求后立即返回，处理完成后通过回调接口返回结果。

```json
{
  "channels": {
    "openclaw-weixin": {
      "provider": {
        "type": "rest",
        "endpoint": "http://localhost:3000/api/chat",
        "mode": "async",
        "callbackPort": 8765,
        "callbackPath": "/callback",
        "callbackAuthToken": "your-callback-secret"
      }
    }
  }
}
```

#### WebSocket 模式

通过 WebSocket 长连接与外部服务通信。

```json
{
  "channels": {
    "openclaw-weixin": {
      "provider": {
        "type": "ws",
        "endpoint": "ws://localhost:8080/ws",
        "authToken": "your-secret-token",
        "authMode": "query",
        "timeoutMs": 30000,
        "fallbackMessage": "服务暂时不可用"
      }
    }
  }
}
```

---

## Provider 配置参数

### 通用参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `type` | string | `"openclaw"` | Provider 类型：`"rest"` / `"ws"` / `"openclaw"` |
| `endpoint` | string | - | 外部服务地址（必填） |
| `authToken` | string | - | 认证 Token |
| `timeoutMs` | number | `30000` | 请求超时时间（毫秒） |
| `fallbackMessage` | string | `"服务暂时不可用"` | 失败时的提示消息 |

### REST 模式专属参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `authHeader` | string | `"Authorization"` | 认证 Header 名称 |
| `requestFormat` | string | `"simple"` | 请求格式：`"simple"` / `"openai"` |
| `mode` | string | `"sync"` | 模式：`"sync"` / `"async"` |
| `callbackPort` | number | `8765` | 异步回调监听端口 |
| `callbackPath` | string | `"/callback"` | 异步回调路径 |
| `callbackAuthToken` | string | - | 回调认证 Token |

### WebSocket 模式专属参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `authMode` | string | `"query"` | 认证方式：`"query"` / `"message"` / `"both"` |

#### authMode 说明

| 值 | 说明 |
|----|------|
| `"query"` | Token 拼接到 URL：`ws://host/ws?token=xxx` |
| `"message"` | Token 放在消息体：`{ "authToken": "xxx", ... }` |
| `"both"` | 两者都发送 |

---

## 消息格式

### REST 同步模式

**请求：**

```json
POST /api/chat
Content-Type: application/json
Authorization: your-api-key

{
  "from": "user@im.wechat",
  "body": "你好",
  "contextToken": "xxx",
  "accountId": "bot-id",
  "mediaPath": "/tmp/media/image.jpg",
  "mediaType": "image/*"
}
```

**响应：**

```json
{
  "text": "你好！有什么可以帮助你的？",
  "mediaUrl": "https://example.com/response.png"
}
```

支持的响应字段：`text` / `reply` / `content` + `mediaUrl`

### REST 异步模式

**请求：**

```json
POST /api/chat
{
  "from": "user@im.wechat",
  "body": "帮我画张图",
  "requestId": "cb-123456"
}
```

**响应（立即返回）：**

```json
{
  "ok": true
}
```

**回调：**

```json
POST http://localhost:8765/callback
Authorization: your-callback-secret

{
  "requestId": "cb-123456",
  "text": "这是你要的图片",
  "mediaUrl": "https://example.com/image.png"
}
```

**多文件回调：**

```json
{
  "requestId": "cb-123456",
  "text": "这些是你要的图片",
  "mediaUrls": [
    "https://example.com/img1.png",
    "https://example.com/img2.png",
    "https://example.com/img3.png"
  ]
}
```

### WebSocket 模式

**发送：**

```json
{
  "type": "message",
  "from": "user@im.wechat",
  "body": "你好",
  "contextToken": "xxx",
  "accountId": "bot-id",
  "authToken": "your-token"
}
```

**接收：**

```json
{
  "text": "你好！有什么可以帮助你的？"
}
```

---

## 多媒体支持

### 接收的消息类型

| 类型 | CQ 码 | 说明 |
|------|-------|------|
| 图片 | `[CQ:image,url=xxx]` | jpg/png/gif 等 |
| 视频 | `[CQ:video,url=xxx]` | mp4 等 |
| 文件 | `[CQ:file,url=xxx]` | 任意文件 |
| 语音 | `[CQ:record,url=xxx]` | wav/mp3 等 |

### 发送媒体

**方式一：mediaUrl 字段**

```json
{
  "text": "这是一张图片",
  "mediaUrl": "https://example.com/image.png"
}
```

**方式二：多图发送**

```json
{
  "text": "这些是图片",
  "mediaUrls": [
    "https://example.com/img1.png",
    "https://example.com/img2.png"
  ]
}
```

**方式三：本地文件**

```json
{
  "text": "本地文件",
  "mediaUrl": "/path/to/file.pdf"
}
```

```json
{
  "text": "file 协议",
  "mediaUrl": "file:///path/to/file.pdf"
}
```

---

## 回调注册表

异步模式下，回调注册表存储待处理的请求。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 过期时间 | 10 分钟 | 超时后自动清理 |
| 清理间隔 | 30 秒 | 定期清理过期条目 |

同一个 `requestId` 支持多次回调（多条回复场景）。

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `HTTP_LISTEN_PORT` | HTTP 服务监听端口 |

---

## 调试模式

在微信中发送 `/debug` 命令开启调试模式，会收到全链路耗时信息：

```
⏱ Debug 全链路
── 收消息 ──
│ seq=xxx msgId=xxx from=xxx
│ body="你好" (len=2) itemTypes=[TEXT]
── 鉴权 & 路由 ──
│ auth: cmdAuthorized=true senderAllowed=true
│ route: agent=xxx session=xxx
── 耗时 ──
├ 平台→插件: 150ms
├ 入站处理: 200ms
├ AI生成+回复: 1500ms
├ 总耗时: 1850ms
```

---

## 目录结构

```
ilink-wechat/
├── src/
│   ├── api/              # API 接口
│   ├── auth/             # 认证相关
│   ├── cdn/              # CDN 上传
│   ├── config/           # 配置
│   ├── media/            # 媒体处理
│   ├── messaging/        # 消息处理核心
│   ├── monitor/          # 长轮询监控
│   ├── providers/        # 外部服务 Provider
│   ├── server/           # 回调服务器
│   ├── storage/          # 存储
│   └── util/             # 工具函数
├── ROADMAP.md            # 开发路线图
└── package.json
```

---

## 故障排查

### 回调 404

```
{ "ok": false, "error": "unknown or expired requestId" }
```

**原因**：requestId 不存在或已过期（超过 10 分钟）

**解决**：
- 检查 requestId 是否正确
- 确保外部服务在 10 分钟内回调

### 认证失败 (401)

**检查**：
- `authToken` 配置是否正确
- Header / Query / 消息体中的 Token 是否匹配

### WebSocket 连接失败

**检查**：
- Node.js 版本 >= 22（需要原生 WebSocket）
- `endpoint` 地址是否正确
- `authMode` 配置是否与服务端匹配

---

## License

MIT
