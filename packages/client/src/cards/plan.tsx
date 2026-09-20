/** anim_plan 卡片：分镜大纲 + 节奏体检（0.4.0 §5.4 自 cards.tsx 纯移动）。
 * 0.6.0 规划 §6.3：幕时长比例条——大纲数据早就有的结构信息，第一次以
 * 「时间轴」形态亮出来（不做画布拖拽前提下的结构可视化）。 */

import type { ReactNode } from 'react'

import { formatMs, list, num, readReceipt, renderSpecInstruction, str, strings, type ToolViewProps } from '../protocol.ts'
import { PanelActions } from './actions.tsx'
import { Card, Fallback, Warnings } from './primitives.tsx'
import { muted, row } from './styles.ts'

export function PlanCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="规划分镜" />
  const outline = list(receipt, 'outline')
  const totalMs = num(receipt, 'totalMs')
  // 比例条分母：回执 totalMs 优先，缺失（旧回执）按大纲时长合计兜底
  const total = totalMs ?? outline.reduce((sum, item) => sum + (num(item, 'durationMs') ?? 0), 0)
  const specId = str(receipt, 'specId')
  return (
    <Card title={`分镜大纲：${specId ?? ''}`}>
      {outline.map((item, i) => (
        <div key={i} style={row}>
          <span style={muted}>{i + 1}.</span>
          <span>{str(item, 'name') ?? str(item, 'id') ?? '(未命名)'}</span>
          <span style={muted}>{formatMs(num(item, 'durationMs'))}</span>
          {str(item, 'intent') !== undefined && <span style={muted}>{str(item, 'intent')}</span>}
        </div>
      ))}
      {outline.length > 0 && total > 0 && (
        <div
          style={{
            display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden',
            background: 'var(--dsw-alias-interactive-bg-hover-solid, rgba(127,127,127,0.2))',
          }}
          title="各幕时长占比"
        >
          {outline.map((item, i) => (
            <div
              key={i}
              style={{
                width: `${Math.max(1, ((num(item, 'durationMs') ?? 0) / total) * 100)}%`,
                background: ['var(--dsw-alias-interactive-primary, #4c9aff)', '#FFB020', '#5DD39E', '#B58CFF'][i % 4],
              }}
              title={`${str(item, 'name') ?? str(item, 'id') ?? ''} · ${formatMs(num(item, 'durationMs'))}`}
            />
          ))}
        </div>
      )}
      <div style={row}>
        <span style={muted}>
          {outline.length} 幕{total > 0 ? ` · 全片 ${formatMs(total)}` : ''}
        </span>
      </div>
      <Warnings items={strings(receipt, 'pacing')} />
      <PanelActions
        sessionId={str(receipt, 'sessionId')}
        actions={specId !== undefined ? [{ label: '渲染成片', instruction: renderSpecInstruction(specId) }] : []}
      />
    </Card>
  )
}
