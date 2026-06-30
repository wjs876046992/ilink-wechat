# ilink-wechat 转发能力改进路线图

## 📅 最后更新: 2026-06-30 (v2)

---

## ✅ 已完成阶段

### Phase 0: 上游同步 (已完成)
**分支**: `feature/upstream-sync-v2.4.6` → 已合并  
**提交**: `4dd5f66`

| 功能 | 状态 | 说明 |
|------|------|------|
| classifyFetchError | ✅ | 网络错误分类诊断 |
| AbortSignal 支持 | ✅ | 请求中断信号 |
| StreamingMarkdownFilter | ✅ | 流式 Markdown 过滤 |
| 连接状态通知 | ✅ | notifyStart/notifyStop |
| Outbound hooks | ✅ | message_sending/message_sent |
| 工具调用进度消息 | ✅ | replyProgressMessages |
| bot_agent 请求字段 | ✅ | UA 风格标识 |
| Node 24 兼容性 | ✅ | 移除手动 Content-Length |
| 独立模式支持 | ✅ | 动态导入 OpenClaw SDK |

**新文件**:
- `src/messaging/outbound-hooks.ts`
- `src/messaging/reply-progress-sender.ts`
- `src/config/reply-progress.ts`

---

### Phase 1: 异步回调媒体支持 (已完成)
**分支**: `feature/async-callback-media` → 待合并  
**提交**: `f38809f` → `33f8b1f`  
**PR**: https://github.com/wjs876046992/ilink-wechat/pull/2

| 修改文件 | 说明 |
|----------|------|
| `callback-registry.ts` | 新增 `cdnBaseUrl` 字段 |
| `process-message.ts` | 注册回调时传入 `cdnBaseUrl` |
| `callback-server.ts` | 支持异步回调发送媒体文件（含多文件） |

**功能支持**:
- ✅ 本地文件路径（绝对/相对/file://）
- ✅ 远程 HTTP/HTTPS URL（下载后上传）
- ✅ 文本+媒体组合发送
- ✅ 仅媒体发送
- ✅ 多图/多文件发送（`mediaUrls` 数组）
- ✅ CQ 码媒体解析（通过 `parseCQText` 的 `params` 属性）

**回调请求格式**:
```json
{
    "requestId": "cb-xxx",
    "text": "这是图片",
    "mediaUrl": "https://example.com/image.png",
    "mediaUrls": ["https://example.com/img1.png", "https://example.com/img2.png"]
}
```

**修复记录** (2026-06-30):
- 修复 `parseCQText` 返回格式：使用 `params` 属性替代 `data`（sp_plugins `2f96b10b` → `4cfee35a`）
- 新增多文件支持：`mediaUrls` 数组逐个发送（ilink-wechat `33f8b1f`，sp_plugins `ee23ca71`）

---

### 微信ClawBot适配器更新 (已完成)
**仓库**: `sp_plugins`  
**提交**: `03b07908` → `ee23ca71`

| 修改 | 说明 |
|------|------|
| 回调数据新增 mediaUrl/mediaUrls | 支持单文件/多文件媒体发送 |
| 解析 CQ 码媒体 | 通过 `parseCQText` 的 `params` 属性提取 URL |

**支持的媒体类型**:
- `[CQ:image,url=xxx]` → 图片
- `[CQ:video,url=xxx]` → 视频
- `[CQ:file,url=xxx]` → 文件
- `[CQ:record,url=xxx]` → 语音

**多文件支持**:
- 单文件 → `{ requestId, text, mediaUrl }`
- 多文件 → `{ requestId, text, mediaUrls: [...] }`

---

## 📋 剩余规划

### Phase 2: 优化过期清理机制 (P1 - 重要) ✅ 完成
**提交**: `bd240ec`

**设计原则**: 回调可多次消费，不设超时限制

**实施内容**:
1. **CallbackRegistry 优化** ✅
   - 新增 `startCleanup()` / `stopCleanup()` 方法管理清理定时器
   - 新增 `setEntryTtl(ms)` 支持自定义过期时间
   - 清理间隔从 60s 优化为 30s
   - 导出 `DEFAULT_ENTRY_TTL_MS` 常量 (10分钟)

2. **callback-server.ts 重构** ✅
   - 使用 `startCleanup()` 替代内联 setInterval
   - `close()` 时调用 `stopCleanup()` 清理资源

---

### ~~Phase 3: 回调注册表持久化~~ (已取消)
**原因**: 重启不频繁，丢失可接受

---

### Phase 4: WebSocket 认证改进 (P3)
**预计工时**: 0.5 天

**目标**: 支持更安全的认证方式

**实施内容**:
1. **支持 Query 参数认证**
   ```typescript
   const url = new URL(endpoint);
   url.searchParams.set('token', this.cfg.authToken);
   const ws = new globalThis.WebSocket(url.toString());
   ```

2. **支持消息体认证**
   ```typescript
   const payload = JSON.stringify({
     type: "message",
     authToken: this.cfg.authToken,
     // ... 其他字段
   });
   ```

---

## 📊 优先级排序

| 优先级 | 任务 | 状态 | 备注 |
|--------|------|------|------|
| P0 | 异步回调媒体支持 | ✅ 完成 | 含多图 |
| P1 | 优化过期清理机制 | ✅ 完成 | - |
| ~~P2~~ | ~~回调注册表持久化~~ | ❌ 取消 | 重启不频繁，丢失可接受 |
| P3 | WebSocket 认证改进 | 📋 待实施 | 0.5 天 |

---

## 🔧 测试检查清单

### Phase 1 测试
- [x] 文本消息异步回调
- [x] 图片消息异步回调
- [x] 视频消息异步回调
- [x] 文件消息异步回调
- [x] 本地文件路径发送
- [x] 远程 URL 下载发送
- [x] 文本+媒体组合发送
- [x] 多图发送
- [x] CQ 码媒体解析（params.url）

### Phase 2 测试
- [x] 过期条目自动清理
- [x] 同一 requestId 可多次消费
- [x] 自定义过期时间
- [x] 清理定时器正确启动/停止

---

## 📝 备注

1. **向后兼容**: 所有新功能通过配置开关控制，默认行为不变
2. **独立模式**: Phase 2/3 需要在独立模式下测试
3. **上游同步**: 定期检查上游更新，避免功能冲突
