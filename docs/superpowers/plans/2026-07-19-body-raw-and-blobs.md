# Body 原样存储与 multipart/Blob 表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 请求/响应 body 以「检查器可理解的原样文本」落库（禁止对 string 再 JSON.stringify 包一层）；multipart 默认存摘要；可选将二进制 part 写入新表 `request_blobs`。

**Architecture:** Worker 侧始终持有 `rawRequestText` / `rawResponseText` 与可选 `parsedRequest`。写库只把 raw 文本写入 `requests.request_body` / `response_body`；AI 派生结果仍进 `response_content`。multipart 解析后写摘要 JSON 到 `request_body`，文件 part 元数据进摘要；若开启存储且未超限，字节写入 `request_blobs`（BLOB 列或后续 fs），详情 API 按需拉取。

**Tech Stack:** TypeScript、TypeORM/SQLite、Worker Threads、Vue 3 BodyInspector

**Depends on:** 透传记录功能已在工作区（未 commit）。本计划可叠在其上，也可与 review 修复一起做。

**Related:**  
- Spec 透传：`docs/superpowers/specs/2026-07-19-passthrough-recording-design.md`  
- Code review latent：requestBody 写读不对称、late request_end 丢 body

## Global Constraints

- 主线程不解析 JSON/SSE/multipart；解析与 blob 写入仅在 Recorder Worker。
- `httpxy` 仍是转发唯一所有者；观察面失败不得阻塞透传。
- SQLite 无 migration：不兼容则删旧 DB（`synchronize: true`）。
- UI 文案简体中文；标识符英文。
- **未经用户明确允许不得 git commit。**
- **有文件 part 即写入 blob 表（默认开启，无总开关）**；仅受单 part 大小上限约束（超限只摘要、不写字节）。
- data2 主流量为 JSON / count_tokens；无文件时零 blob 行，不得拖垮该路径。

## 语义约定

### requests 表（现有 TEXT 列，不改类型）

| 列 | 新语义 |
|----|--------|
| `request_body` | **原样文本**：解压后 UTF-8 body；JSON 为线上 JSON 文本；纯文本即文本；multipart 为 **摘要 JSON 文本**（见下） |
| `response_body` | **原样响应文本** / raw SSE（保持） |
| `response_content` | 仅 AI 合并结果的 JSON 字符串；透传多为 NULL |
| `request_headers` | 仍含 Content-Type，供 UI |

**禁止：** `JSON.stringify(stringValue)` 作为 request_body 写入路径。  
**允许：** 对象仅在内存解析用；落库前用 **原始捕获文本**（`Buffer`/`string` 解压结果），不是 `JSON.stringify(parsedObject)` 反序列化稿——若仅有 object 无 raw，再用 `JSON.stringify(obj)` 且仅当逻辑类型为 object。

### multipart 摘要 JSON（写入 request_body）

```json
{
  "_inspector": "multipart-summary",
  "boundary": "----abc",
  "parts": [
    {
      "index": 0,
      "name": "desc",
      "filename": null,
      "contentType": "text/plain",
      "size": 5,
      "kind": "text",
      "text": "hello"
    },
    {
      "index": 1,
      "name": "file",
      "filename": "a.png",
      "contentType": "image/png",
      "size": 1148576,
      "kind": "file",
      "stored": false,
      "blobId": null,
      "reason": "storage_disabled"
    }
  ]
}
```

- 文本 part：可内联 `text`（单 part 上限可配，默认 64KiB，超出截断 + `truncated: true`）。
- 文件 part：**有文件即尝试写 blob**（无总开关）；通过大小门禁则 `stored: true` + `blobId`，否则 `stored: false` + `reason: "over_max_blob_bytes"`。

### 新表 `request_body_parts`（blob 存储；名称避免与整段 `request_body` 混淆）

```text
request_body_parts
  id            INTEGER PK AUTOINCREMENT
  request_id    TEXT NOT NULL  FK → requests(id) ON DELETE CASCADE
  direction     TEXT NOT NULL  -- 'request' | 'response'（一期仅 request）
  part_index    INTEGER NOT NULL
  name          TEXT
  filename      TEXT
  content_type  TEXT
  size_bytes    INTEGER NOT NULL
  sha256        TEXT
  data          BLOB NOT NULL   -- 一期仅 inline BLOB
  created_at    TEXT NOT NULL

INDEX (request_id)
UNIQUE (request_id, direction, part_index)  -- 可选
```

- **新表**，不塞进 `requests`。
- **默认行为：检测到 file part 就写**（不需要 `--store-request-blobs` 总开关）。
- 一期：仅 SQLite BLOB；单 part 超过 `maxBlobBytes` 只写摘要、不写本表行。
- 二期（非本计划必须）：`storage=fs` + `fs_path`。

### 配置（CLI / config）

