import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const { parseArgs, getHelpText } = require('../../bin/parse-args') as {
  parseArgs(argv: string[]): {
    options: { help: boolean; dev: boolean }
    errors: Array<{ code: string; message: string; argument?: string }>
  }
  getHelpText(): string
}

const parsed = parseArgs(['--dev', '--unknown'])
assert.equal(parsed.options.dev, true)
assert.equal(parsed.options.help, true)
assert.deepEqual(parsed.errors, [{
  code: 'unknown_argument',
  message: '未知参数: --unknown',
  argument: '--unknown',
}])
assert.match(getHelpText(), /sse-inspector - SSE Inspector & API Proxy/)

const result = spawnSync(
  process.execPath,
  [path.join(process.cwd(), 'bin', 'sse-inspector.js'), '--dev', '--unknown'],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      LOG_FORMAT: 'json',
      LOG_LEVEL: 'info',
    },
  },
)

assert.equal(result.status, 1)
const jsonLine = result.stdout.split(/\r?\n/).find(line => line.startsWith('{'))
assert.ok(jsonLine, `应输出 Pino JSON 日志，实际 stdout: ${result.stdout}`)
const log = JSON.parse(jsonLine) as Record<string, unknown>
assert.equal(log.component, 'cli')
assert.equal(log.level, 50)
assert.equal(log.msg, 'unknown CLI argument')
assert.equal(log.argument, '--unknown')
assert.doesNotMatch(result.stdout, /用法:/)
assert.match(result.stderr, /用法:/)

console.log('cli logging tests passed')
