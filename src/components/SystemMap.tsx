"use client";

import { useEffect, useState } from "react";

const CX = 480;
const CY = 320;
const RADIUS = 185;
const NODE_R = 48;
const LABEL_R = RADIUS + 68;

interface Stage {
  angle: number;
  color: string;
  glow: string;
  title: string;
  subtitle: string;
  icon: "markets" | "brain" | "risk" | "check" | "loop";
}

const STAGES: Stage[] = [
  { angle: -90, color: "#0EA5E9", glow: "#7DD3FC", title: "7 mercados", subtitle: "Order books en vivo", icon: "markets" },
  { angle: -18, color: "#10B981", glow: "#6EE7B7", title: "Edge Tensor", subtitle: "AET + ML ensemble", icon: "brain" },
  { angle: 54, color: "#F59E0B", glow: "#FCD34D", title: "Riesgo", subtitle: "Kelly · circuit breaker", icon: "risk" },
  { angle: 126, color: "#14B8A6", glow: "#5EEAD4", title: "Ejecución", subtitle: "Preflight en 2 piernas", icon: "check" },
  { angle: 198, color: "#8B5CF6", glow: "#C4B5FD", title: "Aprendizaje", subtitle: "Recalibra el modelo", icon: "loop" }
];

function point(angle: number, radius: number): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

const RING_PATH = `M ${CX + RADIUS} ${CY} A ${RADIUS} ${RADIUS} 0 1 1 ${CX - RADIUS} ${CY} A ${RADIUS} ${RADIUS} 0 1 1 ${CX + RADIUS} ${CY}`;

