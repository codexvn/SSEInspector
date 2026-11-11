#!/usr/bin/env node
'use strict'

/**
 * SSEInspector 共享参数解析。
 *
 * 纯 CJS、无依赖，供 bin/sse-inspector.js 在 dev / prod 两种模式下复用。
 * 支持形态：
 *   --upstream URL | --upstream=URL   默认上游地址（可选；缺省时使用设置页持久化值）
 *   --port N | --port=N               监听端口（默认 3000）
 *   --db-path PATH | --db-path=PATH   SQLite 数据库路径（必填，无默认值）
 *   --dev                             开发模式：同进程 tsx 加载 TS 源码，启用前端 HMR
 *   -h, --help                        显示帮助
 */

function parseArgs(argv) {
  const opts = { upstream: undefined, port: 3000, dbPath: undefined, dev: false, help: false };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--dev') {
      opts.dev = true;
    } else if (a === '--upstream') {
      opts.upstream = argv[++i];
    } else if (a.startsWith('--upstream=')) {
      opts.upstream = a.slice('--upstream='.length);
    } else if (a === '--port') {
      opts.port = parseInt(argv[++i], 10);
    } else if (a.startsWith('--port=')) {
      opts.port = parseInt(a.slice('--port='.length), 10);
    } else if (a === '--db-path') {
      opts.dbPath = argv[++i];
    } else if (a.startsWith('--db-path=')) {
      opts.dbPath = a.slice('--db-path='.length);
    } else if (!a.startsWith('-')) {
      // 忽略裸路径（向后兼容旧的位置参数用法）
    } else {
      errors.push({ code: 'unknown_argument', message: `未知参数: ${a}`, argument: a });
      opts.help = true;
    }
  }
  return { options: opts, errors };
}

function getHelpText() {
  return `
sse-inspector - SSE Inspector & API Proxy

用法:
  sse-inspector --db-path <path> [options]
  npx https://github.com/codexvn/SSEInspector/releases/download/v1.0.0/sse-inspector-v1.0.0.tgz --upstream http://localhost:8000 --db-path ./data.db
  npm start -- --upstream http://localhost:8000 --db-path ./data.db   # 开发模式

参数:
  --upstream <url>     默认上游地址（可选），如 http://localhost:8000；
                       显式传入时覆盖设置页保存的默认上游（仅本次运行生效）
  --db-path <path>     SQLite 数据库路径（必填，无默认值），如 ./data.db
  --port <n>           监听端口（默认 3000）
  --dev                开发模式：同进程加载 TS 源码，启用前端 HMR（npm start 已内置）
  -h, --help           显示帮助

多上游分流：启动后访问设置页（/settings）维护「路径前缀 → 上游」规则与默认上游，
配置持久化在数据库同目录的 routing.json。
`;
}

module.exports = { parseArgs, getHelpText };
