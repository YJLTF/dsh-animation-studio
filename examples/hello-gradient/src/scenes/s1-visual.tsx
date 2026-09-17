/**
 * 场景 2：可视化：小球滚向谷底
 * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。
 */
import {all, createRef, delay, easeInCubic, easeInOutCubic, easeOutCubic} from '@motion-canvas/core';
import {makeScene2D, Circle, Line, Rect, Txt} from '@motion-canvas/2d';
import {springTiming} from '../anim-easing';

export default makeScene2D(function* (view) {
  view.fill('#101418');

  const n0_axis = createRef<Line>();
  view.add(<Line ref={n0_axis} points={[[-310,170],[310,170]]} stroke={"#4C9AFF"} lineWidth={4} />);
  const n1_dir_arrow = createRef<Line>();
  view.add(<Line ref={n1_dir_arrow} points={[[0,-60],[0,-150]]} stroke={"#FFB020"} lineWidth={4} endArrow={true} />);
  const n2_ball = createRef<Circle>();
  view.add(<Circle ref={n2_ball} fill={"#FFB020"} x={-240} y={-150} size={64} />);
  const n3_ball_label = createRef<Txt>();
  view.add(<Txt ref={n3_ball_label} text={"每一步都朝着更低的地方走"} fontSize={38} fill={"#F2F5F7"} x={0} y={-230} />);
  const nsub0bg = createRef<Rect>();
  view.add(<Rect ref={nsub0bg} x={0} y={288} width={541} height={73} radius={18} fill={"#8B97A3"} opacity={0} />);
  const nsub0tx = createRef<Txt>();
  view.add(<Txt ref={nsub0tx} x={0} y={288} text={"梯度下降：沿着最陡的方向走到最低点"} fontSize={29} lineHeight={'140'} textWrap={'pre'} fill={"#F2F5F7"} opacity={0} />);

  // 动画初值：让每条轨道的起点在第一时间生效
  n0_axis().end(0);
  n0_axis().opacity(0);
  n1_dir_arrow().end(0);
  n1_dir_arrow().opacity(0);
  n2_ball().x(-240);
  n2_ball().y(-150);
  n3_ball_label().opacity(0);
  view.opacity(0);

  yield* all(
    delay(0, n0_axis().end(1, 0.6, easeOutCubic)),
    delay(0, n0_axis().opacity(1, 0.4)),
    delay(0.7, n1_dir_arrow().end(1, 0.6, easeOutCubic)),
    delay(0.7, n1_dir_arrow().opacity(1, 0.4)),
    delay(0.2, n2_ball().x(60, 2.4, easeInOutCubic)),
    delay(0.2, n2_ball().y(138, 1.7, easeInCubic)),
    delay(1.9, n2_ball().y(100, 0.5, springTiming(180, 14, 1))),
    delay(2.4, n2_ball().y(138, 0.5, easeInOutCubic)),
    delay(0.8, n3_ball_label().opacity(1, 0.5, easeOutCubic)),
    delay(1.3, n3_ball_label().opacity(1, 1.4)),
    delay(2.7, n3_ball_label().opacity(0, 0.3)),
    delay(0, view.opacity(1, 0.35)),
    delay(0, nsub0bg().opacity(0.6, 0.15)),
    delay(0, nsub0tx().opacity(1, 0.15)),
    delay(1.9, nsub0bg().opacity(0, 0.15)),
    delay(1.9, nsub0tx().opacity(0, 0.15)),
  );
});
