"use client";

import { gaugeColor } from "@/lib/utils";

interface ArcGaugeProps {
  pct: number;
  label: string;
  sublabel?: string;
  size?: number;
  colorOverride?: string;
  trackColor?: string;
}

const R = 36;
const C = 2 * Math.PI * R;
const ARC = (270 / 360) * C;  // 270° arc length
const GAP = C - ARC;           // 90° gap

export function ArcGauge({
  pct,
  label,
  sublabel,
  size = 120,
  colorOverride,
  trackColor = "#1a2540",
}: ArcGaugeProps) {
  const safeP = Math.max(0, Math.min(100, pct || 0));
  const color = colorOverride ?? gaugeColor(safeP);
  const valueArc = (safeP / 100) * ARC;

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        style={{ overflow: "visible" }}
      >
        {/* Glow filter */}
        <defs>
          <filter id={`glow-${label}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Background track */}
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke={trackColor}
          strokeWidth="7"
          strokeDasharray={`${ARC} ${GAP}`}
          transform="rotate(135, 50, 50)"
          strokeLinecap="round"
        />

        {/* Value fill */}
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeDasharray={`${valueArc} ${C - valueArc}`}
          transform="rotate(135, 50, 50)"
          strokeLinecap="round"
          className="gauge-value"
          filter={`url(#glow-${label})`}
          style={{ filter: `drop-shadow(0 0 4px ${color}88)` }}
        />

        {/* Center percentage */}
        <text
          x="50"
          y="46"
          textAnchor="middle"
          fontSize="18"
          fontWeight="700"
          fill={color}
          fontFamily="inherit"
        >
          {safeP}
        </text>
        <text
          x="50"
          y="58"
          textAnchor="middle"
          fontSize="8"
          fill="#64748b"
          fontFamily="inherit"
        >
          %
        </text>
      </svg>

      <div className="text-center">
        <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, letterSpacing: "0.05em" }}>
          {label}
        </div>
        {sublabel && (
          <div style={{ fontSize: 10, color: "#475569" }}>{sublabel}</div>
        )}
      </div>
    </div>
  );
}
