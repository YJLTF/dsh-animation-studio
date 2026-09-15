/**
 * 结构化 patch：JSON Patch（RFC 6902）的常用子集，外加反向 patch 生成。
 *
 * 为什么不让模型直接重写整份 spec：
 * 1. token 成本——改一个关键帧不该重发 800 行 JSON；
 * 2. 可 diff——每条 patch 落一条 durable 事件，工作台能精确刷新；
 * 3. 可撤销——`inverse` 让「撤回上一步」不需要重新推理一遍。
 */

import type { AnimationSpec, JsonValue, Scene } from './types.ts'

export type PatchOp =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue }
  | { op: 'move'; from: string; path: string }

export class PatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchError'
  }
}

function tokensOf(path: string, label: 'path' | 'from'): string[] {
  if (path === '') throw new PatchError(`${label} 不能为空（不允许对根节点整体操作）`)
  if (!path.startsWith('/')) throw new PatchError(`${label} 必须以 / 开头：${path}`)
  return path.slice(1).split('/').filter(t => t !== '')
}

type AnyRec = Record<string, unknown>

function isObject(v: unknown): v is AnyRec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 沿路径走到倒数第二层，返回父容器与最后的键。 */
function parentOf(root: unknown, path: string, label: 'path' | 'from'): { parent: unknown; key: string } {
  const tokens = tokensOf(path, label)
  const last = tokens[tokens.length - 1]
  let cur: unknown = root
  for (const t of tokens.slice(0, -1)) {
    if (Array.isArray(cur)) {
      const i = Number(t)
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) {
        throw new PatchError(`路径中段不存在：${path}（数组索引 ${t} 越界）`)
      }
      cur = cur[i]
    } else if (isObject(cur)) {
      if (!(t in cur)) throw new PatchError(`路径中段不存在：${path}（缺少键 ${t}）`)
      cur = cur[t]
    } else {
      throw new PatchError(`路径中段不是容器：${path}`)
    }
  }
  return { parent: cur, key: last }
}

function getAt(root: unknown, path: string): unknown {
  const { parent, key } = parentOf(root, path, 'path')
  if (Array.isArray(parent)) {
    if (key === '-') throw new PatchError(`读取路径不能使用 "-"：${path}`)
    const i = Number(key)
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) {
      throw new PatchError(`路径不存在：${path}`)
    }
    return parent[i]
  }
  if (isObject(parent)) {
    if (!(key in parent)) throw new PatchError(`路径不存在：${path}`)
    return parent[key]
  }
  throw new PatchError(`路径的父节点不是容器：${path}`)
}

/**
 * 写入一个值。返回实际插入的数组索引（对象写入返回 null）——
 * 反向操作需要它，因为 `-`（数组末尾）在 remove 时不是合法索引。
 */
function addAt(root: unknown, path: string, value: JsonValue): number | null {
  const { parent, key } = parentOf(root, path, 'path')
  if (Array.isArray(parent)) {
    if (key === '-') {
      parent.push(value)
      return parent.length - 1
    }
    const i = Number(key)
    if (!Number.isInteger(i) || i < 0 || i > parent.length) {
      throw new PatchError(`数组索引越界：${path}（长度 ${parent.length}）`)
    }
    parent.splice(i, 0, value)
    return i
  }
  if (isObject(parent)) {
    parent[key] = value
    return null
  }
  throw new PatchError(`无法 add 到非容器：${path}`)
}

function removeAt(root: unknown, path: string): JsonValue {
  const { parent, key } = parentOf(root, path, 'path')
  if (Array.isArray(parent)) {
    const i = Number(key)
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) throw new PatchError(`路径不存在：${path}`)
    return parent.splice(i, 1)[0] as JsonValue
  }
  if (isObject(parent)) {
    if (!(key in parent)) throw new PatchError(`路径不存在：${path}`)
    const old = parent[key] as JsonValue
    delete parent[key]
    return old
  }
  throw new PatchError(`无法从非容器移除：${path}`)
}

/**
 * 按路径读取一个值。`anim_get` 与客户端面板共用；路径不存在时抛 PatchError，
 * 而不是静默返回 undefined——「查了个不存在的东西」必须能被模型看见。
 */
export function readAt(root: unknown, path: string): unknown {
  return getAt(root, path)
}

export interface PatchResult {
  value: AnimationSpec
  /** 反向操作序列，按顺序应用即可撤销本次修改。 */
  inverse: PatchOp[]
}

/**
 * 应用一组 patch。任一条失败则抛 PatchError，调用方不应保留半成品。
 * 返回的 spec 是一份深拷贝，入参不被修改。
 */
export function applyPatch(spec: AnimationSpec, ops: readonly PatchOp[]): PatchResult {
  if (ops.length === 0) return { value: structuredClone(spec), inverse: [] }
  const root = structuredClone(spec) as unknown
  const inverse: PatchOp[] = []

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const index = addAt(root, op.path, op.value)
        // 数组末尾的 `-` 要换成真实索引，否则反向 remove 找不到目标
        const path = index === null
          ? op.path
          : `${op.path.slice(0, op.path.lastIndexOf('/'))}/${index}`
        inverse.push({ op: 'remove', path })
        break
      }
      case 'remove':
        inverse.push({ op: 'add', path: op.path, value: removeAt(root, op.path) })
        break
      case 'replace': {
        // replace 要求目标已存在，getAt 会在缺失时抛错
        const old = getAt(root, op.path)
        addAt(root, op.path, op.value)
        inverse.push({ op: 'replace', path: op.path, value: old as JsonValue })
        break
      }
      case 'move': {
        const value = getAt(root, op.from)
        removeAt(root, op.from)
        addAt(root, op.path, value as JsonValue)
        inverse.push({ op: 'move', from: op.path, path: op.from })
        break
      }
      default: {
        const never: never = op
        throw new PatchError(`不支持的操作：${JSON.stringify(never)}`)
      }
    }
  }

  inverse.reverse()
  return { value: root as AnimationSpec, inverse }
}

/* ------------------------------------------------------------- 便捷构造 */

/** 生成一条「设置某图层静态属性」的 patch。 */
export function setLayerProp(
  scenes: readonly Scene[],
  sceneId: string,
  layerId: string,
  prop: string,
  value: JsonValue,
): PatchOp {
  const si = scenes.findIndex(s => s.id === sceneId)
  if (si < 0) throw new PatchError(`场景不存在：${sceneId}`)
  const li = scenes[si].layers.findIndex(l => l.id === layerId)
  if (li < 0) throw new PatchError(`图层不存在：${layerId}（场景 ${sceneId}）`)
  return { op: 'replace', path: `/scenes/${si}/layers/${li}/props/${prop}`, value }
}

/** 生成一条「移动某个关键帧到新时刻」的 patch。 */
export function moveKeyframe(
  scenes: readonly Scene[],
  sceneId: string,
  layerId: string,
  trackId: string,
  keyIndex: number,
  atMs: number,
): PatchOp {
  const si = scenes.findIndex(s => s.id === sceneId)
  if (si < 0) throw new PatchError(`场景不存在：${sceneId}`)
  const li = scenes[si].layers.findIndex(l => l.id === layerId)
  if (li < 0) throw new PatchError(`图层不存在：${layerId}（场景 ${sceneId}）`)
  const ti = scenes[si].layers[li].tracks.findIndex(t => t.id === trackId)
  if (ti < 0) throw new PatchError(`轨道不存在：${trackId}（图层 ${layerId}）`)
  return { op: 'replace', path: `/scenes/${si}/layers/${li}/tracks/${ti}/keys/${keyIndex}/atMs`, value: atMs }
}
