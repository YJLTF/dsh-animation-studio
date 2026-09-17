/**
 * 面板指令按钮（0.4.0 §5.2）：点击即把结构化指令经 session/prompt 发回出
 * 这张卡片的会话（queue 模式，agent 下一回合执行；契约见 agent 预设）。
 *
 * 老回执没有 sessionId（旧日志回放 / 无 agent 形态）时整行不渲染，自然降级
 * 为只读卡片——这是刻意的：面板 v1 不猜「当前会话」，只认回执里盖章过的那个。
 */

import type { ReactNode } from 'react'
import { useState } from 'react'

import { promptAgent } from '../protocol.ts'
import { link, linkRow, muted } from './styles.ts'

export function PanelActions(props: { sessionId?: string; actions: Array<{ label: string; instruction: string }> }): ReactNode {
  const [state, setState] = useState<'idle' | 'sending' | 'accepted' | 'rejected' | 'unreachable'>('idle')
  if (props.sessionId === undefined || props.actions.length === 0) return null
  if (state === 'sending') return <div style={muted}>指令发送中…</div>
  if (state === 'accepted') return <div style={muted}>已发给智能体，下一回合执行。</div>
  if (state === 'rejected') return <div style={muted}>指令被宿主拒绝。</div>
  if (state === 'unreachable') return <div style={muted}>发送失败：宿主不可达（可能由宿主重启）。</div>
  return (
    <div style={linkRow}>
      {props.actions.map(action => (
        <button
          key={action.label}
          style={link}
          type="button"
          onClick={() => {
            const sessionId = props.sessionId
            if (sessionId === undefined) return
            setState('sending')
            void promptAgent(sessionId, action.instruction).then(setState)
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
