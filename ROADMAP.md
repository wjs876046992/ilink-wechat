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

### Phase 2: 超时通知机制 (P1 - 重要)
**预计工时**: 1-2 天

**目标**: 异步回调超时时通知用户，避免消息静默丢失

**实施内容**:
1. **添加超时配置**
   ```typescript
   // external-api-provider.ts
   callbackTimeoutMs?: number;      // 默认 5 分钟
   callbackTimeoutMessage?: string; // 超时提示消息
   ```

2. **在 process-message.ts 中实现超时处理**
   - 注册超时定时器
   - 超时后发送通知消息
   - 清理回调注册表

3. **更新 CallbackRegistry**
   - 支持存储 timeoutTimer 引用
   - 支持取消超时

**测试用例**:
- 超时后发送通知
- 回调成功后取消超时
- 自定义超时时间

---

### Phase 3: 回调注册表持久化 (P2)
**预计工时**: 2 天

**目标**: 进程重启后恢复待处理回调，避免消息丢失

**实施内容**:
1. **创建持久化存储模块**
   ```typescript
   // src/storage/callback-store.ts
   export class CallbackStore {
     save(entries: Map<string, PersistedCallbackEntry>): void;
     load(): Map<string, PersistedCallbackEntry>;
     clear(): void;
   }
   ```

2. **修改 CallbackRegistry**
   - 添加 initStore(accountId) 方法
   - 注册/删除时自动持久化
   - 启动时从磁盘恢复

3. **在 channel.ts 中初始化存储**

**存储路径**: `<stateDir>/openclaw-weixin/callbacks/<accountId>.pending.json`

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

| 优先级 | 任务 | 状态 | 预计工时 |
|--------|------|------|----------|
| P0 | 异步回调媒体支持 | ✅ 完成（含多图） | - |
| P1 | 超时通知机制 | 📋 待实施 | 1-2 天 |
| P2 | 回调注册表持久化 | 📋 待实施 | 2 天 |
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
- [ ] 超时后发送通知
- [ ] 回调成功后不发通知
- [ ] 自定义超时时间
- [ ] 进程重启后超时处理

### Phase 3 测试
- [ ] 注册表持久化到磁盘
- [ ] 启动时恢复注册表
- [ ] 过期条目过滤
- [ ] 进程重启后恢复回调

---

## 📝 备注

1. **向后兼容**: 所有新功能通过配置开关控制，默认行为不变
2. **独立模式**: Phase 2/3 需要在独立模式下测试
3. **上游同步**: 定期检查上游更新，避免功能冲突
