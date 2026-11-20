// src/utils/format.ts — 显示格式化工具

export function formatShutterLabel(t: number): string {
  if (t >= 1) return `${t.toFixed(t < 10 ? 1 : 0)}s`;
  return `1/${Math.round(1 / t)}`;
}

export function formatEv(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)} EV`;
}