| 项 | 默认 | 含义 |
|----|------|------|
| ~~`storeRequestBlobs`~~ | （已取消） | **不需要开关**；有文件 part 即尝试入库 |
| `maxBlobBytes` | `1048576` (1MiB) | 单 part 超过则不存字节，只摘要 |
| `maxMultipartTextPartBytes` | `65536` | 文本 part 内联上限 |

经 `setConfig` / CLI：例如 `--max-blob-bytes`（仅限流，不是总开关）。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `backend/src/entity/RequestBlobEntity.ts` | 新实体 |
| `backend/src/db/index.ts` | 注册实体 |
| `backend/src/config.ts` + `bin/parse-args.js` / CLI | 新配置项 |
| `backend/src/multipart-summary.ts`（新建） | 纯函数：buffer+contentType → 摘要 + 可选 parts bytes |
| `backend/src/body-raw.ts`（新建，可选） | 统一 raw 文本提取：chunks + encoding → string \| error |
| `backend/src/recorder/worker.ts` | 用 raw 文本写库；multipart 分支；写 blob |
| `backend/src/store.ts` | request_body 原样写/读；blob CRUD/RPC |
| `backend/src/recorder/protocol.ts` + client + index API | `blobs.get` RPC / `GET /api/requests/:id/blobs/:blobId` |
| `frontend` BodyInspector + DetailView | 识别 multipart-summary；文件 part 下载/预览入口 |
| 测试 | multipart-summary、store body 往返、blob 可选写入 |
| `CLAUDE.md` | 文档同步 |

---

## Phases Overview

| Phase | 内容 | 可交付 |
|-------|------|--------|
| **P0** | Review 相关 body 正确性（requestBody 同步、读写出对称、status0、空 catch） | 无新表即可合 |
| **P1** | request/response body **原样文本** 写入约定 + 测试 | 无引号 bug |
| **P2** | multipart **摘要** 解析与展示 | form-data 可读 |
| **P3** | **新表 `request_body_parts`**（有文件默认写）+ 大小上限 + 详情按需拉取 | 文件可下载 |
| **P4** | 文档、全量测试、data2 回归脚本扩展 | 收口 |

可 P0+P1 一批、P2+P3 一批。

---

### Task 0（P0）: Review 正确性补丁（与 body 强相关）

**Files:** `worker.ts`, `client.ts`, `store.ts`, `ListView.vue`, `DetailView.vue`

- [ ] **0.1** `finishRequestCapture` 后若存在 `state.record`，同步 `state.record.requestBody`（或统一在 persist* 开头从 state 刷新 request 字段）
- [ ] **0.2** 空 body latch：`requestDecoded` 布尔，避免 `{}` 导致重复解码/未闩
- [ ] **0.3** `endCaptureRequest` / `request_end` 与 complete 竞态：finalize 前仍应尽量发出 request_end，或 complete 时若 `!requestEnded` 仍用已有 chunks 解码
- [ ] **0.4** `response_content` 写入改为 `!= null` 判断
- [ ] **0.5** 列表/详情 status 徽章：`status > 0 && status < 300` 为 ok
- [ ] **0.6** 透传 `buildResponseContent` catch 打 warn（serializeError）
- [ ] **0.7** 测试：late response_start + 后到 request_end 仍有 body；空 POST body

---

### Task 1（P1）: Body 原样写入/读出

**Files:** `store.ts`, `worker.ts`, 可选 `body-raw.ts`

**约定实现：**

```ts
// 写
function serializeRequestBodyForDb(rawText: string | null | undefined): string | undefined {
  if (rawText == null) return undefined
  return rawText  // 禁止 JSON.stringify 包一层
}

// 若历史路径只有 parsed object、无 raw：
function fallbackRawFromParsed(parsed: unknown): string | null {
  if (parsed === undefined) return null
  if (typeof parsed === 'string') return parsed
  try { return JSON.stringify(parsed) } catch { return null }
}
```

- [ ] **1.1** Worker：`requestChunks` concat → decompress → **先保留 rawText string**；JSON.parse 仅填 `parsed` 供 tool backfill
- [ ] **1.2** `buildRecord` / persist 使用 rawText 作为 `requestBody` 字符串语义（RecordedRequest 类型可改为 `requestBody: unknown` 仍兼容，但 **入库字段保证 string 原样**）
- [ ] **1.3** `upsertRecord`：`request_body: typeof r.requestBody === 'string' ? r.requestBody : fallback...`；**删除**对 string 的 `JSON.stringify`
- [ ] **1.4** `entityToRecord`：`requestBody: row.request_body ?? null`（已是原样 string，文档更新注释）
- [ ] **1.5** 前端：`formatBodyForShell` / BodyInspector 对「原样 string」不再错误剥一层（或保留兼容：若 `JSON.parse` 得 string 且整段像 JSON string literal，可剥——过渡期）
- [ ] **1.6** 测试：纯文本 body 往返等于 `hello`；JSON object 往返 parse 后深等；空 body null

---

### Task 2（P2）: multipart 摘要

