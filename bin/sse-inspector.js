#!/usr/bin/env node
'use strict';

/**
 * SSEInspector CLI 入口。
 *
 * 不经过 tsc，直接作为 tarball 内的 CJS 文件运行。
 * npx 拉取 tarball 后，npm 自动安装依赖（含 better-sqlite3 预编译二进制），
 * 随后执行本文件，解析参数、填充 config、启动后端。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// ---- 极简参数解析（无依赖）----
// 支持形态：--upstream URL | --upstream=URL | --port N | --db-path PATH | --help | -h
function parseArgs(argv) {
  const opts = { upstream: undefined, port: 3000, dbPath: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
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
      console.error(`未知参数: ${a}`);
      opts.help = true;
    }
  }
  return opts;
}

function showHelp() {
  console.log(`
sse-inspector - SSE Inspector & API Proxy

用法:
  sse-inspector --upstream <url> [options]
  npx https://github.com/codexvn/SSEInspector/releases/download/v1.0.0/sse-inspector-v1.0.0.tgz --upstream http://localhost:8000

参数:
  --upstream <url>     上游 API 地址（必填），如 http://localhost:8000
  --port <n>           监听端口（默认 3000）
  --db-path <path>     SQLite 数据库路径（默认 ~/.sseinspector/data.db）
  -h, --help           显示帮助
`);
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  showHelp();
  process.exit(0);
}

if (!opts.upstream || Number.isNaN(opts.port)) {
  if (!opts.upstream) console.error('错误: 缺少必填参数 --upstream');
  if (Number.isNaN(opts.port)) console.error('错误: --port 不是合法数字');
  showHelp();
  process.exit(1);
}

// ---- 解析默认数据库路径：~/.sseinspector/data.db ----
let dbPath = opts.dbPath;
if (!dbPath) {
  dbPath = path.join(os.homedir(), '.sseinspector', 'data.db');
}
// 确保目录存在
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
// 转绝对路径（SQLite 相对路径是相对 cwd，不够直观）
if (!path.isAbsolute(dbPath)) {
  dbPath = path.resolve(process.cwd(), dbPath);
}

// ---- 关键顺序：先 setConfig，再 require 入口 ----
// dist/index.js 顶层 import './db' 会立即触发 new DataSource(database: config.dbPath)，
// 因此 config.dbPath 必须在 require dist/index.js 之前就绪。
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const { setConfig } = require('../dist/config');
setConfig({
  upstreamUrl: opts.upstream.replace(/\/$/, ''), // 去尾斜杠
  port: opts.port,
  dbPath: dbPath,
});

// 至此配置就绪，触发 AppDataSource 求值并启动服务
require('../dist/index.js');
