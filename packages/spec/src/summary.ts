/**
 * 时间线摘要（0.5.0 §3.1）：`anim_get` 的 `view: 'summary'` 数据面。
 *
 * 让模型一次看清全局结构——各幕起止、图层规模、音频图层、资产引用计数——
 * 不必为「节奏复查」「删资产前的引用检查」反复拉大块 JSON。
 * 口径与时间线求值同源（sceneDurationMs / specDurationMs），摘要说 A
 * 渲染就是 A；store 与 client 面板可复用同一份纯函数。
 */

import type { AnimationSpec } from './types.ts'
import { sceneDurationMs, specDurationMs } from './timeline.ts'

/** 单幕摘要。`startMs` 是全片绝对毫秒（前面各幕实际时长之和）。 */
export interface SceneSummary {
  index: number
  id: string
  name: string
  startMs: number
  /** 实际时长：声明值与轨道结束值的较大者（与渲染同口径）。 */
  durationMs: number
  /** 可见图层数（不含 audio 图层——音频不占画面）。 */
  layerCount: number
  /** audio 图层的 id 清单（BGM/音效盘点）。 */
  audioLayers: string[]
  /** 展开后的字幕条数（作者侧写 narration.cues 时此处为 0）。 */
  subtitleCount: number
}

/** 资产引用计数：统计 `asset:<id>` 形态的引用（image/svg 的 src、audio 的 src）。 */
export interface AssetUsage {
  id: string
  kind: string
  /** 被图层 props 引用的次数；0 = 已导入未使用（删除前的好帮手）。 */
  refs: number
}

export interface SpecSummary {
  title: string
  fps: number
  size: { width: number; height: number }
  totalMs: number
  sceneCount: number
  scenes: SceneSummary[]
  /** 作者侧 narration.cues 条数（展开进场景后的 subtitle 不重复计）。 */
  narrationCues: number
  assets: AssetUsage[]
}

const ASSET_REF = /^asset:(.+)$/

/** 收集图层 props 里出现的 `asset:<id>` 引用。 */
function assetRefsOf(layer: { props: Record<string, unknown> }): string[] {
  const refs: string[] = []
  for (const value of Object.values(layer.props)) {
    if (typeof value === 'string') {
      const m = ASSET_REF.exec(value)
      if (m) refs.push(m[1]!)
    }
  }
  return refs
}

export function summarizeSpec(spec: AnimationSpec): SpecSummary {
  const scenes: SceneSummary[] = []
  let cursor = 0
  spec.scenes.forEach((scene, index) => {
    const durationMs = sceneDurationMs(scene)
    scenes.push({
      index,
      id: scene.id,
      name: scene.name,
      startMs: cursor,
      durationMs,
      layerCount: scene.layers.filter(l => l.type !== 'audio').length,
      audioLayers: scene.layers.filter(l => l.type === 'audio').map(l => l.id),
      subtitleCount: scene.subtitles?.length ?? 0,
    })
    cursor += durationMs
  })

  const usage = new Map<string, number>()
  for (const scene of spec.scenes) {
    for (const layer of scene.layers) {
      for (const id of assetRefsOf(layer)) usage.set(id, (usage.get(id) ?? 0) + 1)
    }
  }
  const assets: AssetUsage[] = Object.entries(spec.assets).map(([id, asset]) => ({
    id,
    kind: asset.kind,
    refs: usage.get(id) ?? 0,
  }))

  return {
    title: spec.meta.title,
    fps: spec.meta.fps,
    size: { ...spec.meta.size },
    totalMs: specDurationMs(spec.scenes),
    sceneCount: spec.scenes.length,
    scenes,
    narrationCues: spec.narration?.cues.length ?? 0,
    assets,
  }
}
