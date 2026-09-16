/**
 * 梯度下降：直觉理解
 *
 * 由 @dsh-anim/render-mc 从 AnimationSpec 生成，请勿手工编辑。
 * `?scene` 后缀是必需的：vite 插件会给场景补上 makeProject 需要的运行时字段。
 */
import s0 from './scenes/s0-title?scene';
import s1 from './scenes/s1-visual?scene';
import s2 from './scenes/s2-summary?scene';
import s3 from './scenes/s3-formula?scene';
import {makeProject} from '@motion-canvas/core';

export default makeProject({
  // 1280x720 @ 30fps
  scenes: [
    s0,
    s1,
    s2,
    s3,
  ],
});
