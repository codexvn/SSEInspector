/**
 * 多上游分流路由：规则解析、配置校验与进程内配置单例。
 *
 * 职责边界：配置以 JSON 文件（与 SQLite 同目录的 routing.json）持久化，
 * 启动与设置保存两个时机做一次性小文件同步 IO；代理数据面每请求只做
 * 同步内存查找（读不可变快照，保存时整体替换引用），不触碰 Recorder
 * Worker 与数据库（AGENTS.md 第 3 条限制的是每请求数据面路径）。
 *
 * 语义：规则按数组顺序自上而下，第一条启用且前缀命中（段边界）的生效；
 * 命中规则时前缀按挂载点语义在转发时剥离（/easytier/v1/models → 上游收到
 * /v1/models；需要在上游保留前缀时，把前缀写入规则上游地址的路径即可组合
 * 还原）。未命中回落默认上游（默认不剥离）；两者皆无时由调用方明确拒绝
 * 请求。CLI --upstream 显式传入时作为本次运行的默认上游，覆盖界面持久值
 *（不回写文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { getLogger, serializeError } from './logger';

const logger = getLogger('routing');

export interface UpstreamRoute {
  id: string;
  /** 展示名，可为空串 */
  name: string;
  enabled: boolean;
  /** 以 / 开头的路径前缀，按段边界匹配 */
  prefix: string;
  /** http(s) 地址，允许携带路径前缀（转发时与请求路径拼接） */
  upstream: string;
}

export interface PersistedRoutingConfig {
  /** 界面持久化的默认上游；null 表示不设默认 */
  defaultUpstream: string | null;
  /** 顺序即优先级 */
  routes: UpstreamRoute[];
}

export interface RoutingState {
  cliUpstream: string | null;
  persistedDefault: string | null;
  effectiveDefault: string | null;
  routes: UpstreamRoute[];
}

export interface ResolvedUpstream {
  upstream: string;
  source: 'route' | 'default';
  routeName: string;
  /** 命中规则的匹配前缀（默认上游为 undefined）；转发时据此剥离（挂载点语义） */
  prefix?: string;
}

interface RoutingRuntime {
  cliUpstream: string | null;
  persisted: PersistedRoutingConfig;
  effectiveDefault: string | null;
  filePath: string;
}

let runtime: RoutingRuntime | null = null;

/** 规则文件的固定位置：与数据库同目录，随数据卷一起备份/迁移 */
export function routingFilePath(): string {
  return path.join(path.dirname(config.dbPath || '.'), 'routing.json');
}

/**
 * 惰性初始化兜底：模块未显式 initRouting 时按 CLI 单上游语义合成配置，
 * 保持仅 setConfig 的既有用法（历史测试、嵌入式启动）行为不变。
 */
function ensureRuntime(): RoutingRuntime {
  if (!runtime) {
    const cliUpstream = config.upstreamUrl || null;
    runtime = {
      cliUpstream,
      persisted: { defaultUpstream: null, routes: [] },
      effectiveDefault: cliUpstream,
      filePath: routingFilePath(),
    };
  }
  return runtime;
}

/**
 * 启动时初始化：读取 routing.json（不存在视为空配置；损坏记 ERROR 后按
 * 空配置启动，界面重新保存即修复），并固化 CLI 默认上游的覆盖关系。
 * CLI 上游沿用与转发一致的拼接语义，允许携带路径前缀，此处做同规格校验，
 * 非法值直接抛错终止启动（比运行期逐请求失败更早暴露配置错误）。
 */
export function initRouting(options: { cliUpstream: string | null; filePath: string }): void {
  if (options.cliUpstream != null) {
    const errors: string[] = [];
    const normalized = normalizeUpstream(options.cliUpstream, '--upstream', errors);
    if (normalized === null) {
      throw new Error(`--upstream 配置非法: ${errors.join('; ')}`);
    }
    options = { ...options, cliUpstream: normalized };
  }
  const persisted = loadPersisted(options.filePath);
  runtime = {
    cliUpstream: options.cliUpstream,
    persisted,
    effectiveDefault: options.cliUpstream ?? persisted.defaultUpstream,
    filePath: options.filePath,
  };
}

function loadPersisted(filePath: string): PersistedRoutingConfig {
  const empty: PersistedRoutingConfig = { defaultUpstream: null, routes: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error({ err: serializeError(error), filePath }, 'routing config read failed, using empty config');
    }
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.error({ err: serializeError(error), filePath }, 'routing config is not valid JSON, using empty config');
    return empty;
  }
  const validated = validateRoutingConfig(parsed);
  if (!validated.ok) {
    logger.error({ filePath, errors: validated.errors }, 'routing config failed validation, using empty config');
    return empty;
  }
  return validated.config;
}

/**
 * 保存新配置：校验 → 临时文件原子替换 → 内存快照整体交换。
 * 在途请求继续读旧快照，无锁无竞态。配置决定此后全部流量去向，成功替换
 * 留一条 info 便于运维追溯变更时刻。
 */
