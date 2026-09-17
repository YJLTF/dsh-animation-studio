/** anim_plan 卡片：分镜大纲 + 节奏体检（0.4.0 §5.4 自 cards.tsx 纯移动）。 */

import type { ReactNode } from 'react'

import { formatMs, list, num, readReceipt, str, strings, type ToolViewProps } from '../protocol.ts'
import { Card, Fallback, Warnings } from './primitives.tsx'
import { muted, row } from './styles.ts'

export function PlanCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="规划分镜" />
  const outline = list(receipt, 'outline')
  const totalMs = num(receipt, 'totalMs')
  return (
    <Card title={`分镜大纲：${str(receipt, 'specId') ?? ''}`}>
      {outline.map((item, i) => (
        <div key={i} style={row}>
          <span style={muted}>{i + 1}.</span>
          <span>{str(item, 'name') ?? str(item, 'id') ?? '(未命名)'}</span>
          <span style={muted}>{formatMs(num(item, 'durationMs'))}</span>
          {str(item, 'intent') !== undefined && <span style={muted}>{str(item, 'intent')}</span>}
        </div>
      ))}
      <div style={row}>
        <span style={muted}>
          {outline.length} 幕{totalMs !== undefined ? ` · 全片 ${formatMs(totalMs)}` : ''}
        </span>
      </div>
      <Warnings items={strings(receipt, 'pacing')} />
    </Card>
  )
}
