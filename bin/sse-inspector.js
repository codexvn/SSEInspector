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
 * 关键顺序：先 setConfig，再 require 主线程入口。数据库只由 Recorder Worker 加载，
 * Worker 通过 workerData 接收同一运行时配置，设置完成后才加载 DataSource。
 */

const path = require('path');
const fs = require('fs');
const { parseArgs, getHelpText } = require('./parse-args');

const parsed = parseArgs(process.argv.slice(2));
const opts = parsed.options;
process.env.NODE_ENV = process.env.NODE_ENV || (opts.dev ? 'development' : 'production');

let setConfig;
let startBackend;
let getLogger;
if (opts.dev) {
  const { register, require: tsxRequire } = require('tsx/cjs/api');
  register();
  ({ getLogger } = tsxRequire('../backend/src/logger.ts', __filename));
  ({ setConfig } = tsxRequire('../backend/src/config.ts', __filename));
  startBackend = () => tsxRequire('../backend/src/index.ts', __filename);
} else {
  ({ getLogger } = require('../dist/logger'));
  ({ setConfig } = require('../dist/config'));
  startBackend = () => require('../dist/index.js');
}
const logger = getLogger('cli');

if (parsed.errors.length > 0) {
  for (const error of parsed.errors) {
    logger.error({ code: error.code, argument: error.argument }, 'unknown CLI argument');
  }
  process.stderr.write(getHelpText());
  process.exitCode = 1;
} else if (opts.help) {
  process.stdout.write(getHelpText());
} else if (!opts.upstream || Number.isNaN(opts.port)) {
  if (!opts.upstream) logger.error({ argument: '--upstream' }, 'required CLI argument is missing');
  if (Number.isNaN(opts.port)) logger.error({ argument: '--port' }, 'CLI argument is invalid');
  process.stderr.write(getHelpText());
  process.exitCode = 1;
} else if (!opts.dbPath) {
  logger.error({ argument: '--db-path' }, 'required CLI argument is missing');
  process.stderr.write(getHelpText());
  process.exitCode = 1;
} else {
  start(opts.dbPath);
}

function start(dbPath) {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  if (!path.isAbsolute(dbPath)) {
    dbPath = path.resolve(process.cwd(), dbPath);
  }

  setConfig({
    upstreamUrl: opts.upstream.replace(/\/$/, ''),
    port: opts.port,
    dbPath,
  });
  startBackend();
}
