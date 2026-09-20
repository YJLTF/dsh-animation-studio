/**
 * 后台任务轮询的共享 hook（0.6.0 规划 §6.4）：此前 PreviewTicket 与
 * BackgroundTicket 是两份几乎相同的 ~60 行轮询实现——「落定停表、连续不可达
 * 退避到 10s」的纪律只此一份，两处实现难保不漂移。
 *
 * 纪律与 0.4/0.5 语义一致：2s 轮询 → 任务落定（非 running）即停表；连续 3 次
 * 拿不到任务退避到 10s（宿主重启清簿后卡片降级但不被打爆）。
 */

import { useEffect, useState } from 'react'

import { fetchRenderStatus, type RenderStatus } from '../protocol.ts'

export function useJobPolling(jobId: string | undefined): { status: RenderStatus | null; unreachable: boolean } {
  const [status, setStatus] = useState<RenderStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  useEffect(() => {
    if (!jobId) return
    const id: string = jobId
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined = setInterval(tick, 2000)
    let misses = 0
    async function tick(): Promise<void> {
      try {
        const job = await fetchRenderStatus(id)
        if (!alive) return
        setUnreachable(job === null)
        if (job === null) {
          misses += 1
          if (misses === 3 && timer) {
            clearInterval(timer)
            timer = setInterval(tick, 10_000)
          }
          return
        }
        misses = 0
        setStatus(job)
        if (job.status !== 'running' && timer) {
          clearInterval(timer)
          timer = undefined
        }
      } catch {
        if (!alive) return
        setUnreachable(true)
        misses += 1
        if (misses === 3 && timer) {
          clearInterval(timer)
          timer = setInterval(tick, 10_000)
        }
      }
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [jobId])

  return { status, unreachable }
}
