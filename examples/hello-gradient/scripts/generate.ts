/**
 * 把样例 spec 编译成 Motion Canvas 项目（src/ 下的生成物）。
 *
 * 这是「IR → 后端源码」这一步的最小演示：先校验、再生成，
 * 生成期的降级（属性不被支持等）以警告形式打印而不是静默吞掉。
 */
import { sceneDurationMs, specDurationMs } from '@dsh-anim/spec'

import { syncProject } from './common.ts'
import { spec } from '../src/spec.ts'

syncProject()

console.log(`已生成到 src/：场景 ${spec.scenes.length} 个，总时长 ${(specDurationMs(spec.scenes) / 1000).toFixed(2)}s`)
for (const [i, s] of spec.scenes.entries()) {
  console.log(`  ${i + 1}. ${s.name} — ${(sceneDurationMs(s) / 1000).toFixed(2)}s，图层 ${s.layers.length} 个`)
}
