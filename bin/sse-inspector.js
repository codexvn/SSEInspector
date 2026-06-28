#!/usr/bin/env node
'use strict'

/**
 * SSEInspector CLI 入口（dev / prod 合一）。
 *
 * 不经过 tsc，直接作为 tarball 内的 CJS 文件运行。
 * npx 拉取 tarball 后，npm 自动安装依赖（含 better-sqlite3 预编译二进制），
 * 随后执行本文件：解析参数、填充 config、启动后端。
 *
 * 两种模式：
 * - 生产模式（默认）：加载 dist/ 编译产物，不依赖 tsx。
 * - 开发模式（--dev）：同进程 tsx 加载 backend/src TS 源码，前端 HMR 由 vite-express 提供。
 *   tsx 是 devDependency，惰性 require 在 --dev 分支内，prod 路径不会执行。
 *
 * 关键顺序：先 setConfig，再 require 入口。
 * dist/index.js（或 backend/src/index.ts）顶层 import './db' 会立即触发
 * new DataSource(database: config.dbPath)，因此 config.dbPath 必须在加载入口前就绪。
 */

const path = require('path');
const fs = require('fs');
const { parseArgs, showHelp } = require('./parse-args');

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

// dbPath 必填，dev/prod 均无默认值
let dbPath = opts.dbPath;
if (!dbPath) {
  console.error('错误: 缺少必填参数 --db-path');
  showHelp();
  process.exit(1);
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

process.env.NODE_ENV = process.env.NODE_ENV || (opts.dev ? 'development' : 'production');

const cfg = {
  upstreamUrl: opts.upstream.replace(/\/$/, ''), // 去尾斜杠
  port: opts.port,
  dbPath: dbPath,
};

if (opts.dev) {
  // 开发模式：同进程 tsx 加载 TS 源码（tsx 是 devDependency，惰性 require，prod 不会执行到这里）
  const { register, require: tsxRequire } = require('tsx/cjs/api');
  register();
  const { setConfig } = tsxRequire('../backend/src/config.ts', __filename);
  setConfig(cfg);
  // 至此配置就绪，触发 AppDataSource 求值并启动服务
  tsxRequire('../backend/src/index.ts', __filename);
} else {
  // 生产模式：加载 dist 构建产物（不依赖 tsx）
  const { setConfig } = require('../dist/config');
  setConfig(cfg);
  // 至此配置就绪，触发 AppDataSource 求值并启动服务
  require('../dist/index.js');
}
