# SSEInspector Agent 约束

SSEInspector 是 OpenAI / Anthropic API 的透明代理检查器：请求响应字节尽量原样透传，原始流（raw SSE / raw body）必须保留，合并结果只用于展示，且需兼容 OpenAI-compatible、Anthropic-compatible、GLM、vLLM、私有网关等多供应商变体。本文件是所有 AI 编码代理在本仓库工作时的约束与命令入口；项目架构、目录职责与设计决策见 `docs/architecture.md`。

## 常用命令

```bash
npm start -- --upstream http://localhost:8000 --db-path ./data.db   # 开发模式（tsx + HMR）
npm run build                                                       # 后端构建
npm run build:frontend                                              # 前端构建
npm run build:all                                                   # 后端 + 前端全量构建
npm run test:sse                                                    # SSE 合并回归测试
npm run test:decode                                                 # 请求体解码纯函数测试
npm run test:identity                                               # 记录身份解析测试
npm run test:passthrough-store                                      # 透传 store 读写 / filter / counts 测试
npm run test:proxy                                                  # 代理数据面字节透传测试
npm run test:worker                                                 # Recorder Worker dev/prod 测试
npm run test:logger                                                 # 日志测试
npm run test:cli-logging                                            # CLI 输出测试
npm run test:all                                                    # 全量测试
```

运行时要求 Node.js 20.19+ 或 22.12+，不支持 Node.js 21；未列出的其余专项测试脚本见 `package.json`（`test:all` 为全量入口）。技术栈：TypeScript + Express（CJS）+ httpxy + TypeORM/SQLite + Vite/Vue/Monaco + Pino。

## 代理数据面红线

1. `backend/src/proxy.ts` 中 httpxy 是 request/response pipe、背压、headers、双向 socket 销毁的唯一所有者。禁止重新引入手写 `http.request`、`res.write` 循环或 `selfHandleResponse`。
2. 原始字节原样保存，`responseContent` 等合并结果是展示层产物，不得替代、截断或改写原始响应数据。
3. 代理主线程不解析 JSON/SSE、不计算 token、不访问数据库。SSE 合并、usage、preview、工具配对、TypeORM/SQLite 只属于 Recorder Worker（`backend/src/recorder/worker.ts`）；Express 查询一律经 Worker RPC。capture 的 chunk 与生命周期控制消息必须保序进入同一延迟队列。
4. 协议身份只来源于 endpoint 注册表（`backend/src/endpoints.ts`）与记录的 `api_endpoint` 列。未知 path 一律透传（`passthrough`），不得默认回退 Chat，不得从 SSE 内容猜测协议。

## 协议兼容与测试

5. 修改 `sse-parser.ts`、`sse-merger.ts`、`stream-accumulators/*` 或流式类型时，必须遵守 `docs/architecture.md` 的「流式合并维护规则」（字段保留清单、terminal 语义等），同步补充回归测试，且 `npm run test:sse` 与 `npm run build` 通过后才算完成。
6. 第三方供应商会返回官方类型之外的字段和事件（如 `reasoning_content`、`response.metadata`）：合并器应保留这些字段和事件而不是丢弃；透传记录不做协议 terminal 判断。
7. token 统计只用上游 usage；禁止为未知模型引入本地 tokenizer 重算。

## 工程规范

8. 日志统一使用 `backend/src/logger.ts` 的 Pino logger，`backend/src` 与 `bin` 禁止 `console.log/warn/error`；catch 块不得静默吞异常，日志须保留异常类型与 cause 链。稳定字段名：`component`、`requestId`、`method`、`path`、`target`、`status`、`durationMs`、`reason`、`err`。不得残留 `[CCGUI_DEBUG_]` 临时调试日志；添加临时调试日志前先向用户确认标识符。
9. `.tmp/CLIProxyAPI` 是临时参考克隆（供 Responses WebSocket 实现对照），禁止修改其中代码；`.tmp/` 目录整体不提交，也不得新增 vendor 快照。
10. 未经用户明确允许不得 `git commit`；commit 信息使用简体中文 Conventional Commits 格式。提交前检查 diff：无敏感信息、无调试日志残留、catch 块完整记录异常、无与本次需求无关的噪音改动。
11. 修改关键目录、协议、合并架构或命令后，按 `docs/architecture.md` 的「文档同步规则」同步更新文档。

## 边界

- ✅ 总是做：diff 只含本次需求必需改动；新代码跟随所在文件的现有风格；修改合并架构、端口、目录或命令后同步更新 `docs/architecture.md`。
- ⚠️ 先询问：数据库 entity 不兼容变更（项目策略是删库重建，需确认数据可弃）；新增运行时依赖；新增顶层目录。
- 🚫 绝不做：提交 token、密码、密钥等敏感信息；绕过 Recorder Worker 直连数据库；为让测试通过而删改断言；在代理数据面做阻塞式解析。

## 语言与文档规范

12. 全局语言规范：UI 文案、代码注释、文档、commit 信息使用简体中文；标识符与路径保持英文。
13. 新增或修改的代码必须携带注释：说明模块、函数意图与非显而易见的约束，跟随所在文件的既有注释密度，不写复述代码字面行为的注释。
14. 设计文档、方案文档等技术文档统一写入 `docs/` 目录，不得散落在仓库根目录或源码目录。
15. 文档面向资深研发：不赘述基础技术细节（协议科普、框架入门等），直接陈述方案、数据结构与关键取舍。
16. 文档以段落推进为主，辅以列表、表格与图表（Mermaid 或 ASCII），重点突出技术要点与数据结构定义。
17. 文档初稿完成后，必须启动一个 SubAgent 对文档做语法与表达 review（句子完整性、术语一致性、错别字、结构连贯），按 review 意见修订后再交付。

## 写作红线与内容边界

以下要求适用于所有输出形态：对话回复、分析结论、方案建议、文档与 commit 信息，不限于 `docs/` 下的文档。

18. 所有输出使用符合中文语法的正式书面语。句子成分完整：不出现名词短语堆叠、缺主谓宾或缺「的/了/被/在」等助词的压缩式表述；清单条目、命令、代码与表格单元格可豁免。每个论断必须有数字、对比、代码或原因之一支撑，无依据的形容词性论断不得保留。敏感信息不写入任何交付物。
19. 英文术语不逐字直译成不通顺的中文，用等价中文表述或将英文原词放进完整句子；缩写首次出现时展开（token、HTTP、API 等基础词除外）；不用隐喻和黑话（如「落地」「拍板」「闭环」「钉死」）代替明确描述；关键领域术语首次出现时用一句中文定义。
20. 正文每段只承载一个主题，段与段之间用连接词显式表达逻辑关系；表格只承载数据，不做正文骨架；章节标题是可独立理解的完整短语，不使用压缩式术语标题。
21. 文档只写方案本身（目标、规则、接口、数据、用例与验收标准）；决策过程的叙述、被否决方案的讨论、评审经过与「用户要求/后补」式批注不写入文档；候选方案对比与取舍理由属于正文内容，不算过程性内容。
22. 技术方案与设计文档按六个要素组织：背景与问题、目标与非目标、方案对比与决策论证、详细设计、风险与开放问题、验收标准；开头用一段导语写清背景痛点、做了什么与核心成果（带数字），让读者 30 秒内判断是否继续阅读。
