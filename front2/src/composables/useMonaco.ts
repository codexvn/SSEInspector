import { onUnmounted } from 'vue'
import type * as Monaco from 'monaco-editor'

let monaco: typeof Monaco | null = null
let loading: Promise<typeof Monaco> | null = null

async function loadMonaco(): Promise<typeof Monaco> {
  if (monaco) return monaco
  if (loading) { await loading; return monaco! }
  loading = import('monaco-editor').then(m => { monaco = m; loading = null; return m })
  await loading
  return monaco!
}

/** 创建 Monaco 编辑器，组件销毁时自动 dispose */
export function useMonaco() {
  let editor: Monaco.editor.IStandaloneCodeEditor | null = null

  async function create(el: HTMLElement, value: string, lang = 'json') {
    const m = await loadMonaco()
    if (editor) {
      if (editor.getValue() !== value) editor.setValue(value)
      return editor
    }
    editor = m.editor.create(el, {
      value, language: lang, readOnly: true,
      minimap: { enabled: false }, lineNumbers: 'off',
      scrollBeyondLastLine: false, wordWrap: 'on',
      automaticLayout: true, theme: 'vs',
      renderLineHighlight: 'none',
      glyphMargin: false,
      lineDecorationsWidth: 4,
      lineNumbersMinChars: 0,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
    })
    editor.onDidContentSizeChange(() => {
      const h = Math.min(editor!.getContentHeight(), 500)
      el.style.height = h + 'px'
      editor!.layout()
    })
    return editor
  }

  onUnmounted(() => { editor?.dispose(); editor = null })

  return { create }
}
