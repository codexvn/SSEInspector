/** 详情页请求/响应体展示模型：按 content-type 与内容探测分流，AI/透传共用。 */

export type BodyKind = 'empty' | 'json' | 'xml' | 'form-urlencoded' | 'multipart' | 'text' | 'binary'

/**
 * 内容查看器：原始字节与按内容格式渲染的预览并存，用户手动切换。
 * json = 格式化 JSON；xml = 缩进 XML/HTML；markdown = Markdown 渲染；
 * fields = form 字段表。可用集合按内容类型给出，默认项按类型推断
 * （文本类默认 Markdown，结构化类型默认对应格式化视图）。
 */
export type BodyViewer = 'raw' | 'json' | 'xml' | 'markdown' | 'fields'

export interface FormField {
  key: string
  value: string
}

export interface BodyPresentation {
  kind: BodyKind
  empty: boolean
  /** 原始文本（对象已 JSON.stringify；字符串原样） */
  rawText: string
  /** 预计算的 JSON 格式化文本；过大或不可解析为 null（过大可懒生成） */
  prettyJson: string | null
  /** JSON 查看器是否可用（可解析，或声明 JSON 且形似可懒重试） */
  canPrettyJson: boolean
  /** 预计算的 XML 格式化文本；过大为 null（可懒生成） */
  prettyXml: string | null
  /** application/x-www-form-urlencoded 解析结果 */
  formFields: FormField[] | null
  /** 简短类型标签 */
  kindLabel: string
  /** 原始查看器的 Monaco 语法 */
  monacoLang: 'json' | 'xml' | 'markdown' | 'plaintext'
  /** 可用查看器，raw 恒在首位 */
  viewers: BodyViewer[]
  /** 默认选中的查看器 */
  defaultViewer: BodyViewer
  /** 补充说明 */
  note: string | null
}

const KIND_LABEL: Record<BodyKind, string> = {
  empty: '空',
  json: 'JSON',
  xml: 'XML',
  'form-urlencoded': 'form',
  multipart: 'multipart',
  text: '文本',
  binary: '二进制',
}

/** 超过此字符数不在首屏预计算格式化；默认查看器退为「原始」，其余查看器仍可手动打开 */
export const MAX_PRETTY_BODY_CHARS = 256 * 1024

function largeBodyNote(rawLen: number): string {
  return `内容较大（${rawLen} 字符），默认显示原始；可手动切换到其他查看器`
}

/** 从 headers 取指定名（大小写不敏感）的第一个值。 */
export function getHeaderValue(
  headers: Record<string, string> | undefined | null,
  name: string,
): string | undefined {
  if (!headers) return undefined
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value) return value
  }
  return undefined
}

