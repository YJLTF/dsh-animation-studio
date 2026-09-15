/**
 * 动画工作台的会话事件载荷。
 *
 * 设计上这是**唯一的事实来源**：spec 的每一次变更都以一个事件落进 dsh 的
 * append-only 会话日志，面板状态 = 事件流的 fold。这样刷新不丢状态、可回放、
 * 可分叉——dsh 最值钱的那三个能力不用自己实现一份。
 *
 * 因此事件载荷必须**自包含且前向兼容**：不能写「改了第 3 个关键帧」这种需要
 * 读前序状态才能解释的增量，回放时 fold 当然可以算出来，但单独看一条日志的
 * 人（和未来的 fork 逻辑）算不出来。所以 `anim/spec-patched` 同时记 ops 和
 * inverse：正向用于重放，逆向用于撤销，两者都不依赖外部状态。
 */

import type { AnimationSpec, PatchOp } from '@dsh-anim/spec'

/** 建 spec。 */
export interface AnimSpecCreatedData {
  specId: string
  spec: AnimationSpec
}

/** 建分镜大纲。内容由模型写，工具只负责落库——事件里存的也就是这份大纲。 */
export interface AnimOutlineData {
  specId: string
  /** 每个场景一句教学意图，不写具体图层。 */
  outline: Array<{
    id: string
    name: string
    /** 这一幕要让学生明白什么。 */
    intent: string
    /** 旁白草稿，可为空。 */
    narration?: string
    durationMs: number
  }>
}

/** 一次结构化修改。ops 与 inverse 成对落盘。 */
export interface AnimSpecPatchedData {
  specId: string
  ops: PatchOp[]
  inverse: PatchOp[]
  /** 人类可读的修改说明，面板的时间线历史里显示。 */
  note?: string
  /** 修改后的总时长，UI 不必为了显示总长再 fold 一遍。 */
  durationMs: number
}

/** 渲染任务结束。路径、帧数、时长都记下来，回放旧会话时卡片才重建得出来。 */
export interface AnimRenderFinishedData {
  specId: string
  jobId: string
  outputPath: string
  frameCount: number
  durationMs: number
  width: number
  height: number
}

/** 事件名 → 载荷。新增事件时同步更新 `plugins.d.ts` 里对 `SessionEventMap` 的合并声明。 */
export interface AnimEventDataMap {
  'anim/spec-created': AnimSpecCreatedData
  'anim/outline-updated': AnimOutlineData
  'anim/spec-patched': AnimSpecPatchedData
  'anim/render-finished': AnimRenderFinishedData
}

export type AnimEventType = keyof AnimEventDataMap

export type AnimEvent<K extends AnimEventType = AnimEventType> = {
  [T in AnimEventType]: { type: T; data: AnimEventDataMap[T] }
}[K]
