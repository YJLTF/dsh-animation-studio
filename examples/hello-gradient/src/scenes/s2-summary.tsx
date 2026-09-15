/**
 * 场景 3：收尾：引出学习率
 * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。
 */
import {all, createRef, delay, easeOutCubic} from '@motion-canvas/core';
import {makeScene2D, Txt} from '@motion-canvas/2d';
import {springTiming} from '../anim-easing';

export default makeScene2D(function* (view) {
  view.fill('#101418');

  const n0_sum_main = createRef<Txt>();
  view.add(<Txt ref={n0_sum_main} text={"下一步：学习率决定每步走多远"} fontSize={56} fill={"#F2F5F7"} x={0} y={-30} />);
  const n1_sum_tip = createRef<Txt>();
  view.add(<Txt ref={n1_sum_tip} text={"步子太大容易来回震荡，太小则收敛太慢"} fontSize={32} fill={"#8B97A3"} x={0} y={70} />);

  // 动画初值：让每条轨道的起点在第一时间生效
  n0_sum_main().scale(0.85);
  n0_sum_main().opacity(0);
  n1_sum_tip().opacity(0);
  view.opacity(0);

  yield* all(
    delay(0.4, n0_sum_main().scale(1, 0.7, springTiming(200, 15, 1))),
    delay(0.4, n0_sum_main().opacity(1, 0.5)),
    delay(0.9, n0_sum_main().opacity(1, 1.3)),
    delay(2.2, n0_sum_main().opacity(0, 0.3)),
    delay(1, n1_sum_tip().opacity(1, 0.5, easeOutCubic)),
    delay(1.5, n1_sum_tip().opacity(1, 0.7)),
    delay(2.2, n1_sum_tip().opacity(0, 0.3)),
    delay(0, view.opacity(1, 0.35)),
  );
});
