/**
 * 时间线求值：把 IR 的绝对毫秒关键帧变成可查询、可展开的补间序列。
 *
 * `tweensOf()` 是渲染代码生成器的核心输入——适配器拿到的是一段段
 * 「从 Xms 开始、持续 Dms、由 A 补间到 B」的指令，而不是一坨关键帧，
 * 因为后者强迫每个后端各自重写一遍时序推导。
 */

import type { EaseSpec, Keyframe, KeyframeValue, Layer, Scene, Track } from './types.ts'

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

/** 按时间升序返回关键帧副本（不修改入参）。 */
export function sortKeys(keys: readonly Keyframe[]): Keyframe[] {
  return [...keys].sort((a, b) => a.atMs - b.atMs)
}

/** 轨道最后一个关键帧的时间。 */
export function trackEndMs(track: Track): number {
  if (track.keys.length === 0) return 0
  return sortKeys(track.keys)[track.keys.length - 1].atMs
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
  const keys = sortKeys(track.keys)
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

/* ------------------------------------------------------------ 缓动数值解 */

function cubicBezierY(t: number, x1: number, y1: number, x2: number, y2: number): number {
  // 求 y 使 bezierX(s) = t，再取 bezierY(s)。用二分即可满足预览精度。
  const bez = (s: number, p1: number, p2: number): number =>
    3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s ** 2 * p2 + s ** 3
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (bez(mid, x1, x2) < t) lo = mid
    else hi = mid
  }
  return bez((lo + hi) / 2, y1, y2)
}

/** 把归一化进度 t∈[0,1] 按缓动重映射，供预览插值使用。 */
export function applyEase(t: number, ease?: EaseSpec): number {
  const clamped = Math.min(1, Math.max(0, t))
  if (!ease) return clamped
  switch (ease.kind) {
    case 'linear': return clamped
    case 'easeIn': return clamped ** 2
    case 'easeOut': return 1 - (1 - clamped) ** 2
    case 'easeInOut':
      return clamped < 0.5 ? 2 * clamped ** 2 : 1 - 2 * (1 - clamped) ** 2
    case 'cubicBezier':
      return cubicBezierY(clamped, ease.points[0], ease.points[1], ease.points[2], ease.points[3])
    case 'spring': {
      // 欠阻尼弹簧的解析解，用于预览近似（渲染端由后端自己的 spring 接管）。
      const k = ease.stiffness ?? 170
      const c = ease.damping ?? 26
      const m = ease.mass ?? 1
      const w0 = Math.sqrt(k / m)
      const zeta = c / (2 * Math.sqrt(k * m))
      const wd = w0 * Math.sqrt(Math.max(0, 1 - zeta ** 2))
      const p = Math.min(1, Math.max(0.0001, clamped))
      return 1 - Math.exp(-zeta * w0 * p) * (Math.cos(wd * p) + (zeta * w0 / wd) * Math.sin(wd * p))
    }
  }
}

/** 查询某时刻轨道的插值结果；时刻早于首帧或轨道为空时返回 undefined。 */
export function valueAt(track: Track, tMs: number): KeyframeValue | undefined {
  const keys = sortKeys(track.keys)
  if (keys.length === 0) return undefined
  const first = keys[0]
  if (tMs <= first.atMs) return first.value
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (tMs >= a.atMs && tMs <= b.atMs) {
      if (typeof a.value !== 'number' || typeof b.value !== 'number') return a.value
      const span = b.atMs - a.atMs
      if (span <= 0) return b.value
      const p = applyEase((tMs - a.atMs) / span, b.ease)
      return a.value + (b.value - a.value) * p
    }
  }
  return keys[keys.length - 1].value
}

/* ---------------------------------------------------------------- 查找 */

export function findLayer(scene: Scene, layerId: string): Layer | undefined {
  return scene.layers.find(l => l.id === layerId)
}

export function findTrack(layer: Layer, trackId: string): Track | undefined {
  return layer.tracks.find(t => t.id === trackId)
}

export function findScene(scenes: readonly Scene[], sceneId: string): Scene | undefined {
  return scenes.find(s => s.id === sceneId)
}
