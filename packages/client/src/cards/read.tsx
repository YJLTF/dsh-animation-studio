/**
 * anim_get 卡片：读 spec。内容按需拉 /dsh-anim/api/spec，展开时显示读取到的
 * 片段（0.4.0 §5.4 自 cards.tsx 纯移动）。
 */

import type { ReactNode } from 'react'
import { useState } from 'react'

import { formatMs, num, readReceipt, str, type ToolViewProps } from '../protocol.ts'
import { Card, Fallback } from './primitives.tsx'
import { muted, preBox, row } from './styles.ts'

export function ReadCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="读取 spec" />
  const specId = str(receipt, 'specId')
  const rawPath = str(receipt, 'path')
  // meta 里整份读取记为 '(整份)'；只有真实 JSON Pointer 才按路径取片段
  const pointer = rawPath !== undefined && rawPath !== '(整份)' ? rawPath : ''
  return (
    <Card title={`读取 ${specId ?? ''}`}>
      <div style={row}>
        <span style={muted}>{rawPath ?? '(整份)'}</span>
        <span style={muted}>时长 {formatMs(num(receipt, 'durationMs'))}</span>
      </div>
      {specId !== undefined && <SpecContent specId={specId} pointer={pointer} />}
    </Card>
  )
}

/** JSON Pointer（RFC 6901）的最小客户端实现；路径走不通返回 undefined。 */
function pointerGet(root: unknown, pointer: string): unknown {
  let cur: unknown = root
  for (const raw of pointer.split('/')) {
    if (raw === '') continue
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(cur)) {
      const i = Number(token)
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined
      cur = cur[i]
    } else if (cur !== null && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[token]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * ReadCard 的「查看读取内容」：展开时才拉 /dsh-anim/api/spec（meta 刻意不带
 * spec 内容），按调用里的 JSON Pointer 取片段展示——此前这条数据通道只有
 * API 没有 UI，用户在面板上反而看不到模型读到了什么（优化清单 O17）。
 */
function SpecContent(props: { specId: string; pointer: string }): ReactNode {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; text?: string }>({ status: 'idle' })
  const load = (): void => {
    setState({ status: 'loading' })
    void fetch(`/dsh-anim/api/spec?id=${encodeURIComponent(props.specId)}`)
      .then(async res => {
        if (!res.ok) throw new Error(String(res.status))
        const data = (await res.json()) as { spec?: unknown }
        const text = JSON.stringify(pointerGet(data.spec, props.pointer) ?? null, null, 2)
        setState({
          status: 'ok',
          text: text.length <= 4000 ? text : `${text.slice(0, 4000)}\n…（已截断，共 ${text.length} 字符）`,
        })
      })
      .catch(() => setState({ status: 'error' }))
  }
  return (
    <details
      onToggle={event => {
        if ((event.currentTarget as HTMLDetailsElement).open && state.status === 'idle') load()
      }}
    >
      <summary style={{ ...muted, cursor: 'pointer' }}>查看读取内容</summary>
      {state.status === 'loading' && <div style={muted}>加载中…</div>}
      {state.status === 'error' && <div style={muted}>工作台服务不可达，读不到内容（可能由宿主重启）。</div>}
      {state.status === 'ok' && <pre style={preBox}>{state.text}</pre>}
    </details>
  )
}
