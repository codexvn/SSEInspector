# 流式等首包占位设计

## 目标

在详情页 `state === 'streaming'` 且尚未收到任何响应 body 时，响应区仍展示与现有一致的「实时接收中…」卡片，避免主内容区空白，让用户确认连接已建立、正在等待上游首包。

## 当前问题

详情页流式卡片条件为 `isStreaming && streamText`。`response_start` 后记录已是 `streaming`，但首个 body chunk 到达前 `streamText` 为空/`undefined`，卡片整块不渲染。用户只能从 meta「● 传输中…」推断仍在进行，主响应区看起来像未加载或卡住。

列表页对 `state === 'streaming'` 已有「传输中 / 流式传输中…」，不在本次范围。

## 设计

### 原则

- 等首包就是「空的实时接收中」，不新增状态、不新增独立文案。
- 首包前后共用同一张卡片：空内容 = 等首包；有内容 = 增量展示。
- 仅改前端展示条件，不改后端 capture、SSE 协议或 `state` 枚举。

### 详情页

文件：`frontend/src/views/DetailView.vue`

将：

```vue
<div v-if="isStreaming && streamText" class="card streaming-card">
  <span class="section-label label-streaming">实时接收中…</span>
  <StreamLive :text="streamText" />
</div>
```

改为：

```vue
<div v-if="isStreaming" class="card streaming-card">
  <span class="section-label label-streaming">实时接收中…</span>
  <StreamLive :text="streamText ?? ''" />
</div>
```

- `streamText` 计算属性保持不变：优先 `store.items` 中 SSE 快照，fallback 到 `record.streamText`。
- 完成后的分支 `v-else-if="record.responseContent && !isStreaming"` 不变。
- meta「● 传输中…」保留，作为次要状态提示。

### StreamLive

文件：`frontend/src/components/StreamLive.vue`

- 继续接收 `text: string`；空字符串时 `<pre>` 为空，不抛错、不走特殊业务分支。
- 给 `.stream-card pre` 增加约 1～2 行的 `min-height`，避免空内容时卡片视觉塌成细条。
- 增量 append 与自动滚底逻辑不变；空 → 有内容时现有 `watch` 负责写入或追加。

### 数据流

```text
response_start → record.state = streaming（已有）
       ↓
详情：isStreaming → 显示「实时接收中…」+ 空 StreamLive  ← 本次
       ↓
response_chunk → streamText 经 SSE 更新
       ↓
同一卡片增量填充 StreamLive（已有）
       ↓
complete/close → state done/error → 换合并响应卡（已有）
```

## 非目标

- 不覆盖「请求已进入代理、上游尚未返回响应头」阶段（记录仍在 `response_start` 时创建）。
- 不新增「等待首包」独立文案或状态枚举。
- 不改列表页预览/状态徽章。
- 不在后端 `response_start` 强制推送空 `streamText` 快照。

## 验证

1. 流式请求已回响应头、尚无 body 时打开详情：响应区出现「实时接收中…」卡片，内容为空但有可见高度。
2. 同一详情页不刷新，首个 SSE 文本到达后卡片内出现内容，标签仍为「实时接收中…」。
3. 后续 chunk 增量追加，滚底行为与改前一致。
4. 流结束 → `state` 为 `done`：流式卡消失，展示合并响应卡。
5. `state === 'error'`：不展示流式卡，错误仍走现有 meta/错误展示。
6. 非流式记录详情不出现该卡片。
7. 列表「传输中 / 流式传输中…」与改前一致。
8. `npm run build:frontend` 通过。

自动化：若仓库已有合适的前端组件测试脚手架，可补空 `streamText` 时卡片可见的用例；否则以手工验收 + 前端构建为准，不强行新增测试基建。
