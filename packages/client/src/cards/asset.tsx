/** anim_asset_import 卡片：素材登记（0.4.0 §5.4 自 cards.tsx 纯移动）。 */

import type { ReactNode } from 'react'

import { readReceipt, str, type ToolViewProps } from '../protocol.ts'
import { Card, Fallback } from './primitives.tsx'
import { muted, row } from './styles.ts'

export function AssetCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="导入素材" />
  return (
    <Card title={`导入素材：${str(receipt, 'assetId') ?? ''}`}>
      <div style={row}>
        <span>{str(receipt, 'kind') ?? '—'}</span>
        <span style={{ ...muted, wordBreak: 'break-all' }}>{str(receipt, 'src')}</span>
      </div>
    </Card>
  )
}
