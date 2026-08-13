# 流式等首包占位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 详情页在 `state === 'streaming'` 且尚无 `streamText` 时，仍显示「实时接收中…」卡片，避免等首包阶段主响应区空白。

**Architecture:** 纯前端展示条件放宽：流式卡片由 `isStreaming && streamText` 改为 `isStreaming`，`StreamLive` 接收空字符串；给空 `<pre>` 设最小高度。不改后端 capture、SSE 协议、列表页或 `state` 枚举。

**Tech Stack:** Vue 3、TypeScript、Vite

**Spec:** `docs/superpowers/specs/2026-07-17-streaming-empty-placeholder-design.md`

## Global Constraints

- 不新增「等待首包」独立文案或状态枚举；等首包 = 空的「实时接收中…」。
- 不修改后端 `response_start` / `publishStreamingRecord` / Recorder 协议 / 数据库 schema。
- 不修改列表页「传输中 / 流式传输中…」逻辑。
- 不覆盖「请求已进代理、上游尚未返回响应头」阶段。
- 前端无 Vue 组件测试脚手架；不新增 Vitest/Vue Test Utils 基建，以构建通过 + 手工验收为准。
- 未经用户再次明确允许，不执行 `git commit`。

## File Structure

| 文件 | 职责 |
|------|------|
| `frontend/src/views/DetailView.vue` | 放宽流式卡片 `v-if`，空 `streamText` 时仍渲染 |
| `frontend/src/components/StreamLive.vue` | 空文本时保持可见高度 |

---

### Task 1: 详情页流式空占位

**Files:**
- Modify: `frontend/src/views/DetailView.vue`（流式响应卡片条件，约 597–600 行）
- Modify: `frontend/src/components/StreamLive.vue`（`.stream-card pre` 样式）

**Interfaces:**
- Consumes: 现有 `isStreaming`（`record.state === 'streaming'`）、`streamText`（`summary?.streamText ?? record.streamText`）
- Produces: 无新 API；展示行为变化见验收场景

- [x] **Step 1: 修改 DetailView 流式卡片条件**

将 `frontend/src/views/DetailView.vue` 中响应内容区：

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

不要改紧随其后的 `v-else-if="record.responseContent && !isStreaming"` 合并响应分支，也不要改 `streamText` 计算属性。

- [x] **Step 2: 给 StreamLive 空内容最小高度**

将 `frontend/src/components/StreamLive.vue` 的样式：

```css
.stream-card pre {
  font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; max-height: 500px;
  overflow-y: auto; color: var(--text-primary);
}
```

改为：

```css
.stream-card pre {
  font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; max-height: 500px;
  min-height: 3em;
  overflow-y: auto; color: var(--text-primary);
}
```

`min-height: 3em` 约等于 2 行（line-height 1.5），避免空 `<pre>` 塌成细条。不要改 `watch` / append 逻辑。

- [x] **Step 3: 前端构建验证**

Run:

```bash
npm run build:frontend
```

Expected: 退出码 0，无 TypeScript / Vue 模板编译错误。

- [ ] **Step 4: 手工验收（开发模式）** <!-- 需用户本地跑流式请求验证 -->

启动（示例）：

```bash
npm start -- --upstream <你的上游> --db-path ./data.db
```

按 spec 验证：

1. 流式请求已回响应头、尚无 body 时打开详情：响应区出现「实时接收中…」卡片，内容为空但有可见高度；meta 仍有「● 传输中…」。
2. 同一详情不刷新，首个 SSE 文本到达后卡片内出现内容，标签仍为「实时接收中…」。
3. 后续 chunk 增量追加，滚底与改前一致。
4. 流结束 → 流式卡消失，展示合并响应卡。
5. 错误/中断（`state === 'error'`）不展示流式卡。
6. 非流式记录详情不出现该卡片。
7. 列表「传输中 / 流式传输中…」与改前一致。

- [ ] **Step 5: 提交（仅当用户明确授权）**

若用户说「提交」：

```bash
git add frontend/src/views/DetailView.vue frontend/src/components/StreamLive.vue
git commit -m "$(cat <<'EOF'
fix(frontend): 流式等首包时详情页显示实时接收中占位

EOF
)"
```

若用户未授权提交，跳过本步，仅汇报 diff 与验收结果。

---

## Spec Coverage Checklist

| Spec 要求 | 对应步骤 |
|-----------|----------|
| `isStreaming` 即显示流式卡 | Task 1 Step 1 |
| `streamText ?? ''` 传给 StreamLive | Task 1 Step 1 |
| 空内容可见高度 | Task 1 Step 2 |
| 不改后端 / 列表 / 状态枚举 | Global Constraints + 未触碰相关文件 |
| 完成/错误/非流式行为不变 | Task 1 Step 4 场景 4–6 |
| `build:frontend` 通过 | Task 1 Step 3 |
| 不强制 Vue 测试基建 | Global Constraints |
