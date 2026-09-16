/**
 * 场景 4：公式与代码：更新规则
 * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。
 */
import {all, createRef, delay, easeOutCubic} from '@motion-canvas/core';
import {makeScene2D, Code, Latex} from '@motion-canvas/2d';
import {pythonHighlighter} from '../code-highlight';

export default makeScene2D(function* (view) {
  view.fill('#101418');

  const n0_f_math = createRef<Latex>();
  view.add(<Latex ref={n0_f_math} tex={"\\theta := \\theta - \\alpha \\nabla J(\\theta)"} fontSize={52} x={0} y={-160} fill={"#F2F5F7"} />);
  const n1_f_code = createRef<Code>();
  view.add(<Code ref={n1_f_code} code={"for i in range(steps):\n    grad = gradient(theta)\n    theta -= alpha * grad"} fontSize={26} fill={"#F2F5F7"} x={0} y={120} highlighter={pythonHighlighter} />);

  // 动画初值：让每条轨道的起点在第一时间生效
  n0_f_math().opacity(0);
  n1_f_code().opacity(0);
  view.opacity(0);

  yield* all(
    delay(0, n0_f_math().opacity(1, 0.7, easeOutCubic)),
    delay(0.7, n0_f_math().opacity(1, 2.1)),
    delay(2.8, n0_f_math().opacity(0, 0.4)),
    delay(0.7, n1_f_code().opacity(1, 0.6, easeOutCubic)),
    delay(1.3, n1_f_code().opacity(1, 1.5)),
    delay(2.8, n1_f_code().opacity(0, 0.4)),
    delay(0, view.opacity(1, 0.35)),
  );
});
