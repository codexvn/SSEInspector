import assert from 'node:assert/strict'
import {
  MAX_PRETTY_BODY_CHARS,
  defaultBodyViewer,
  formatPrettyJson,
  formatPrettyXml,
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
  assert.deepEqual(p.viewers, ['raw'])
}

function testJsonDefaultsToJsonViewer(): void {
  const obj = presentBody({ a: 1, b: [2] }, 'application/json')
  assert.equal(obj.kind, 'json')
  assert.ok(obj.prettyJson?.includes('\n'))
  assert.equal(obj.canPrettyJson, true)
  assert.deepEqual(obj.viewers, ['raw', 'json'])
  assert.equal(obj.defaultViewer, 'json')
  assert.equal(defaultBodyViewer(obj.viewers, obj.defaultViewer), 'json')

  const str = presentBody('{"x":1}', 'application/json')
  assert.equal(str.prettyJson, '{\n  "x": 1\n}')
  assert.equal(str.defaultViewer, 'json')
}

function testXmlViewers(): void {
  const declared = presentBody('<root><a>1</a><b attr="x"/></root>', 'application/xml')
  assert.equal(declared.kind, 'xml')
  assert.deepEqual(declared.viewers, ['raw', 'xml'])
  assert.equal(declared.defaultViewer, 'xml')
  assert.equal(declared.monacoLang, 'xml')
  assert.equal(declared.prettyXml, [
    '<root>',
    '  <a>',
    '    1',
    '  </a>',
    '  <b attr="x"/>',
    '</root>',
    '',
  ].join('\n'))

  // 无 Content-Type 时按内容嗅探
  const sniffed = presentBody('<?xml version="1.0"?><r><c/></r>')
  assert.equal(sniffed.kind, 'xml')
  assert.equal(sniffed.defaultViewer, 'xml')

  const html = presentBody('<html><body>x</body></html>', 'text/html')
  assert.equal(html.kindLabel, 'HTML')
  assert.deepEqual(html.viewers, ['raw', 'xml'])
}

function testFormatPrettyXml(): void {
  const pretty = formatPrettyXml('<a><b>1</b><c><d/></c>tail</a>')
  assert.equal(
    pretty,
    [
      '<a>',
      '  <b>',
      '    1',
      '  </b>',
      '  <c>',
      '    <d/>',
      '  </c>',
      '  tail',
      '</a>',
      '',
    ].join('\n'),
  )
  // 声明、注释、CDATA 与未配对标签按尽力而为缩进，不抛错
  const mixed = formatPrettyXml('<?xml version="1.0"?><!-- note --><r/></r>')
  assert.ok(mixed?.includes('<?xml version="1.0"?>'))
  assert.ok(mixed?.includes('<!-- note -->'))
  assert.equal(formatPrettyXml('no tags here'), null)
}

function testTextDefaultsToMarkdownViewer(): void {
  const text = presentBody('hello world', 'text/plain')
  assert.equal(text.kind, 'text')
  assert.deepEqual(text.viewers, ['raw', 'markdown'])
  assert.equal(text.defaultViewer, 'markdown')
  assert.equal(text.monacoLang, 'markdown')

  const markdown = presentBody('# 标题\n\n- a\n- b', 'text/markdown')
  assert.equal(markdown.defaultViewer, 'markdown')
}

function testFormUrlEncoded(): void {
  const p = presentBody('foo=bar&baz=qux', 'application/x-www-form-urlencoded')
  assert.equal(p.kind, 'form-urlencoded')
  assert.deepEqual(p.formFields, [
    { key: 'foo', value: 'bar' },
    { key: 'baz', value: 'qux' },
  ])
  assert.deepEqual(p.viewers, ['raw', 'fields'])
  assert.equal(p.defaultViewer, 'fields')
  assert.equal(p.canPrettyJson, false)
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
  assert.deepEqual(p.viewers, ['raw'])
  assert.ok(p.note?.includes('boundary='))
}

function testTextAndBinary(): void {
  const text = presentBody('hello world', 'text/plain')
  assert.equal(text.kind, 'text')

  const binPayload = String.fromCharCode(0, 1, 2) + 'binary'
  const bin = presentBody(binPayload, 'application/octet-stream')
  assert.equal(bin.kind, 'binary')
  assert.deepEqual(bin.viewers, ['raw'])
  assert.ok(bin.note)
}

function testJsonContentTypeButInvalidBody(): void {
  const p = presentBody('not-json{', 'application/json')
  assert.equal(p.kind, 'json')
  assert.equal(p.prettyJson, null)
  assert.equal(p.canPrettyJson, false)
  assert.deepEqual(p.viewers, ['raw'])
  assert.ok(p.note?.includes('解析失败'))
}

function testLargeBodyDefaultsRawButKeepsViewers(): void {
  const large = `{"data":"${'x'.repeat(MAX_PRETTY_BODY_CHARS)}"}`
  assert.ok(large.length > MAX_PRETTY_BODY_CHARS)
  const p = presentBody(large, 'application/json')
  assert.equal(p.kind, 'json')
  assert.equal(p.prettyJson, null, '首屏不预计算格式化')
  assert.equal(p.canPrettyJson, true, '仍可手动切 JSON 查看器')
  assert.deepEqual(p.viewers, ['raw', 'json'])
  assert.equal(p.defaultViewer, 'raw')
  assert.ok(p.note?.includes('可手动切换到其他查看器'))
  // 手动格式化路径仍可用
  const manual = formatPrettyJson(large)
  assert.ok(manual != null && manual.includes('\n'))

  const largeText = 'x'.repeat(MAX_PRETTY_BODY_CHARS + 1)
  const t = presentBody(largeText, 'text/plain')
  assert.equal(t.defaultViewer, 'raw', '超大文本默认不渲染 Markdown')
}

function main(): void {
  testMediaTypeAndHeaders()
  testEmpty()
  testJsonDefaultsToJsonViewer()
  testXmlViewers()
  testFormatPrettyXml()
  testTextDefaultsToMarkdownViewer()
  testFormUrlEncoded()
  testMultipart()
  testTextAndBinary()
  testJsonContentTypeButInvalidBody()
  testLargeBodyDefaultsRawButKeepsViewers()
  console.log('body-presentation tests passed')
}

main()
