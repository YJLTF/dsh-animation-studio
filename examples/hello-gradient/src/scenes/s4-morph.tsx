/**
 * 场景 5：0.4.0 技巧演示：代码演化 / back 弹入 / zoomIn 入场 / fade 退场
 * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。
 */
import {all, createRef, delay, easeInOutCubic, easeOutBack} from '@motion-canvas/core';
import {makeScene2D, Code, Path, Rect, Txt} from '@motion-canvas/2d';
import {pythonHighlighter} from '../code-highlight';

export default makeScene2D(function* (view) {
  view.fill('#101418');

  const n0_m_code = createRef<Code>();
  view.add(<Code ref={n0_m_code} code={"theta = theta - alpha * grad"} fontSize={34} fill={"#F2F5F7"} x={0} y={-40} highlighter={pythonHighlighter} />);
  const n1_m_star = createRef<Path>();
  view.add(<Path ref={n1_m_star} fill={"#FFB020"} x={320} y={-40} data={"M 0,-20 L 6.18034,-8.506508 L 19.02113,-6.18034 L 10,3.249197 L 11.755705,16.18034 L 0,10.514622 L -11.755705,16.18034 L -10,3.249197 L -19.02113,-6.18034 L -6.18034,-8.506508 Z"} />);
  const nsub0bg = createRef<Rect>();
  view.add(<Rect ref={nsub0bg} x={0} y={286} width={648} height={76} radius={19} fill={"#8B97A3"} opacity={0} />);
  const nsub0tx = createRef<Txt>();
  view.add(<Txt ref={nsub0tx} x={0} y={286} text={"更新规则：参数减去学习率乘梯度"} fontSize={40} fill={"#F2F5F7"} opacity={0} />);

  // 动画初值：让每条轨道的起点在第一时间生效
  n0_m_code().code("theta = theta - alpha * grad");
  n1_m_star().scale(0);
  view.scale(0.6);
  view.opacity(0);

  yield* all(
    delay(0, n0_m_code().code("theta = theta - 0.1 * grad", 1.6, easeInOutCubic)),
    delay(1.8, n1_m_star().scale(1, 0.5, easeOutBack)),
    delay(0, view.scale(1, 0.45)),
    delay(0, view.opacity(1, 0.45)),
    delay(2.5, view.opacity(0, 0.5)),
    delay(0.3, nsub0bg().opacity(0.6, 0.15)),
    delay(0.3, nsub0tx().opacity(1, 0.15)),
    delay(2.85, nsub0bg().opacity(0, 0.15)),
    delay(2.85, nsub0tx().opacity(0, 0.15)),
  );
});
