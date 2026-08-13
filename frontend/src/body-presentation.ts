/** 详情页请求/响应体展示模型：按 content-type 与内容探测分流，AI/透传共用。 */

export type BodyKind = 'empty' | 'json' | 'form-urlencoded' | 'multipart' | 'text' | 'binary'

export type BodyContentTab = 'raw' | 'pretty' | 'fields'

export interface FormField {
  key: string
  value: string
}

export interface BodyPresentation {
  kind: BodyKind
  empty: boolean
  /** 原始文本（对象已 JSON.stringify；字符串原样） */
  rawText: string
  /**
   * 已预计算的美化文本。过大 body 为 null，但仍可 canPretty（点「美化」时再生成）。
   */
  prettyText: string | null
  /** 是否显示「美化」tab（JSON 可解析或 Content-Type 声明为 JSON） */
  canPretty: boolean
  /** application/x-www-form-urlencoded 解析结果 */
  formFields: FormField[] | null
  /** 简短类型标签 */
  kindLabel: string
  monacoLang: 'json' | 'plaintext'
  /** 内容 tab（不含协议「合并」） */
  contentTabs: BodyContentTab[]
  /** 默认选中的内容 tab：小 JSON→pretty，大 JSON→raw，form→fields */
  defaultTab: BodyContentTab
  /** 补充说明 */
  note: string | null
}

const KIND_LABEL: Record<BodyKind, string> = {
  empty: '空',
  json: 'JSON',
  'form-urlencoded': 'form',
  multipart: 'multipart',
  text: '文本',
  binary: '二进制',
}

/** 超过此字符数不在首屏预计算美化；默认 tab 为「原始」，美化 tab 仍可手动打开 */
export const MAX_PRETTY_BODY_CHARS = 256 * 1024

function largeBodyNote(rawLen: number): string {
  return `内容较大（${rawLen} 字符），默认显示原始；可手动切换到美化`
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
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))
      || trimmed === 'null'
      || trimmed === 'true'
      || trimmed === 'false'
      || /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)
      || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    )
  ) {
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined
  }
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

/** 强制尝试美化（含大 body）；失败返回 null。供 UI 点「美化」时按需调用。 */
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

/** 首屏预计算：过大则返回 null，不 parse。 */
function eagerPretty(value: unknown, rawText: string): string | null {
  if (rawText.length > MAX_PRETTY_BODY_CHARS) return null
  return formatPrettyJson(value)
}

function looksLikeJsonStart(rawText: string): boolean {
  const t = rawText.trimStart()
  return t.startsWith('{') || t.startsWith('[')
}

function jsonResult(
  rawText: string,
  options: {
    prettyText: string | null
    /** Content-Type 声明 JSON 但 parse 失败 */
    parseFailed?: boolean
    /** 结构上可视为 JSON（对象/媒体类型/嗅探成功/超大但形似 JSON） */
    treatAsJson: boolean
  },
): BodyPresentation {
  const oversized = rawText.length > MAX_PRETTY_BODY_CHARS
  const parseFailed = options.parseFailed === true
  const canPretty = !parseFailed && (options.prettyText != null || options.treatAsJson)
  const note = parseFailed
    ? 'Content-Type 为 JSON 但解析失败，显示原始文本'
    : oversized && canPretty
      ? largeBodyNote(rawText.length)
      : null
  return {
    kind: 'json',
    empty: false,
    rawText,
    prettyText: options.prettyText,
    canPretty,
    formFields: null,
    kindLabel: KIND_LABEL.json,
    monacoLang: canPretty ? 'json' : 'plaintext',
    contentTabs: canPretty ? ['raw', 'pretty'] : ['raw'],
    // 有预计算美化且未超大 → 默认美化；否则默认原始（超大时用户可选手动美化）
    defaultTab: options.prettyText != null && !oversized ? 'pretty' : 'raw',
    note,
  }
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
    prettyText: null,
    canPretty: false,
    formFields: null,
    kindLabel: KIND_LABEL[kind],
    monacoLang: 'plaintext',
    contentTabs: ['raw'],
    defaultTab: 'raw',
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
 * contentType 优先于内容嗅探；JSON 解析失败时降级为 text/binary。
 * 大 body：仍可 canPretty，但不预计算 prettyText，defaultTab=raw。
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
      prettyText: null,
      canPretty: false,
      formFields: null,
      kindLabel: KIND_LABEL.empty,
      monacoLang: 'plaintext',
      contentTabs: ['raw'],
      defaultTab: 'raw',
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
      contentTabs: fields?.length ? ['fields', 'raw'] : ['raw'],
      defaultTab: fields?.length ? 'fields' : 'raw',
      note: fields?.length ? `${fields.length} 个字段` : null,
    })
  }

  // 已是对象/数组
  if (typeof body === 'object' && body !== null) {
    return jsonResult(rawText, {
      prettyText: eagerPretty(body, rawText),
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
        prettyText: eagerPretty(rawText, rawText),
        treatAsJson: true,
      })
    }
    if (isJsonMedia) {
      // 声明 JSON：过大仍允许手动美化；小体量 parse 失败则无美化 tab
      if (oversized || looksLikeJsonStart(rawText)) {
        return jsonResult(rawText, {
          prettyText: eagerPretty(rawText, rawText),
          treatAsJson: true,
          parseFailed: !oversized && !looksLikeJsonStart(rawText) && tryParseJson(rawText) === undefined,
        })
      }
      const failPretty = eagerPretty(rawText, rawText)
      if (failPretty) {
        return jsonResult(rawText, { prettyText: failPretty, treatAsJson: true })
      }
      return jsonResult(rawText, { prettyText: null, treatAsJson: false, parseFailed: true })
    }
  }

  // form 嗅探
  if (!media || media === 'text/plain') {
    const fields = parseFormUrlEncoded(rawText)
    if (fields && fields.length >= 1 && rawText.includes('=') && !tryParseJson(rawText)) {
      return base('form-urlencoded', rawText, {
        formFields: fields,
        contentTabs: ['fields', 'raw'],
        defaultTab: 'fields',
        note: `${fields.length} 个字段（按内容推断）`,
      })
    }
  }

  if (media.startsWith('text/') || media === 'application/xml' || media === 'application/javascript') {
    return base('text', rawText, { note: media || null })
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

  const pretty = eagerPretty(rawText, rawText)
  if (pretty) {
    return jsonResult(rawText, { prettyText: pretty, treatAsJson: true })
  }
  if (rawText.length > MAX_PRETTY_BODY_CHARS && looksLikeJsonStart(rawText)) {
    return jsonResult(rawText, { prettyText: null, treatAsJson: true })
  }

  return base('text', rawText, {
    kindLabel: media ? media : KIND_LABEL.text,
  })
}

/** 从 contentTabs + defaultTab 取默认（兼容旧调用方）。 */
export function defaultBodyTab(
  tabs: BodyContentTab[],
  preferred?: BodyContentTab,
): BodyContentTab {
  if (preferred && tabs.includes(preferred)) return preferred
  if (tabs.includes('pretty')) return 'pretty'
  if (tabs.includes('fields')) return 'fields'
  return tabs[0] ?? 'raw'
}