**Files:** Create `backend/src/multipart-summary.ts`, tests, worker, BodyInspector

- [ ] **2.1** 实现 `summarizeMultipart(buf: Buffer, contentType: string, opts) → { summaryJson: string, fileParts: Array<{ index, name, filename, contentType, bytes }> }`
- [ ] **2.2** Worker：`content-type` 含 `multipart/` 时走摘要；`request_body = summaryJson`；不把二进制写进 TEXT
- [ ] **2.3** 非 multipart 走 P1 原样文本路径
- [ ] **2.4** BodyInspector：`_inspector === 'multipart-summary'` 时展示 parts 表（name/filename/type/size/stored）
- [ ] **2.5** 测试：双 part（text+file）摘要字段正确；file 默认 stored=false

---

### Task 3（P3）: 新表 `request_body_parts` + API（有文件默认写）

**Files:** entity, db, store, protocol, index route, frontend download

- [ ] **3.1** `RequestBodyPartEntity`（表名 `request_body_parts`）+ 注册 TypeORM
- [ ] **3.2** config：仅 `maxBlobBytes` / `maxMultipartTextPartBytes`（**无** store 总开关）
- [ ] **3.3** CLI：`--max-blob-bytes` 等限流参数与 help（不提供 store 开关）
- [ ] **3.4** Worker：multipart 中每个 **file** part 若 `size <= maxBlobBytes` → **一律** insert → summary `stored:true, blobId`；超限只摘要
- [ ] **3.5** store：`getBodyPart(requestId, partId)`；校验 `request_id` 匹配
- [ ] **3.6** HTTP：`GET /api/requests/:id/body-parts/:partId` → octet-stream + filename
- [ ] **3.7** 前端：multipart 文件 part 若 stored 显示「下载」
- [ ] **3.8** 测试：小文件 part **默认**有行且下载字节一致；超限无行；纯 JSON 请求零 part 行；删 request CASCADE
- [ ] **3.9** data2 类 JSON 流量：无 multipart 时 `request_body_parts` 保持空

---

### Task 4（P4）: 文档与回归

- [ ] **4.1** 更新 `CLAUDE.md`：body 原样语义、multipart 摘要、`request_body_parts`（有文件默认写）、`maxBlobBytes`
- [ ] **4.2** README：`--max-blob-bytes`、有文件即存 part、删库说明
- [ ] **4.3** `npm run test:all` + `build` + `build:frontend`
- [ ] **4.4** 扩展 `.db/_analyze_data2b.py`：检测 `request_body` 是否仍出现 JSON string literal 双编码；multipart 摘要比例
- [ ] **4.5** （可选）BodyInspector pretty rAF generation；邻居轻量 API——可另开 issue

---

## 非目标（本计划不做）

- fs 外置大文件存储（二期）
- 响应 multipart 文件入库（一期仅 request）
- 改变 64MiB 取消策略
- 历史 DB 自动 migration / backfill
- **总开关关闭 blob**（已否决：有文件即存）

---

## 风险

| 风险 | 缓解 |
|------|------|
| 改写入语义导致 AI 前端假定 object | 读路径详情已能 parse string JSON；MessageFlow 用 parseBody |
| multipart 解析错误 | 失败则 fallback 存「无法解析」摘要 + raw 截断前 N 字符（可选）或不存 body |
| 文件流量撑爆 SQLite | 仅 file part 写入 + `maxBlobBytes` 硬顶 + 文档；JSON 主路径零行 |
| 与未提交透传改动冲突 | 在同一工作区顺序合入；先 P0/P1 |

---

## 验收

1. 文本 body 详情「原始」无多余引号；curl 与展示一致  
2. JSON body 行为与现网一致（可美化）  
3. multipart：详情见 parts 列表；小文件 part **自动**有 `request_body_parts` 行  
4. 小文件下载字节与上传 part 一致  
5. 超 `maxBlobBytes`：摘要 `stored:false`，无 part 行  
6. 纯 JSON 流量：无 part 行；`test:all` 绿  

---

## 建议执行顺序（给你）

```text
P0  review 竞态/徽章/catch          ~0.5–1d
P1  原样 body 写读                  ~0.5–1d
P2  multipart 摘要 + UI             ~1d
P3  request_body_parts 新表 + API   ~1–1.5d
P4  文档与回归                      ~0.5d
```

合计约 **3.5–5 人日**（视测试深度）。

---

## 决策锁定（本计划已采纳）

1. **Body 原样**：`request_body` TEXT 存原样字符串，不新增 body 列；机制**默认就有**。  
2. **文件字节：新表 `request_body_parts`**（不用 `request_blobs` 命名，避免与整段 body 混淆）。  
3. **有文件 part 即写 part 表，不要总开关**；仅 `maxBlobBytes` 做单 part 限流。  
4. **multipart**：摘要始终进 `request_body`；文件字节进 `request_body_parts`（未超限时）。
