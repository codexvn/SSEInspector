import assert from 'node:assert/strict'
import {
  MAX_PRETTY_BODY_CHARS,
  defaultBodyTab,
  formatPrettyJson,
  getHeaderValue,
  mediaTypeOf,
  presentBody,
} from '../src/body-presentation'

function testMediaTypeAndHeaders(): void {
  assert.equal(mediaTypeOf('application/json; charset=utf-8'), 'application/json')
  assert.equal(mediaTypeOf(undefined), '')
  assert.equal(
    getHeaderValue({ 'Content-Type': 'application/json', Accept: '*/*' }, 'content-type'),
    'application/json',
  )
}

function testEmpty(): void {
  const p = presentBody(null)
  assert.equal(p.empty, true)
  assert.equal(p.kind, 'empty')
  assert.deepEqual(p.contentTabs, ['raw'])
}

function testJsonDefaultsToPretty(): void {
  const obj = presentBody({ a: 1, b: [2] }, 'application/json')
  assert.equal(obj.kind, 'json')
  assert.ok(obj.prettyText?.includes('\n'))
  assert.equal(obj.canPretty, true)
  assert.deepEqual(obj.contentTabs, ['raw', 'pretty'])
  assert.equal(obj.defaultTab, 'pretty')
  assert.equal(defaultBodyTab(obj.contentTabs, obj.defaultTab), 'pretty')

  const str = presentBody('{"x":1}', 'application/json')
  assert.equal(str.prettyText, '{\n  "x": 1\n}')
  assert.equal(str.defaultTab, 'pretty')
}

function testFormUrlEncoded(): void {
  const p = presentBody('foo=bar&baz=qux', 'application/x-www-form-urlencoded')
  assert.equal(p.kind, 'form-urlencoded')
  assert.deepEqual(p.formFields, [
    { key: 'foo', value: 'bar' },
    { key: 'baz', value: 'qux' },
  ])
  assert.deepEqual(p.contentTabs, ['fields', 'raw'])
  assert.equal(p.defaultTab, 'fields')
  assert.equal(p.canPretty, false)
}

function testMultipart(): void {
  const ct = 'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxk'
  const body = [
    '------WebKitFormBoundary7MA4YWxk',
    'Content-Disposition: form-data; name="file"; filename="a.txt"',
    'Content-Type: text/plain',
    '',
    'hello',
    '------WebKitFormBoundary7MA4YWxk',
    'Content-Disposition: form-data; name="desc"',
    '',
    'x',
    '------WebKitFormBoundary7MA4YWxk--',
  ].join('\r\n')
  const p = presentBody(body, ct)
  assert.equal(p.kind, 'multipart')
  assert.deepEqual(p.contentTabs, ['raw'])
  assert.ok(p.note?.includes('boundary='))
}

function testTextAndBinary(): void {
  const text = presentBody('hello world', 'text/plain')
  assert.equal(text.kind, 'text')
  assert.deepEqual(text.contentTabs, ['raw'])

  const binPayload = String.fromCharCode(0, 1, 2) + 'binary'
  const bin = presentBody(binPayload, 'application/octet-stream')
  assert.equal(bin.kind, 'binary')
  assert.ok(bin.note)
}

function testJsonContentTypeButInvalidBody(): void {
  const p = presentBody('not-json{', 'application/json')
  assert.equal(p.kind, 'json')
  assert.equal(p.prettyText, null)
  assert.equal(p.canPretty, false)
  assert.ok(p.note?.includes('解析失败'))
}

function testLargeJsonKeepsPrettyTabButDefaultsRaw(): void {
  const large = `{"data":"${'x'.repeat(MAX_PRETTY_BODY_CHARS)}"}`
  assert.ok(large.length > MAX_PRETTY_BODY_CHARS)
  const p = presentBody(large, 'application/json')
  assert.equal(p.kind, 'json')
  assert.equal(p.prettyText, null, '首屏不预计算美化')
  assert.equal(p.canPretty, true, '仍可手动美化')
  assert.deepEqual(p.contentTabs, ['raw', 'pretty'])
  assert.equal(p.defaultTab, 'raw')
  assert.ok(p.note?.includes('可手动切换到美化'))
  // 手动美化路径仍可用
  const manual = formatPrettyJson(large)
  assert.ok(manual != null && manual.includes('\n'))
}

function main(): void {
  testMediaTypeAndHeaders()
  testEmpty()
  testJsonDefaultsToPretty()
  testFormUrlEncoded()
  testMultipart()
  testTextAndBinary()
  testJsonContentTypeButInvalidBody()
  testLargeJsonKeepsPrettyTabButDefaultsRaw()
  console.log('body-presentation tests passed')
}

main()
