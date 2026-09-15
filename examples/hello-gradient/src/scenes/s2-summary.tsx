/**
 * 场景 3：收尾：引出学习率
 * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。
 */
import {all, createRef, delay, easeOutCubic} from '@motion-canvas/core';
import {makeScene2D, Path, SVG, Txt} from '@motion-canvas/2d';
import {springTiming} from '../anim-easing';

export default makeScene2D(function* (view) {
  view.fill('#101418');

  const n0_sum_main = createRef<Txt>();
  view.add(<Txt ref={n0_sum_main} text={"下一步：学习率决定每步走多远"} fontSize={56} fill={"#F2F5F7"} x={0} y={-30} />);
  const n1_sum_star = createRef<Path>();
  view.add(<Path ref={n1_sum_star} fill={"#FFB020"} x={270} y={-30} data={"M 0,-22 L 6.798374,-9.357159 L 20.923243,-6.798374 L 11,3.574117 L 12.931276,17.798374 L 0,11.566084 L -12.931276,17.798374 L -11,3.574117 L -20.923243,-6.798374 L -6.798374,-9.357159 Z"} />);
  const n2_sum_check = createRef<SVG>();
  view.add(<SVG ref={n2_sum_check} svg={"<svg viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M4 12.5 L9.5 18 L20 6\" stroke=\"#7DD87D\" stroke-width=\"3.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>"} width={36} height={36} x={-290} y={-30} />);
  const n3_sum_tip = createRef<Txt>();
  view.add(<Txt ref={n3_sum_tip} text={"步子太大容易来回震荡，太小则收敛太慢"} fontSize={32} fill={"#8B97A3"} x={0} y={70} />);

  // 动画初值：让每条轨道的起点在第一时间生效
  n0_sum_main().scale(0.85);
  n0_sum_main().opacity(0);
  n1_sum_star().scale(0);
  n2_sum_check().opacity(0);
  n3_sum_tip().opacity(0);
  view.opacity(0);

  yield* all(
    delay(0.4, n0_sum_main().scale(1, 0.7, springTiming(200, 15, 1))),
    delay(0.4, n0_sum_main().opacity(1, 0.5)),
    delay(0.9, n0_sum_main().opacity(1, 1.3)),
    delay(2.2, n0_sum_main().opacity(0, 0.3)),
    delay(1.1, n1_sum_star().scale(1, 0.5, springTiming(220, 12, 1))),
    delay(1.4, n2_sum_check().opacity(1, 0.4)),
    delay(1, n3_sum_tip().opacity(1, 0.5, easeOutCubic)),
    delay(1.5, n3_sum_tip().opacity(1, 0.7)),
    delay(2.2, n3_sum_tip().opacity(0, 0.3)),
    delay(0, view.opacity(1, 0.35)),
  );
});
