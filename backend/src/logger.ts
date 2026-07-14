import os from 'node:os'
import pino, { type DestinationStream, type LevelWithSilent, type Logger } from 'pino'
import pretty from 'pino-pretty'

export type LogFormat = 'pretty' | 'json'

export interface LogConfig {
  format: LogFormat
  level: LevelWithSilent
}

export interface SerializedError {
  type: string
  message: string
  stack?: string
  cause?: SerializedError
}

interface CreateLoggerOptions {
  destination?: NodeJS.WritableStream
  colorize?: boolean
}

const LOG_LEVELS = new Set<LevelWithSilent>([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
])

const rootLogger = createAppLogger(resolveLogConfig(process.env))
const childLoggers = new Map<string, Logger>()

export function resolveLogConfig(env: NodeJS.ProcessEnv): LogConfig {
  const format = env.LOG_FORMAT ?? 'pretty'
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`LOG_FORMAT 只支持 pretty 或 json: actual=${format}`)
  }

  const level = env.LOG_LEVEL ?? 'info'
  if (!LOG_LEVELS.has(level as LevelWithSilent)) {
    throw new Error(`LOG_LEVEL 非法: actual=${level}`)
  }

  return { format, level: level as LevelWithSilent }
}

export function serializeError(error: unknown): SerializedError {
  return serializeErrorValue(error, new Set())
}

export function formatErrorChain(error: unknown): string {
  const parts: string[] = []
  let current: SerializedError | undefined = serializeError(error)
  while (current) {
    parts.push(`${current.type}: ${current.message}`)
    current = current.cause
  }
  return parts.join(' -> ')
}

export function createAppLogger(config: LogConfig, options: CreateLoggerOptions = {}): Logger {
  const loggerOptions: pino.LoggerOptions = {
    level: config.level,
    base: {
      service: 'sse-inspector',
      pid: process.pid,
      hostname: os.hostname(),
    },
    serializers: {
      err: value => value instanceof Error ? serializeError(value) : value,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }
  const destination = options.destination ?? process.stdout
  if (config.format === 'json') {
    return pino(loggerOptions, destination as DestinationStream)
  }

  const prettyStream = pretty({
    colorize: options.colorize ?? true,
    singleLine: true,
    levelFirst: true,
    translateTime: 'SYS:standard',
    sync: true,
    destination,
  })
  return pino(loggerOptions, prettyStream)
}

export function getLogger(component: string): Logger {
  const existing = childLoggers.get(component)
  if (existing) return existing
  const child = rootLogger.child({ component })
  childLoggers.set(component, child)
  return child
}

function serializeErrorValue(error: unknown, seen: Set<unknown>): SerializedError {
  if (!(error instanceof Error)) {
    return {
      type: error === null ? 'null' : typeof error,
      message: String(error),
    }
  }
  if (seen.has(error)) {
    return {
      type: error.name || 'Error',
      message: `${error.message} (circular cause)`,
      stack: error.stack,
    }
  }

  seen.add(error)
  return {
    type: error.name || 'Error',
    message: error.message,
    stack: error.stack,
    cause: error.cause === undefined ? undefined : serializeErrorValue(error.cause, seen),
  }
}
