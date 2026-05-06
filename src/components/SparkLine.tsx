"use client";

interface SparkLineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fillColor?: string;
  max?: number;
}

export function SparkLine({
  data,
  width = 80,
  height = 28,
  color = "#3b82f6",
  fillColor,
  max,
}: SparkLineProps) {
  if (!data.length) return <div style={{ width, height }} />;

  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const maxVal = max ?? Math.max(...data, 1);
  const minVal = 0;

  const pts = data.map((v, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * w;
    const y = pad + h - ((v - minVal) / (maxVal - minVal)) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const fill = fillColor ?? `${color}22`;
  const lastPt = pts[pts.length - 1].split(",");
  const area =
    `M ${pts[0].split(",")[0]},${(pad + h).toFixed(1)} ` +
    `L ${pts.join(" L ")} ` +
    `L ${lastPt[0]},${(pad + h).toFixed(1)} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={area} fill={fill} />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      {/* Last value dot */}
      {pts.length > 0 && (
        <circle
          cx={lastPt[0]}
          cy={lastPt[1]}
          r="2"
          fill={color}
        />
      )}
    </svg>
  );
}