export function SystemMap() {
  const [animated, setAnimated] = useState(true);
  const [hovered, setHovered] = useState<number | null>(null);

  useEffect(() => {
    setAnimated(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  return (
    <svg
      aria-label="El ciclo de ArbitrAI: mercados, Edge Tensor, riesgo, ejecución y aprendizaje que recalibra el modelo"
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      viewBox="0 0 960 640"
    >
      <defs>
        <filter height="240%" id="softBlur" width="240%" x="-70%" y="-70%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
        <filter height="300%" id="bigBlur" width="300%" x="-100%" y="-100%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
        {STAGES.map((stage, index) => {
          const next = STAGES[(index + 1) % STAGES.length];
          const from = point(stage.angle, RADIUS);
          const to = point(next.angle, RADIUS);
          return (
            <linearGradient gradientUnits="userSpaceOnUse" id={`seg-${index}`} key={index} x1={from.x} x2={to.x} y1={from.y} y2={to.y}>
              <stop offset="0%" stopColor={stage.color} />
              <stop offset="100%" stopColor={next.color} />
            </linearGradient>
          );
        })}
        {STAGES.map((stage, index) => (
          <radialGradient cx="35%" cy="30%" id={`node-${index}`} key={index} r="75%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="55%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor={stage.glow} stopOpacity={0.55} />
          </radialGradient>
        ))}
      </defs>

      <circle cx={CX} cy={CY} fill="#38BDF8" filter="url(#bigBlur)" opacity={0.1} r={RADIUS + 20} />
      <RingSegments />
      <ArrowTicks />

      {animated && <FlowDots />}

      {STAGES.map((stage, index) => (
        <Node hovered={hovered === index} index={index} key={stage.title} onHover={setHovered} stage={stage} />
      ))}

      <circle cx={CX} cy={CY} fill="none" opacity={0.5} r={RADIUS - 92} stroke="#CBD5E1" strokeDasharray="1 7" strokeWidth={1.25} />
      <text fill="#1E293B" fontFamily="ui-sans-serif, system-ui" fontSize={20} fontWeight={900} textAnchor="middle" x={CX} y={CY - 6}>
        Un ciclo,
      </text>
      <text fill="#1E293B" fontFamily="ui-sans-serif, system-ui" fontSize={20} fontWeight={900} textAnchor="middle" x={CX} y={CY + 19}>
        no una fila
      </text>
      <text fill="#94A3B8" fontFamily="ui-sans-serif, system-ui" fontSize={11.5} fontWeight={700} textAnchor="middle" x={CX} y={CY + 42}>
        cada resultado recalibra el siguiente
      </text>
    </svg>
  );
}

function RingSegments() {
  return (
    <>
      <g opacity={0.45}>
        {STAGES.map((stage, index) => {
          const next = STAGES[(index + 1) % STAGES.length];
          const from = point(stage.angle, RADIUS);
          const to = point(next.angle, RADIUS);
          return (
            <path
              d={`M ${from.x} ${from.y} A ${RADIUS} ${RADIUS} 0 0 1 ${to.x} ${to.y}`}
              fill="none"
              filter="url(#softBlur)"
              key={index}
              stroke={`url(#seg-${index})`}
              strokeWidth={16}
            />
          );
        })}
      </g>
      {STAGES.map((stage, index) => {
        const next = STAGES[(index + 1) % STAGES.length];
        const from = point(stage.angle, RADIUS);
        const to = point(next.angle, RADIUS);
        return (
          <path
            d={`M ${from.x} ${from.y} A ${RADIUS} ${RADIUS} 0 0 1 ${to.x} ${to.y}`}
            fill="none"
            key={index}
            stroke={`url(#seg-${index})`}
            strokeLinecap="round"
            strokeWidth={5}
          />
        );
      })}
    </>
  );
}

// Points tangent to the ring in the direction of travel (angle + 90deg, since the
// ring is parameterized clockwise as the angle increases).
function ArrowTicks() {
  return (
    <>
      {STAGES.map((stage) => {
        const midAngle = stage.angle + 36;
        const tip = point(midAngle, RADIUS);
        return (
          <polygon
            fill="#FFFFFF"
            key={stage.title}
            points="-5,-4.5 5.5,0 -5,4.5"
            stroke="#94A3B8"
            strokeLinejoin="round"
            strokeWidth={1}
            transform={`translate(${tip.x} ${tip.y}) rotate(${midAngle + 90})`}
          />
        );
      })}
    </>
  );
}

function FlowDots() {
  const trail = [0, 1, 2, 3];
  return (
    <>
      {STAGES.map((stage, stageIndex) => (
        <g key={stage.title}>
          {trail.map((echo) => (
            <circle fill={stage.color} key={echo} opacity={1 - echo * 0.24} r={7 - echo * 1.3}>
              <animateMotion begin={`${stageIndex * 2.9 - echo * 0.16}s`} dur="14.6s" path={RING_PATH} repeatCount="indefinite" />
            </circle>
          ))}
        </g>
      ))}
    </>
  );
}

function Node({
  hovered,
  index,
  onHover,
  stage
}: {
  hovered: boolean;
  index: number;
  onHover: (index: number | null) => void;
  stage: Stage;
}) {
  const nodeCenter = point(stage.angle, RADIUS);
  const labelCenter = point(stage.angle, LABEL_R);
  const cosA = Math.cos((stage.angle * Math.PI) / 180);
  const anchor = cosA > 0.35 ? "start" : cosA < -0.35 ? "end" : "middle";
  const dx = anchor === "start" ? 4 : anchor === "end" ? -4 : 0;

  return (
    <g
      onMouseEnter={() => onHover(index)}
      onMouseLeave={() => onHover(null)}
      style={{
        cursor: "pointer",
        transformBox: "fill-box",
        transformOrigin: "center",
        transform: hovered ? "scale(1.14)" : "scale(1)",
        transition: "transform 220ms cubic-bezier(0.22,1,0.36,1)"
      }}
    >
      <circle cx={nodeCenter.x} cy={nodeCenter.y} fill={stage.color} filter="url(#softBlur)" opacity={hovered ? 0.55 : 0.32} r={NODE_R + 14} />
      <circle cx={nodeCenter.x} cy={nodeCenter.y} fill={`url(#node-${index})`} r={NODE_R} stroke={stage.color} strokeWidth={3} />
      <g stroke={stage.color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.6} transform={`translate(${nodeCenter.x} ${nodeCenter.y})`}>
        <StageIcon icon={stage.icon} />
      </g>
      <text
        fill="#0F172A"
        fontFamily="ui-sans-serif, system-ui"
        fontSize={17}
        fontWeight={900}
        textAnchor={anchor}
        x={labelCenter.x + dx}
        y={labelCenter.y - 3}
      >
        {stage.title}
      </text>
      <text
        fill="#64748B"
        fontFamily="ui-sans-serif, system-ui"
        fontSize={11.5}
        fontWeight={700}
        textAnchor={anchor}
        x={labelCenter.x + dx}
        y={labelCenter.y + 16}
      >
        {stage.subtitle}
      </text>
    </g>
  );
}

function StageIcon({ icon }: { icon: Stage["icon"] }) {
  if (icon === "markets") {
    return (
      <>
        <line x1={-11} x2={-11} y1={6} y2={-6} />
        <line x1={0} x2={0} y1={9} y2={-11} />
        <line x1={11} x2={11} y1={9} y2={0} />
      </>
    );
  }
  if (icon === "brain") {
    return (
      <>
        <circle cx={0} cy={-9} fill="currentColor" r={2.8} stroke="none" />
        <circle cx={-9} cy={8} fill="currentColor" r={2.8} stroke="none" />
        <circle cx={9} cy={8} fill="currentColor" r={2.8} stroke="none" />
        <line x1={0} x2={-9} y1={-9} y2={8} />
        <line x1={0} x2={9} y1={-9} y2={8} />
        <line x1={-9} x2={9} y1={8} y2={8} />
      </>
    );
  }
  if (icon === "risk") {
    return (
      <>
        <circle cx={0} cy={0} fill="none" r={13} />
        <circle cx={0} cy={0} fill="currentColor" r={4} stroke="none" />
      </>
    );
  }
  if (icon === "check") {
    return <polyline fill="none" points="-11,0 -3,9 12,-10" />;
  }
  return (
    <>
      <path d="M 10 -10 A 14 14 0 1 0 12 6" fill="none" />
      <polygon fill="currentColor" points="12,6 12,-3 20,2" stroke="none" />
    </>
  );
}
