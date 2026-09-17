/**
 * anim_patch / anim_undo 卡片：一次结构化修改与撤销（0.4.0 §5.4 自 cards.tsx
 * 纯移动）。两张卡共用 PatchRows 摘要行，所以同文件。
 */

import type { ReactNode } from 'react'

import { formatMs, num, readReceipt, str, strings, undoLatestInstruction, type Receipt, type ToolViewProps } from '../protocol.ts'
import { PanelActions } from './actions.tsx'
import { Card, Fallback, Warnings } from './primitives.tsx'
import { muted, row } from './styles.ts'

function PatchRows(props: { receipt: Receipt }): ReactNode {
  const { receipt } = props
  return (
    <div style={row}>
      {num(receipt, 'version') !== undefined && <span style={muted}>v{num(receipt, 'version')}</span>}
      {num(receipt, 'applied') !== undefined && <span style={muted}>{num(receipt, 'applied')} 条变更</span>}
      <span style={muted}>时长 {formatMs(num(receipt, 'durationMs'))}</span>
      {str(receipt, 'note') !== undefined && <span>{str(receipt, 'note')}</span>}
    </div>
  )
}

/** anim_patch：一次结构化修改。 */
export function PatchCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="修改 spec" />
  const specId = str(receipt, 'specId')
  return (
    <Card title={`修改 ${specId ?? ''}`}>
      <PatchRows receipt={receipt} />
      <Warnings items={strings(receipt, 'warnings')} />
      <PanelActions
        sessionId={str(receipt, 'sessionId')}
        actions={specId !== undefined ? [{ label: '撤销这步', instruction: undoLatestInstruction(specId) }] : []}
      />
    </Card>
  )
}

/** anim_undo：撤销上一步。 */
export function UndoCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="撤销" />
  return (
    <Card title={`撤销 ${str(receipt, 'specId') ?? ''}`}>
      <PatchRows receipt={receipt} />
    </Card>
  )
}
