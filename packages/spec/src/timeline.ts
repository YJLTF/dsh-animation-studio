/**
 * 时间线求值：把 IR 的绝对毫秒关键帧展开为补间序列，并推导各层时长。
 *
 * `tweensOf()` 是渲染代码生成器的核心输入——适配器拿到的是一段段
 * 「从 Xms 开始、持续 Dms、由 A 补间到 B」的指令，而不是一坨关键帧，
 * 因为后者强迫每个后端各自重写一遍时序推导。
 */

import type { AnimationSpec, EaseSpec, KeyframeValue, Scene, Track } from './types.ts'

/** 一个补间段：渲染后端的通用语言。 */
export interface Tween {
  /** 目标属性路径，如 `props.opacity`。 */
  target: string
  /** 场景内绝对起始时间（毫秒）。 */
  startMs: number
  /** 持续时长（毫秒）；为 0 表示离散跳变。 */
  durationMs: number
  from: KeyframeValue
  to: KeyframeValue
  ease?: EaseSpec
}

/** 轨道最后一个关键帧的时间。 */
function trackEndMs(track: Track): number {
  let end = 0
  for (const k of track.keys) end = Math.max(end, k.atMs)
  return end
}

/** 场景内所有动画的自然结束时间（忽略声明时长）。audio 图层不进画面，
 * 其轨道（写错的 volume 轨道之类）不得把时间线撑长。 */
function sceneContentEndMs(scene: Scene): number {
  let end = 0
  for (const layer of scene.layers) {
    if (layer.type === 'audio') continue
    for (const track of layer.tracks) end = Math.max(end, trackEndMs(track))
  }
  return end
}

/** 场景实际时长：声明时长与自然结束时间取较大者，避免动画被截断。 */
export function sceneDurationMs(scene: Scene): number {
  return Math.max(scene.durationMs, sceneContentEndMs(scene))
}

/** 一部片子的总时长（毫秒）。 */
export function specDurationMs(scenes: readonly Scene[]): number {
  return scenes.reduce((sum, s) => sum + sceneDurationMs(s), 0)
}

/**
 * 把整份 spec 截短到前 `cutMs` 毫秒（不含），原 spec 不被修改。
 *
 * 预览加速用：`anim_preview` 只抽查若干时间点时，没必要渲染其后的内容。
 * 截断点所在场景保留到截断处——超出截断点的关键帧被过滤掉（轨道因此为空
 * 则整条丢弃，图层以静态 props 出现在截断点前，与原片该时段的画面一致），
 * 声明时长同步收紧；完全落在截断点之后的场景整幕丢弃。截断点之前的
 * 时间线逐毫秒等价，抽帧按下标取帧不受影响。
 */
export function truncateSpecAtMs(spec: AnimationSpec, cutMs: number): AnimationSpec {
  if (!Number.isFinite(cutMs) || cutMs <= 0) {
    throw new Error(`cutMs 必须是正的有限毫秒数，收到 ${cutMs}`)
  }
  // 截断点在片尾之外：无活儿可干，原样返回（保持引用相等，调用方可据此免拷贝）
  if (cutMs >= specDurationMs(spec.scenes)) return spec
  const scenes: Scene[] = []
  let cursor = 0
  for (const scene of spec.scenes) {
    const duration = sceneDurationMs(scene)
    if (cursor >= cutMs) break
    if (cursor + duration <= cutMs) {
      scenes.push(scene)
      cursor += duration
      continue
    }
    scenes.push(truncateSceneAtMs(scene, cutMs - cursor))
    break
  }
  return { ...spec, scenes }
}

function truncateSceneAtMs(scene: Scene, keepMs: number): Scene {
  const layers = scene.layers.map(layer => ({
    ...layer,
    tracks: layer.tracks
      .map(track => {
        // 关键帧只保证时间不重复、不保证升序，所以用过滤而不是截到第一个越界帧
        const keys = track.keys.filter(k => k.atMs < keepMs)
        return keys.length > 0 ? { ...track, keys } : undefined
      })
      .filter((t): t is Track => t !== undefined),
  }))
  return { ...scene, durationMs: Math.min(scene.durationMs, keepMs), layers }
}

/** 展开一条轨道为补间段序列。关键帧不足两个时返回空数组（无动画）。 */
export function tweensOf(track: Track): Tween[] {
  const keys = [...track.keys].sort((a, b) => a.atMs - b.atMs)
  const out: Tween[] = []
  for (let i = 0; i < keys.length - 1; i++) {
    const from = keys[i]
    const to = keys[i + 1]
    out.push({
      target: track.target,
      startMs: from.atMs,
      durationMs: Math.max(0, to.atMs - from.atMs),
      from: from.value,
      to: to.value,
      ...(to.ease ? { ease: to.ease } : {}),
    })
  }
  return out
}
