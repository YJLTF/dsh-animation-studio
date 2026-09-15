/**
 * 时间线求值：把 IR 的绝对毫秒关键帧展开为补间序列，并推导各层时长。
 *
 * `tweensOf()` 是渲染代码生成器的核心输入——适配器拿到的是一段段
 * 「从 Xms 开始、持续 Dms、由 A 补间到 B」的指令，而不是一坨关键帧，
 * 因为后者强迫每个后端各自重写一遍时序推导。
 */

import type { EaseSpec, KeyframeValue, Scene, Track } from './types.ts'

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
export function trackEndMs(track: Track): number {
  let end = 0
  for (const k of track.keys) end = Math.max(end, k.atMs)
  return end
}

/** 场景内所有动画的自然结束时间（忽略声明时长）。 */
export function sceneContentEndMs(scene: Scene): number {
  let end = 0
  for (const layer of scene.layers) {
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
