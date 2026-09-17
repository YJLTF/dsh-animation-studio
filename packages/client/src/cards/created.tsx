/** anim_create_spec 卡片：片子名片（0.4.0 §5.4 自 cards.tsx 纯移动）。 */

import type { ReactNode } from 'react'

import { num, readReceipt, str, type ToolViewProps } from '../protocol.ts'
import { Card, Fallback } from './primitives.tsx'
import { muted, row } from './styles.ts'

export function CreatedCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="新建动画" />
  const size = receipt.size as { width?: unknown; height?: unknown } | undefined
  return (
    <Card title={`新建动画：${str(receipt, 'title') ?? str(receipt, 'specId') ?? ''}`}>
      <div style={row}>
        <span>{str(receipt, 'specId')}</span>
        {size && typeof size.width === 'number' && typeof size.height === 'number' && (
          <span style={muted}>
            {size.width}×{size.height}
          </span>
        )}
        {num(receipt, 'fps') !== undefined && <span style={muted}>{num(receipt, 'fps')} fps</span>}
      </div>
    </Card>
  )
}
