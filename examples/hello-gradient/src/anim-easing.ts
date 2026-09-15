/**
 * IR 缓动的内联实现。由 @dsh-anim/render-mc 生成，请勿手工编辑。
 *
 * - cubicBezier：MC 未导出同名函数，二分求解参数 s。
 * - springTiming：阻尼弹簧解析解，在 t=1 处收敛到 1；不用 MC 原生 spring，
 *   因为它的时长由物理参数决定，无法与 IR 的 durationMs 契约对齐。
 */

export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const bez = (s: number, p1: number, p2: number) =>
    3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s ** 2 * p2 + s ** 3;
  return (t: number) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bez(mid, x1, x2) < t) lo = mid; else hi = mid;
    }
    return bez((lo + hi) / 2, y1, y2);
  };
}

export function springTiming(stiffness: number, damping: number, mass: number) {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const wd = w0 * Math.sqrt(Math.max(0, 1 - zeta * zeta));
  return (t: number) => {
    const p = Math.min(1, Math.max(0.0001, t));
    return 1 - Math.exp(-zeta * w0 * p) * (Math.cos(wd * p) + ((zeta * w0) / wd) * Math.sin(wd * p));
  };
}
