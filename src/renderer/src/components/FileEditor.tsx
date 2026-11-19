import { useEffect, useRef } from 'react'
import '../monacoEnvironment'
import * as monaco from 'monaco-editor'

export function FileEditor({
  path,
  value,
  readOnly,
  saveRef,
  onDirty,
  onSave
}: {
  path: string
  value: string
  readOnly: boolean
  saveRef: { current: (() => Promise<void>) | null }
  onDirty: (dirty: boolean) => void
  onSave: (text: string) => Promise<void>
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const onDirtyRef = useRef(onDirty)
  const onSaveRef = useRef(onSave)
  onDirtyRef.current = onDirty
  onSaveRef.current = onSave

  useEffect(() => {
    const node = hostRef.current
    if (!node) return
    const uri = monaco.Uri.parse(`file:///${path.replace(/\\/g, '/')}`)
    monaco.editor.getModel(uri)?.dispose()
    const model = monaco.editor.createModel(value, undefined, uri)
    const editor = monaco.editor.create(node, {
      model,
      theme: 'vs-dark',
      readOnly,
      automaticLayout: true,
      fontSize: 14,
      fontFamily: "Consolas, 'Courier New', monospace",
      minimap: { enabled: true },
      wordWrap: 'off',
      tabSize: 4,
      insertSpaces: true,
      detectIndentation: true,
      renderWhitespace: 'selection',
      cursorBlinking: 'blink',
      scrollBeyondLastLine: true,
      folding: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      matchBrackets: 'always',
      renderLineHighlight: 'line',
      roundedSelection: true,
      smoothScrolling: false,
      mouseWheelZoom: false,
      padding: { top: 8 },
      stickyScroll: { enabled: true },
      scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 12 },
      unicodeHighlight: { ambiguousCharacters: false }
    })
    const saved = { text: value }
    const publishDirty = (): void => {
      onDirtyRef.current(!readOnly && editor.getValue() !== saved.text)
    }
    const save = async (): Promise<void> => {
      if (readOnly) return
      const text = editor.getValue()
      if (text === saved.text) return
      try {
        await onSaveRef.current(text)
      } catch {
        return
      }
      saved.text = text
      publishDirty()
    }
    saveRef.current = save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save()
    })
    const subscription = editor.onDidChangeModelContent(publishDirty)
    return () => {
      if (saveRef.current === save) saveRef.current = null
      subscription.dispose()
      editor.dispose()
      model.dispose()
    }
  }, [path, readOnly, saveRef, value])

  return <div className="file-editor" ref={hostRef} />
}
