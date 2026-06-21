/**
 * 中央运行时配置容器。
 *
 * 由 CLI 入口（bin/sse-inspector.js）在启动时通过 setConfig() 填充，
 * 随后被 index.ts / proxy.ts / db/index.ts 读取。
 *
 * 关键时序约束：db/index.ts 的 AppDataSource 在模块顶层求值，
 * 因此 bin 入口必须先 setConfig 再 require dist/index.js。
 */

export interface SseInspectorConfig {
  /** 上游 API 地址，必填，已校验非空（无尾斜杠） */
  upstreamUrl: string;
  /** 监听端口，默认 3000 */
  port: number;
  /** SQLite 数据库绝对路径，必填，已校验非空 */
  dbPath: string;
  /** 标记是否已完成配置，setConfig 后置为 true */
  configured: boolean;
}

const _config: SseInspectorConfig = {
  upstreamUrl: '',
  port: 3000,
  dbPath: '',
  configured: false,
};

/** 用部分字段覆盖现有配置，通常在进程启动早期调用一次 */
export function setConfig(patch: Partial<SseInspectorConfig>): void {
  Object.assign(_config, patch);
  _config.configured = true;
}

/**
 * 断言配置已就绪。db 模块顶层调用，确保 AppDataSource 求值时 dbPath 非空，
 * 避免落入 better-sqlite3 对空路径的晦涩报错。
 */
export function assertConfigured(): void {
  if (!_config.configured || !_config.dbPath) {
    throw new Error(
      '[config] 运行时配置未初始化：dbPath 为空。' +
      '请通过 CLI 入口 bin/sse-inspector.js 启动，或在 require dist/index.js 前 setConfig。',
    );
  }
}

export const config: SseInspectorConfig = _config;
