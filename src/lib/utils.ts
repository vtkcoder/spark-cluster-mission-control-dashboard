export function fmtBytes(b: number, decimals = 1): string {
  if (b <= 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), units.length - 1);
  return `${(b / Math.pow(k, i)).toFixed(decimals)} ${units[i]}`;
}

export function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function gaugeColor(pct: number): string {
  if (pct < 65) return "#10b981";
  if (pct < 80) return "#f59e0b";
  if (pct < 90) return "#f97316";
  return "#ef4444";
}

export function tempColor(c: number): string {
  if (c < 55) return "#10b981";
  if (c < 70) return "#f59e0b";
  if (c < 82) return "#f97316";
  return "#ef4444";
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
