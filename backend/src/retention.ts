/**
 * 数据轮转：retention.json 配置读写校验、轮转判定与 gzip 归档写出。
 *
 * 语义：仅按数据量轮转——记录总数超过「触发阈值 triggerCount」时，把最老
 * 的记录删除到只剩「保留量 keepCount」（删除动作与归档导出在 Recorder
 * Worker 的 retention.run RPC 内完成）。未启用则不清理；启用时两个阈值
 * 必填且 keepCount < triggerCount。配置文件与 routing.json 同目录，读写
 * 沿用同一模式：校验 → 临时文件原子替换 → 内存快照整体交换。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config';
import { getLogger, serializeError } from './logger';

const logger = getLogger('retention');

/** 单次轮转最多处理的记录条数：超出部分留给下一轮探查分批消化（避免大批量导出长时间阻塞 Worker） */
export const RETENTION_ROTATE_BATCH_LIMIT = 500;

/** 阈值上界：第二道防线，防止误配天文数字导致的误删规模失控 */
const THRESHOLD_MAX = 1_000_000;

/** 归档目录与文件名的单一来源：Worker 归档、Worker 列表、主线程下载白名单三处共用 */
export const ARCHIVE_FILE_PATTERN = /^archive-\d{8}-\d{6}\.json\.gz$/;

export function retentionArchiveDir(): string {
  return path.join(path.dirname(config.dbPath || '.'), 'retention-archive');
}

export function buildArchiveFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `archive-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json.gz`;
}

/**
 * 流式写出 gzip 压缩的归档文件：逐行 JSON.stringify 后经 gzip 层带背压写入，
 * 避免把整批记录拼成单个字符串的内存峰值（单行可达 MB 级），压缩显著缩小
 * 以文本为主的请求响应体归档体积。写出失败时销毁流并抛出，由调用方兜底
 * （归档失败即中止本轮删除，宁可下轮重试也不丢数据）。
 */
export async function writeArchiveFile(
  filePath: string,
  data: { triggerCount: number; keepCount: number; requests: unknown[]; toolCalls: unknown[] },
): Promise<void> {
  const output = fs.createWriteStream(filePath);
  const gzip = zlib.createGzip();
  gzip.pipe(output);
  // 输出流出错（如磁盘满）时让挂起的写 Promise 立即失败，避免等待已 unpiped 的 gzip 缓冲
  let outputError: Error | null = null;
  output.on('error', (error: Error) => { outputError ??= error; });
  // 显式 encoding 让 write(chunk, encoding, cb) 三参重载命中，避免回调被误判为 encoding
  const write = (chunk: string) => new Promise<void>((resolve, reject) => {
    if (outputError) { reject(outputError); return; }
    gzip.write(chunk, 'utf8', (error: Error | null | undefined) => (error ? reject(error) : resolve()));
  });
  try {
    await write(`{"archivedAt":${JSON.stringify(new Date().toISOString())},"triggerCount":${data.triggerCount},"keepCount":${data.keepCount},"requests":[`);
    for (let i = 0; i < data.requests.length; i++) {
      await write(i === 0 ? JSON.stringify(data.requests[i]) : `,${JSON.stringify(data.requests[i])}`);
    }
    await write('],"toolCalls":[');
    for (let i = 0; i < data.toolCalls.length; i++) {
      await write(i === 0 ? JSON.stringify(data.toolCalls[i]) : `,${JSON.stringify(data.toolCalls[i])}`);
    }
    await write(']}');
    // gzip.end 的回调只代表可写端结束：必须等输出流 finish（pipe 在 gzip 冲刷
    // 完成后自动 end 输出流），否则文件里是截断的 gzip 流
    await new Promise<void>((resolve, reject) => {
      if (outputError) { reject(outputError); return; }
      output.once('finish', resolve);
      const fail = (error: Error) => reject(error);
      output.once('error', fail);
      gzip.once('error', fail);
      gzip.end();
    });
  } catch (error) {
    gzip.destroy();
    output.destroy();
    throw error;
  }
}

export interface RetentionConfig {
  enabled: boolean;
  /** 触发阈值：记录总数超过该值时轮转 */
  triggerCount: number;
  /** 保留量：轮转后剩余的记录条数 */
  keepCount: number;
}

export interface RetentionDecision {
  rotate: boolean;
  /** 待删除（待归档）的最老记录条数 */
  toDelete: number;
}

interface RetentionRuntime {
  config: RetentionConfig;
  filePath: string;
}

let runtime: RetentionRuntime | null = null;

/** 配置文件的固定位置：与数据库同目录，随数据卷一起备份/迁移 */
export function retentionFilePath(): string {
  return path.join(path.dirname(config.dbPath || '.'), 'retention.json');
}

