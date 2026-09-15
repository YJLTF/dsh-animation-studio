/**
 * @dsh-anim/store —— spec 状态容器：内存态 + 事件流 fold。
 *
 * 从 host 包（@dsh-anim/tools）下沉到共享层的理由：client 面板要从**同一条**
 * 事件流还原出同一个状态，而官方硬规则是 client 绝不 import host 实现代码进
 * 浏览器 bundle。本包只依赖 @dsh-anim/spec（纯数据层），host 与 client 共用，
 * 两半的状态还原才不会漂移。
 *
 * 这里刻意不依赖 dsh 运行时——`foldEvents` 是纯函数，可以直接单测。
 */

import type { AnimationSpec, JsonValue, PatchOp, Scene } from '@dsh-anim/spec'
import { applyPatch, specDurationMs, validateSpec } from '@dsh-anim/spec'

export interface PatchRecord {
  ops: PatchOp[]
  inverse: PatchOp[]
  note?: string
}

export interface SpecRecord {
  specId: string
  spec: AnimationSpec
  /** patch 应用次数，UI 用来判断「我这份是不是最新的」。 */
  version: number
  history: PatchRecord[]
}

export class SpecStoreError extends Error {}

export class SpecStore {
  #records = new Map<string, SpecRecord>()

  /** 建立一份新 spec。已存在则报错——覆盖该走 `anim_patch` 而不是重建。 */
  create(specId: string, spec: AnimationSpec): SpecRecord {
    if (this.#records.has(specId)) throw new SpecStoreError(`spec ${specId} 已存在`)
    // 刚建好还没写第一幕的空 spec 是合法的
    const checked = validateSpec(spec, { allowEmptyScenes: true })
    if (!checked.ok) {
      throw new SpecStoreError(checked.errors.map(e => `${e.path || '(根)'} — ${e.message}`).join('; '))
    }
    const record: SpecRecord = { specId, spec: checked.spec, version: 0, history: [] }
    this.#records.set(specId, record)
    return record
  }

  has(specId: string): boolean {
    return this.#records.has(specId)
  }

  /**
   * 读取。返回的是 store 内部的活引用，调用方只读不改——
   * 要改一律走 `patch`，它带校验、版本号和历史记录。
   */
  get(specId: string): AnimationSpec {
    const r = this.#records.get(specId)
    if (!r) throw new SpecStoreError(`spec ${specId} 不存在`)
    return r.spec
  }

  record(specId: string): SpecRecord {
    const r = this.#records.get(specId)
    if (!r) throw new SpecStoreError(`spec ${specId} 不存在`)
    return r
  }

  list(): string[] {
    return [...this.#records.keys()]
  }

  /** 丢弃一份 spec。正常流程用不到，供回放时的幂等重建使用。 */
  drop(specId: string): void {
    this.#records.delete(specId)
  }

  /**
   * 并入另一份 store 的全部记录（覆盖同名 specId）。
   * 供会话恢复用：fold 出来的 store 连同撤销历史整体搬进活 store，
   * 走 create() 逐份重建会把 history 丢掉，撤销就断了。
   */
  adopt(other: SpecStore): void {
    for (const [specId, record] of other.#records) {
      this.#records.set(specId, record)
    }
  }

  /**
   * 应用一组补丁。改完**整份校验**，不通过就整批回滚——
   * 半改成功的 spec 比没改更糟：后续每一步都在一个非法文档上累积。
   */
  patch(specId: string, ops: readonly PatchOp[], note?: string): { spec: AnimationSpec; inverse: PatchOp[] } {
    const record = this.record(specId)
    let result: { value: AnimationSpec; inverse: PatchOp[] }
    try {
      result = applyPatch(record.spec, ops)
    } catch (err) {
      throw new SpecStoreError(err instanceof Error ? err.message : String(err))
    }
    const checked = validateSpec(result.value, { allowEmptyScenes: true })
    if (!checked.ok) {
      throw new SpecStoreError(
        `补丁应用后 spec 非法，已回滚：${checked.errors.map(e => `${e.path || '(根)'} — ${e.message}`).join('; ')}`,
      )
    }
    record.spec = checked.spec
    record.version += 1
    record.history.push({ ops: [...ops], inverse: result.inverse, note })
    return { spec: record.spec, inverse: result.inverse }
  }

  /** 撤销最后一次修改。 */
  undo(specId: string): PatchOp[] | undefined {
    const record = this.record(specId)
    const last = record.history.pop()
    if (!last) return undefined
    const { value } = applyPatch(record.spec, last.inverse)
    record.spec = value
    record.version += 1
    return last.inverse
  }

  /**
   * 追加或替换一个场景。返回产生的 ops，调用方负责发事件——
   * 写入与发事件分离，是为了让「一个工具 = 一个事件」这件事在代码里看得见。
   *
   * 实现上就是一条 add patch，校验、版本号、历史记录全部复用 `patch`。
   */
  putScene(specId: string, scene: Scene, index?: number): { ops: PatchOp[]; inverse: PatchOp[] } {
    const at = index ?? this.record(specId).spec.scenes.length
    // 场景是结构化数据，但 TS 的 interface 没有隐式索引签名，赋给 JsonValue 需要显式转
    const ops: PatchOp[] = [{ op: 'add', path: `/scenes/${at}`, value: scene as unknown as JsonValue }]
    const { inverse } = this.patch(specId, ops, `写入场景「${scene.name}」`)
    return { ops, inverse }
  }

  durationMs(specId: string): number {
    return specDurationMs(this.get(specId).scenes)
  }
}

/**
 * 事件名 → 载荷的最小结构视图。
 *
 * 事件类型本体（含 `SessionEventMap` 合并声明）住在 host 包的 events.ts——
 * 那是「会话事件」这条 dsh 平台关注点；本包只消费 type/data 两元组，
 * 于是 client 与 host 能在不含 dsh 类型的情况下共享 fold。
 */
export interface AnimEventView {
  type: string
  data: unknown
}

/** 从事件流还原 store。回放、fork、刷新恢复走的是同一条路径。 */
export function foldEvents(events: readonly AnimEventView[]): SpecStore {
  const store = new SpecStore()
  for (const ev of events) {
    switch (ev.type) {
      case 'anim/spec-created': {
        const data = ev.data as { specId?: unknown; spec?: AnimationSpec }
        if (typeof data.specId !== 'string' || !data.spec) break
        // 重复创建（fork 后重放）按幂等处理：后来者覆盖
        if (store.has(data.specId)) store.drop(data.specId)
        try {
          store.create(data.specId, data.spec)
        } catch {
          // 回放遇到坏事件不能整条流崩掉；状态以能还原的部分为准
        }
        break
      }
      case 'anim/spec-patched': {
        const data = ev.data as { specId?: unknown; ops?: PatchOp[]; note?: string }
        if (typeof data.specId !== 'string' || !Array.isArray(data.ops)) break
        try {
          store.patch(data.specId, data.ops, data.note)
        } catch {
          // 同上：坏事件跳过，不崩整条流
        }
        break
      }
      default:
        // outline / render-* 不影响 spec 状态
        break
    }
  }
  return store
}