export function replaceRoutingConfig(next: PersistedRoutingConfig): void {
  const current = ensureRuntime();
  const validated = validateRoutingConfig(next);
  if (!validated.ok) {
    throw new Error(`路由配置校验失败: ${validated.errors.join('; ')}`);
  }
  const tmpPath = `${current.filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(validated.config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, current.filePath);
  runtime = {
    cliUpstream: current.cliUpstream,
    persisted: validated.config,
    effectiveDefault: current.cliUpstream ?? validated.config.defaultUpstream,
    filePath: current.filePath,
  };
  logger.info(
    { defaultUpstream: runtime.effectiveDefault, routes: validated.config.routes.length },
    'routing config replaced',
  );
}

/** 设置 API 读取完整状态（深拷贝，避免调用方改写内存快照） */
export function getRoutingState(): RoutingState {
  const rt = ensureRuntime();
  return {
    cliUpstream: rt.cliUpstream,
    persistedDefault: rt.persisted.defaultUpstream,
    effectiveDefault: rt.effectiveDefault,
    routes: rt.persisted.routes.map(route => ({ ...route })),
  };
}

/** 数据面热路径：解析下游 pathname 的目标上游；无规则命中且无默认上游返回 null */
export function resolveUpstream(pathname: string): ResolvedUpstream | null {
  const rt = ensureRuntime();
  for (const route of rt.persisted.routes) {
    if (!route.enabled) continue;
    if (prefixMatches(route.prefix, pathname)) {
      return { upstream: route.upstream, source: 'route', routeName: route.name, prefix: route.prefix };
    }
  }
  if (rt.effectiveDefault) {
    return { upstream: rt.effectiveDefault, source: 'default', routeName: '' };
  }
  return null;
}

/**
 * 段边界前缀匹配：`/v1` 命中 `/v1` 与 `/v1/...`，不命中 `/v1foo`，
 * 避免字符串前缀带来的歧义。
 */
export function prefixMatches(prefix: string, pathname: string): boolean {
  if (prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export type RoutingValidation =
  | { ok: true; config: PersistedRoutingConfig }
  | { ok: false; errors: string[] };

/**
 * 校验并规范化整份配置：prefix 必须是合法路径前缀（补全开头 /、去尾斜杠、
 * 禁止 query/hash），upstream 与 defaultUpstream 必须是合法 http(s) 地址
 * （允许携带路径前缀，与 CLI --upstream 的拼接语义一致；禁止 query、
 * hash 与凭证），id 唯一非空。错误以中文清单返回。
 */
export function validateRoutingConfig(raw: unknown): RoutingValidation {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['配置必须是对象'] };
  }
  const input = raw as Record<string, unknown>;

  let defaultUpstream: string | null = null;
  if (input.defaultUpstream !== null && input.defaultUpstream !== undefined) {
    const normalized = normalizeUpstream(input.defaultUpstream, '默认上游', errors);
    defaultUpstream = normalized;
  }

  const routes: UpstreamRoute[] = [];
  if (!Array.isArray(input.routes)) {
    errors.push('routes 必须是数组');
  } else {
    const seenIds = new Set<string>();
    input.routes.forEach((item, index) => {
      const label = `规则 #${index + 1}`;
      if (typeof item !== 'object' || item === null) {
        errors.push(`${label} 必须是对象`);
        return;
      }
      const route = item as Record<string, unknown>;
      if (typeof route.id !== 'string' || route.id.length === 0) {
        errors.push(`${label} 缺少有效 id`);
      } else if (seenIds.has(route.id)) {
        errors.push(`${label} id 重复: ${route.id}`);
      } else {
        seenIds.add(route.id);
      }
      const name = typeof route.name === 'string' ? route.name : '';
      if (typeof route.enabled !== 'boolean') {
        errors.push(`${label} enabled 必须是布尔值`);
      }
      const prefix = normalizePrefix(route.prefix, `${label} 前缀`, errors);
      const upstream = normalizeUpstream(route.upstream, `${label} 上游`, errors);
      if (prefix !== null && upstream !== null) {
        routes.push({ id: route.id as string, name, enabled: route.enabled as boolean, prefix, upstream });
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { defaultUpstream, routes } };
}

function normalizePrefix(raw: unknown, label: string, errors: string[]): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push(`${label} 必须是非空字符串`);
    return null;
  }
  if (/[\s?#]/.test(raw)) {
    errors.push(`${label} 不得包含空白、? 或 #`);
    return null;
  }
  let prefix = raw.startsWith('/') ? raw : `/${raw}`;
  if (prefix !== '/') prefix = prefix.replace(/\/+$/, '');
  return prefix;
}

/** 校验并规范化上游地址：http(s)，允许路径前缀，禁止 query/hash/凭证；返回去尾斜杠的规范形 */
function normalizeUpstream(raw: unknown, label: string, errors: string[]): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push(`${label} 必须是非空字符串`);
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    errors.push(`${label} 不是合法 URL: ${raw}`);
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push(`${label} 必须是 http/https 地址: ${raw}`);
    return null;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    errors.push(`${label} 不得携带 query、hash 或凭证: ${raw}`);
    return null;
  }
  const pathSuffix = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + pathSuffix;
}