/** 解析 Content-Type 主类型（去掉参数）。 */
export function mediaTypeOf(contentType: string | undefined | null): string {
  if (!contentType) return ''
  return contentType.split(';', 1)[0].trim().toLowerCase()
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  // 快速排除明显不是 JSON 的形态：只尝试对象/数组与 JSON 字面量
  const looksLikeJson = (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    || trimmed === 'null'
    || trimmed === 'true'
    || trimmed === 'false'
    || /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  )
  // 兜底：花括号/方括号开头但形态不完整的（如被截断的对象）也交给解析器确认
  const bracketPrefixed = trimmed.startsWith('{') || trimmed.startsWith('[')
  if (!looksLikeJson && !bracketPrefixed) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function stringifyRaw(body: unknown): string {
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

/** 强制尝试 JSON 格式化（含大 body）；失败返回 null。供 UI 懒生成时调用。 */
export function formatPrettyJson(value: unknown): string | null {
  try {
    if (typeof value === 'string') {
      return JSON.stringify(JSON.parse(value), null, 2)
    }
    if (value === undefined) return null
    return JSON.stringify(value, null, 2)
  } catch {
    return null
  }
}

/**
 * 尽力而为的 XML/HTML 缩进格式化：按标签/声明/注释/CDATA 切分并按嵌套深度
 * 缩进，文本节点压缩连续空白。不校验标签配对（配对异常时按最小缩进输出）；
 * 内容不含 '<' 时返回 null。
 */
export function formatPrettyXml(text: string): string | null {
  if (!text.includes('<')) return null
  const pattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/[^>]*>|<[^>]*\/>|<[^>]*>|[^<]+/g
  const lines: string[] = []
  let depth = 0
  for (const token of text.match(pattern) ?? []) {
    if (token.startsWith('<!--') || token.startsWith('<![CDATA[') || token.startsWith('<?')) {
      lines.push(indent(depth, token.trim()))
    } else if (/^<\//.test(token)) {
      depth = Math.max(0, depth - 1)
      lines.push(indent(depth, token.trim()))
    } else if (/^<[^>]*\/>$/.test(token)) {
      lines.push(indent(depth, token.trim()))
    } else if (token.startsWith('<')) {
      lines.push(indent(depth, token.trim()))
      depth++
    } else {
      const content = token.replace(/\s+/g, ' ').trim()
      if (content) lines.push(indent(depth, content))
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : null
}

function indent(depth: number, text: string): string {
  return `${'  '.repeat(depth)}${text}`
}

/** 首屏预计算：过大则返回 null，不格式化。 */
function eager(value: unknown, rawLen: number, format: (v: unknown) => string | null): string | null {
  if (rawLen > MAX_PRETTY_BODY_CHARS) return null
  return format(value)
}

function looksLikeJsonStart(rawText: string): boolean {
  const t = rawText.trimStart()
  return t.startsWith('{') || t.startsWith('[')
}

function isXmlMedia(media: string): boolean {
  return media === 'application/xml'
    || media === 'text/xml'
    || media === 'text/html'
    || media.endsWith('+xml')
}

/** 内容嗅探：以 '<' 开头且形似标签（<?xml 或字母标签名），用于无 media 时的 XML 判定 */
function looksLikeXmlStart(rawText: string): boolean {
  const t = rawText.trimStart()
  if (!t.startsWith('<')) return false
  return t.startsWith('<?xml') || /^<\/?[a-zA-Z][\w:.-]*/.test(t)
}

function jsonResult(
  rawText: string,
  options: {
    prettyJson: string | null
    /** Content-Type 声明 JSON 但 parse 失败 */
    parseFailed?: boolean
    /** 结构上可视为 JSON（对象/媒体类型/嗅探成功/超大但形似 JSON） */
    treatAsJson: boolean
  },
): BodyPresentation {
  const oversized = rawText.length > MAX_PRETTY_BODY_CHARS
  const parseFailed = options.parseFailed === true
  const canPrettyJson = !parseFailed && (options.prettyJson != null || options.treatAsJson)
  const viewers: BodyViewer[] = canPrettyJson ? ['raw', 'json'] : ['raw']
  return {
    kind: 'json',
    empty: false,
    rawText,
    prettyJson: options.prettyJson,
    canPrettyJson,
    prettyXml: null,
    formFields: null,
    kindLabel: KIND_LABEL.json,
    monacoLang: canPrettyJson ? 'json' : 'plaintext',
    viewers,
    defaultViewer: canPrettyJson && !oversized ? 'json' : 'raw',
    note: parseFailed
      ? 'Content-Type 为 JSON 但解析失败，显示原始文本'
      : oversized && canPrettyJson
        ? largeBodyNote(rawText.length)
        : null,
  }
}

function xmlResult(rawText: string, label: string): BodyPresentation {
  const oversized = rawText.length > MAX_PRETTY_BODY_CHARS
  const prettyXml = oversized ? null : formatPrettyXml(rawText)
  return {
    kind: 'xml',
    empty: false,
    rawText,
    prettyJson: null,
    canPrettyJson: false,
    prettyXml,
    formFields: null,
    kindLabel: label,
    monacoLang: 'xml',
    viewers: ['raw', 'xml'],
    defaultViewer: oversized ? 'raw' : 'xml',
    note: oversized ? largeBodyNote(rawText.length) : null,
  }
}

function markdownResult(
  rawText: string,
  extra: Partial<BodyPresentation> = {},
): BodyPresentation {
  const oversized = rawText.length > MAX_PRETTY_BODY_CHARS
  const merged: BodyPresentation = {
    kind: 'text',
    empty: false,
    rawText,
    prettyJson: null,
    canPrettyJson: false,
    prettyXml: null,
    formFields: null,
    kindLabel: KIND_LABEL.text,
    monacoLang: 'markdown',
    viewers: ['raw', 'markdown'],
    defaultViewer: 'markdown',
    note: null,
    ...extra,
  }
  // 超大文本的默认查看器与说明覆盖 extra，避免同时渲染超大 Markdown
  if (oversized) {
    merged.defaultViewer = 'raw'
    merged.note = largeBodyNote(rawText.length)
  }
  return merged
}

function base(
  kind: BodyKind,
  rawText: string,
  extra: Partial<BodyPresentation> = {},
): BodyPresentation {
  return {
    kind,
    empty: false,
    rawText,
    prettyJson: null,
    canPrettyJson: false,
    prettyXml: null,
    formFields: null,
    kindLabel: KIND_LABEL[kind],
    monacoLang: 'plaintext',
    viewers: ['raw'],
    defaultViewer: 'raw',
    note: null,
    ...extra,
  }
}

function parseFormUrlEncoded(text: string): FormField[] | null {
  if (!text.includes('=') && !text.includes('&')) return null
  try {
    const params = new URLSearchParams(text)
    const fields: FormField[] = []
    for (const [key, value] of params.entries()) {
      fields.push({ key, value })
    }
    if (fields.length === 0) return null
    return fields
  } catch {
    return null
  }
}

function looksMostlyBinary(text: string): boolean {
  if (!text) return false
  const sample = text.slice(0, 4096)
  let suspicious = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    if (code === 0) return true
    if (code < 9 || (code > 13 && code < 32)) suspicious++
  }
  return suspicious / sample.length > 0.1
}

function multipartNote(contentType: string, rawText: string): string {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  const names = [...rawText.matchAll(/Content-Disposition:[^\n]*\bname="([^"]+)"/gi)].map(m => m[1])
  const unique = [...new Set(names)]
  const parts: string[] = ['multipart/form-data']
  if (boundary) parts.push(`boundary=${boundary}`)
  if (unique.length) parts.push(`字段: ${unique.slice(0, 12).join(', ')}${unique.length > 12 ? '…' : ''}`)
  parts.push(`${rawText.length} 字符`)
  return parts.join(' · ')
}

/**
 * 根据 body 与可选 Content-Type 生成展示模型。
 * contentType 优先于内容嗅探；JSON 解析失败时降级为文本。
 * 大 body：不预计算格式化文本，默认查看器退为「原始」，其余可手动打开。
 */
export function presentBody(
  body: unknown,
  contentType?: string | null,
): BodyPresentation {
  const rawText = stringifyRaw(body)
  if (rawText === '' && (body === undefined || body === null || body === '')) {
    return {
      kind: 'empty',
      empty: true,
      rawText: '',
      prettyJson: null,
      canPrettyJson: false,
      prettyXml: null,
      formFields: null,
      kindLabel: KIND_LABEL.empty,
      monacoLang: 'plaintext',
      viewers: ['raw'],
      defaultViewer: 'raw',
      note: null,
    }
  }

  const media = mediaTypeOf(contentType)

  if (media.startsWith('multipart/')) {
    return base('multipart', rawText, { note: multipartNote(contentType ?? '', rawText) })
  }

  if (media === 'application/x-www-form-urlencoded') {
    const fields = parseFormUrlEncoded(rawText)
    return base('form-urlencoded', rawText, {
      formFields: fields,
      viewers: fields?.length ? ['raw', 'fields'] : ['raw'],
      defaultViewer: fields?.length ? 'fields' : 'raw',
      note: fields?.length ? `${fields.length} 个字段` : null,
    })
  }

  // 已是对象/数组
  if (typeof body === 'object' && body !== null) {
    return jsonResult(rawText, {
      prettyJson: eager(body, rawText.length, formatPrettyJson),
      treatAsJson: true,
    })
  }

  const isJsonMedia =
    media === 'application/json'
    || media.endsWith('+json')
    || media === 'text/json'

  if (isJsonMedia || media === '') {
    const oversized = rawText.length > MAX_PRETTY_BODY_CHARS
    const parsed = oversized
      ? undefined
      : typeof body === 'string' ? tryParseJson(rawText) : undefined
    if (parsed !== undefined) {
      return jsonResult(rawText, {
        prettyJson: eager(rawText, rawText.length, formatPrettyJson),
        treatAsJson: true,
      })
    }
    if (isJsonMedia) {
      // 声明 JSON：过大仍允许手动格式化；小体量 parse 失败则无 json 查看器
      if (oversized || looksLikeJsonStart(rawText)) {
        return jsonResult(rawText, {
          prettyJson: eager(rawText, rawText.length, formatPrettyJson),
          treatAsJson: true,
          parseFailed: !oversized && !looksLikeJsonStart(rawText) && tryParseJson(rawText) === undefined,
        })
      }
      const failPretty = eager(rawText, rawText.length, formatPrettyJson)
      if (failPretty) {
        return jsonResult(rawText, { prettyJson: failPretty, treatAsJson: true })
      }
      return jsonResult(rawText, { prettyJson: null, treatAsJson: false, parseFailed: true })
    }
  }

  // XML/HTML：media 声明优先，无 media 时按内容嗅探
  if (isXmlMedia(media) || ((media === '' || media === 'text/plain') && looksLikeXmlStart(rawText))) {
    return xmlResult(rawText, media === 'text/html' ? 'HTML' : KIND_LABEL.xml)
  }

  // form 嗅探
  if (!media || media === 'text/plain') {
    const fields = parseFormUrlEncoded(rawText)
    if (fields && fields.length >= 1 && rawText.includes('=') && !tryParseJson(rawText)) {
      return base('form-urlencoded', rawText, {
        formFields: fields,
        viewers: ['raw', 'fields'],
        defaultViewer: 'fields',
        note: `${fields.length} 个字段（按内容推断）`,
      })
    }
  }

  if (media.startsWith('text/') || media === 'application/javascript') {
    // 文本类内容提供 Markdown 渲染预览（大模型输出多为 Markdown）
    return markdownResult(rawText, { note: media || null, kindLabel: media || KIND_LABEL.text })
  }

  if (
    media.startsWith('image/')
    || media.startsWith('audio/')
    || media.startsWith('video/')
    || media === 'application/octet-stream'
    || media === 'application/pdf'
    || media === 'application/zip'
    || looksMostlyBinary(rawText)
  ) {
    return base('binary', rawText, {
      note: `${media || '未知类型'} · ${rawText.length} 字符（可能已损坏的二进制文本表示）`,
    })
  }

  const pretty = eager(rawText, rawText.length, formatPrettyJson)
  if (pretty) {
    return jsonResult(rawText, { prettyJson: pretty, treatAsJson: true })
  }
  if (rawText.length > MAX_PRETTY_BODY_CHARS && looksLikeJsonStart(rawText)) {
    return jsonResult(rawText, { prettyJson: null, treatAsJson: true })
  }

  return markdownResult(rawText, { kindLabel: media ? media : KIND_LABEL.text })
}

/** 兼容旧调用方的默认查看器选择：优先 preferred，其次按 json → xml → markdown → fields 顺序。 */
export function defaultBodyViewer(
  viewers: BodyViewer[],
  preferred?: BodyViewer,
): BodyViewer {
  if (preferred && viewers.includes(preferred)) return preferred
  for (const fallback of ['json', 'xml', 'markdown', 'fields'] as const) {
    if (viewers.includes(fallback)) return fallback
  }
  return 'raw'
}
