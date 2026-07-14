import assert from 'node:assert/strict'
import { formatTokenSpeed } from '../src/token-speed'

assert.equal(formatTokenSpeed('streaming', undefined, 1000), '接收中')
assert.equal(formatTokenSpeed('done', 100, 2000), '50.0 tok/s')
assert.equal(formatTokenSpeed('done', undefined, 2000), '-')
assert.equal(formatTokenSpeed('error', 20, 1000), '20.0 tok/s')
assert.equal(formatTokenSpeed('done', 20, 0), '-')

console.log('token speed tests passed')
