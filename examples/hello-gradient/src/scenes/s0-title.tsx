/**
 * 场景 1：概念引入：一句话讲清梯度下降
 * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。
 */
import {all, createRef, delay, easeInCubic, easeOutCubic} from '@motion-canvas/core';
import {makeScene2D, Txt} from '@motion-canvas/2d';

export default makeScene2D(function* (view) {
  view.fill('#101418');

  const n0_title_main = createRef<Txt>();
  view.add(<Txt ref={n0_title_main} text={"梯度下降"} fontSize={104} fill={"#F2F5F7"} fontWeight={700} x={0} y={-60} />);
  const n1_title_sub = createRef<Txt>();
  view.add(<Txt ref={n1_title_sub} text={"沿着最陡的方向，一步步走到最低点"} fontSize={40} fill={"#8B97A3"} x={0} y={60} />);

  // 动画初值：让每条轨道的起点在第一时间生效
  n0_title_main().opacity(0);
  n0_title_main().y(-20);
  n1_title_sub().opacity(0);

  yield* all(
    delay(0, n0_title_main().opacity(1, 0.7, easeOutCubic)),
    delay(0.7, n0_title_main().opacity(1, 1.4)),
    delay(2.1, n0_title_main().opacity(0, 0.4, easeInCubic)),
    delay(0, n0_title_main().y(-60, 0.7, easeOutCubic)),
    delay(0.3, n1_title_sub().opacity(1, 0.8, easeOutCubic)),
    delay(1.1, n1_title_sub().opacity(1, 1)),
    delay(2.1, n1_title_sub().opacity(0, 0.3, easeInCubic)),
  );
});
