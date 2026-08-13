# SSEInspector

OpenAI / Anthropic API 代理检查器，实时记录流式请求和响应，无损转发 SSE 数据。

> 本项目全部代码由 AI（Claude Code）生成。

## 功能

- 代理 OpenAI (`/v1/chat/completions`、`/v1/responses`) 和 Anthropic (`/v1/messages`) 接口
- SSE 流式 delta 自动合并为完整响应
- **Monaco Editor** 展示 JSON（VS Code 原生代码折叠，词级展开/收起）
- 推理过程、回答正文、思考块、工具调用可视化展示
- 文本内容统一使用 Monaco 展示，支持 `Ctrl+F` 搜索
- 请求地址 / 代理地址分别显示，各自带 curl 复制按钮
- 工具调用结果 hover 显示对应 tool_use 详情
- 原始/合并响应体双视图切换
- 实时更新（Server-Sent Events），动态刷新导航位置
- 搜索过滤（模型名、内容）
- 未注册 AI path 的透传请求同样记录并入库（`apiType/apiEndpoint=passthrough`），可在列表「透传」筛选
- Pino 结构化代理生命周期日志，默认彩色终端输出，也可切换为 NDJSON 接入日志平台

## 安装

需要 Node.js 20.19+ 或 22.12+；不支持 Node.js 21。

```bash
git clone https://github.com/codexvn/SSEInspector.git
cd SSEInspector
npm install
npm --prefix frontend install
npm run build:all
```

`frontend/` 是独立 npm 项目，其依赖（vite、@vitejs/plugin-vue 等）不随根目录安装；缺少该步骤会导致 `npm start`（dev 模式 HMR）和 `build:frontend` 失败。仅通过 `npx` tarball 运行时无需安装任何依赖。

## 启动

### 生产模式（CLI 参数）

```bash
node bin/sse-inspector.js --upstream http://your-upstream:8000 --db-path ./data.db
```

### 开发模式（HMR）

```bash
npm start -- --upstream http://your-upstream:8000 --db-path ./data.db
```

`npm start` 等价于 `node bin/sse-inspector.js --dev`，同进程用 tsx 加载 TS 源码，前端 HMR 由 vite-express 提供。

参数：

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `--upstream <url>` | 是 | — | 上游 API 地址 |
| `--db-path <path>` | 是 | — | SQLite 数据库路径 |
| `--port <n>` | 否 | `3000` | 监听端口 |
| `--dev` | 否 | — | 开发模式（同进程 tsx + HMR，`npm start` 已内置） |
| `-h, --help` | — | — | 显示帮助 |

升级说明：实体 schema 发生不兼容变更时（例如新增必填的 `api_endpoint` 列），TypeORM 不会自动迁移历史数据——请直接删除 `--db-path` 指向的旧数据库文件后重启，由应用重建空库。

日志配置：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `LOG_FORMAT` | `pretty` | `pretty` 为彩色单行终端日志；`json` 为可供 Collector/Agent 采集的 Pino NDJSON |
| `LOG_LEVEL` | `info` | Pino 日志级别，如 `debug`、`info`、`warn`、`error` |

每个代理请求均输出可关联的 `proxy request started` 与结束事件。`upstream_complete` 和 `downstream_closed` 是正常的中性结束原因；请求上传中断使用 warning，上游异常使用 error。若客户端关闭时响应尚未包含 endpoint 的 terminal SSE 事件，Recorder Worker 会额外输出 `captured response is incomplete` warning。

## 使用

1. 启动后浏览器打开 `http://localhost:3000`
2. 将你的 API 客户端地址指向 `http://localhost:3000`
3. 发送请求即可在页面上实时看到记录

### 示例

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-xxx" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

## 请求流向

| 路径 | 处理方式 |
|------|---------|
| `POST /v1/chat/completions` | 代理 + 记录（OpenAI 格式） |
| `POST /v1/responses` | 代理 + 记录（OpenAI Responses 格式） |
| `POST /v1/messages` | 代理 + 记录（Anthropic 格式） |
| 其他路径 | 透明代理 + 透传记录（原始 headers/body，不做协议合并） |

请求头（`Authorization`、`x-api-key` 等）和响应头均原样透传，客户端感知不到代理存在。

## 技术栈

TypeScript + Express + Monaco Editor + 原生 JS SPA（无框架）

## 样例截图

![](./example/1.png)
![](./example/2.png)


## License

MIT
