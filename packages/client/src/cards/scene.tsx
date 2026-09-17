/** anim_draft_scene 卡片：一幕入库（0.4.0 §5.4 自 cards.tsx 纯移动）。 */

import type { ReactNode } from 'react'

import { formatMs, num, readReceipt, str, strings, type ToolViewProps } from '../protocol.ts'
import { Card, Fallback, Notes, Repairs, Warnings } from './primitives.tsx'
import { muted, row } from './styles.ts'

export function SceneCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="写入场景" />
  const index = num(receipt, 'index')
  const count = num(receipt, 'sceneCount')
  return (
    <Card title={`写入场景：${str(receipt, 'sceneName') ?? str(receipt, 'sceneId') ?? ''}`}>
      <div style={row}>
        {index !== undefined && count !== undefined && (
          <span style={muted}>
            第 {index + 1}/{count} 幕
          </span>
        )}
        <span style={muted}>{formatMs(num(receipt, 'durationMs'))}</span>
      </div>
      <Repairs items={strings(receipt, 'repairs')} />
      <Notes title="大纲对账：" items={strings(receipt, 'outlineNotes')} />
      <Warnings items={strings(receipt, 'warnings')} />
    </Card>
  )
}
