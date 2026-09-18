/** anim_asset_import 卡片：素材登记（0.4.0 §5.4 自 cards.tsx 纯移动）。 */

import type { ReactNode } from 'react'

import { readReceipt, str, type ToolViewProps } from '../protocol.ts'
import { mediaUrl } from '../protocol.ts'
import { Card, Fallback } from './primitives.tsx'
import { muted, row } from './styles.ts'

export function AssetCard(props: ToolViewProps): ReactNode {
  const receipt = readReceipt(props.block)
  if (!receipt) return <Fallback {...props} running="导入素材" />
  const kind = str(receipt, 'kind')
  const src = str(receipt, 'src')
  return (
    <Card title={`导入素材：${str(receipt, 'assetId') ?? ''}`}>
      <div style={row}>
        <span>{kind ?? '—'}</span>
        <span style={{ ...muted, wordBreak: 'break-all' }}>{src}</span>
      </div>
      {/* 音频资产就地试听（0.5.0 §2.2）：资产文件在 outputDir/assets/ 内，
          媒体路由按白名单放行（.mp3/.wav/.ogg/.m4a/.flac） */}
      {kind === 'audio' && src !== undefined && <audio controls preload="metadata" src={mediaUrl(src)} style={{ width: '100%' }} />}
    </Card>
  )
}