function loadConfig(filePath: string): RetentionConfig {
  const empty: RetentionConfig = { enabled: false, triggerCount: 0, keepCount: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error({ err: serializeError(error), filePath }, 'retention config read failed, using disabled config');
    }
    return empty;
  }
  try {
    const validated = validateRetentionConfig(JSON.parse(raw));
    if (!validated.ok) {
      logger.error({ filePath, errors: validated.errors }, 'retention config failed validation, using disabled config');
      return empty;
    }
    return validated.config;
  } catch (error) {
    logger.error({ err: serializeError(error), filePath }, 'retention config is not valid JSON, using disabled config');
    return empty;
  }
}

/** 启动时初始化；文件不存在视为未启用 */
export function initRetention(options?: { filePath?: string }): void {
  const filePath = options?.filePath ?? retentionFilePath();
  runtime = { config: loadConfig(filePath), filePath };
}

/** 保存新配置：校验 → 原子写文件 → 内存快照整体交换 */
export function replaceRetentionConfig(next: RetentionConfig): void {
  const validated = validateRetentionConfig(next);
  if (!validated.ok) {
    throw new Error(`轮转配置校验失败: ${validated.errors.join('; ')}`);
  }
  const current = runtime ?? { config: validated.config, filePath: retentionFilePath() };
  const tmpPath = `${current.filePath}.tmp`;
  fs.mkdirSync(path.dirname(current.filePath), { recursive: true });
  fs.writeFileSync(tmpPath, `${JSON.stringify(validated.config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, current.filePath);
  runtime = { config: validated.config, filePath: current.filePath };
  logger.info({ ...validated.config }, 'retention config replaced');
}

/** 读取当前配置（拷贝，避免调用方改写内存快照） */
export function getRetentionConfig(): RetentionConfig {
  if (!runtime) initRetention();
  return { ...runtime!.config };
}

/**
 * 强制重读文件后返回配置：配置保存在主线程（replaceRetentionConfig），
 * Worker 每次执行轮转前必须重读，否则会一直用启动时的旧配置。
 */
export function getRetentionConfigFresh(): RetentionConfig {
  if (!runtime) {
    initRetention();
    return { ...runtime!.config };
  }
  runtime = { config: loadConfig(runtime.filePath), filePath: runtime.filePath };
  return { ...runtime.config };
}

/** 判定当前总数是否需要轮转，并给出待删条数（纯函数） */
export function shouldRotate(total: number, conf: RetentionConfig): RetentionDecision {
  if (!conf.enabled) return { rotate: false, toDelete: 0 };
  if (total <= conf.triggerCount) return { rotate: false, toDelete: 0 };
  return { rotate: true, toDelete: total - conf.keepCount };
}

export type RetentionValidation =
  | { ok: true; config: RetentionConfig }
  | { ok: false; errors: string[] };

/** 校验并规范化：enabled 必须是布尔值；阈值字段须为整数（未启用时允许 0，便于保存空配置），启用时为必填正整数且保留量小于触发阈值 */
export function validateRetentionConfig(raw: unknown): RetentionValidation {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['配置必须是对象'] };
  }
  const input = raw as Record<string, unknown>;
  const enabled = input.enabled;
  if (typeof enabled !== 'boolean') {
    errors.push('enabled 必须是布尔值');
  }
  const triggerCount = input.triggerCount ?? 0;
  const keepCount = input.keepCount ?? 0;
  if (typeof triggerCount !== 'number' || !Number.isInteger(triggerCount) || triggerCount < 0) {
    errors.push('触发阈值 triggerCount 必须是整数');
  }
  if (typeof keepCount !== 'number' || !Number.isInteger(keepCount) || keepCount < 0) {
    errors.push('保留量 keepCount 必须是整数');
  }
  if (typeof triggerCount === 'number' && triggerCount > THRESHOLD_MAX) {
    errors.push(`触发阈值 triggerCount 不得超过 ${THRESHOLD_MAX}`);
  }
  if (typeof keepCount === 'number' && keepCount > THRESHOLD_MAX) {
    errors.push(`保留量 keepCount 不得超过 ${THRESHOLD_MAX}`);
  }
  if (enabled === true && typeof triggerCount === 'number' && typeof keepCount === 'number' && triggerCount >= 0 && keepCount >= 0) {
    if (triggerCount <= 0) errors.push('启用轮转时触发阈值 triggerCount 必须是正整数');
    if (keepCount <= 0) errors.push('启用轮转时保留量 keepCount 必须是正整数');
    if (triggerCount > 0 && keepCount > 0 && keepCount >= triggerCount) {
      errors.push('保留量 keepCount 必须小于触发阈值 triggerCount');
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: { enabled: enabled as boolean, triggerCount: triggerCount as number, keepCount: keepCount as number },
  };
}
