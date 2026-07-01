"use client";

import { useEffect, useState } from "react";

const CX = 480;
const CY = 320;
const RADIUS = 185;
const NODE_R = 46;
const LABEL_R = RADIUS + 66;

interface Stage {
  angle: number;
  color: string;
  soft: string;
  title: string;
  subtitle: string;
  icon: "markets" | "brain" | "risk" | "check" | "loop";
}

const STAGES: Stage[] = [
  { angle: -90, color: "#0284C7", soft: "#E0F2FE", title: "7 mercados", subtitle: "Order books en vivo", icon: "markets" },
  { angle: -18, color: "#059669", soft: "#D1FAE5", title: "Edge Tensor", subtitle: "AET + ML ensemble", icon: "brain" },
  { angle: 54, color: "#B45309", soft: "#FEF3C7", title: "Riesgo", subtitle: "Kelly · circuit breaker", icon: "risk" },
  { angle: 126, color: "#0F766E", soft: "#CCFBF1", title: "Ejecución", subtitle: "Preflight en 2 piernas", icon: "check" },
  { angle: 198, color: "#7C3AED", soft: "#EDE9FE", title: "Aprendizaje", subtitle: "Recalibra el modelo", icon: "loop" }
];

function point(angle: number, radius: number): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

const RING_PATH = `M ${CX + RADIUS} ${CY} A ${RADIUS} ${RADIUS} 0 1 1 ${CX - RADIUS} ${CY} A ${RADIUS} ${RADIUS} 0 1 1 ${CX + RADIUS} ${CY}`;

export function SystemMap() {
  const [animated, setAnimated] = useState(true);

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
        <filter height="240%" id="glow" width="240%" x="-70%" y="-70%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
      </defs>

      <circle cx={CX} cy={CY} fill="#38BDF8" filter="url(#glow)" opacity={0.08} r={RADIUS - 40} />
      <path d={RING_PATH} fill="none" stroke="#CBD5E1" strokeWidth={2.5} />
      <ArrowTicks />

      {animated && <FlowDots />}

      {STAGES.map((stage) => (
        <Node key={stage.title} stage={stage} />
      ))}

      <text fill="#334155" fontFamily="ui-sans-serif, system-ui" fontSize={19} fontWeight={800} textAnchor="middle" x={CX} y={CY - 6}>
        Un ciclo,
      </text>
      <text fill="#334155" fontFamily="ui-sans-serif, system-ui" fontSize={19} fontWeight={800} textAnchor="middle" x={CX} y={CY + 18}>
        no una fila
      </text>
      <text fill="#94A3B8" fontFamily="ui-sans-serif, system-ui" fontSize={11.5} fontWeight={600} textAnchor="middle" x={CX} y={CY + 40}>
        cada resultado recalibra el siguiente
      </text>
    </svg>
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
            fill="#94A3B8"
            key={stage.title}
            points="-5,-4 5,0 -5,4"
            transform={`translate(${tip.x} ${tip.y}) rotate(${midAngle + 90})`}
          />
        );
      })}
    </>
  );
}

function FlowDots() {
  const colors = ["#38BDF8", "#34D399", "#A78BFA"];
  return (
    <>
      {colors.map((color, index) => (
        <circle fill={color} key={color} r={5}>
          <animateMotion begin={`${index * 4.6}s`} dur="13.8s" path={RING_PATH} repeatCount="indefinite" />
        </circle>
      ))}
    </>
  );
}

function Node({ stage }: { stage: Stage }) {
  const nodeCenter = point(stage.angle, RADIUS);
  const labelCenter = point(stage.angle, LABEL_R);
  const cosA = Math.cos((stage.angle * Math.PI) / 180);
  const anchor = cosA > 0.35 ? "start" : cosA < -0.35 ? "end" : "middle";
  const dx = anchor === "start" ? 4 : anchor === "end" ? -4 : 0;

  return (
    <g>
      <circle cx={nodeCenter.x} cy={nodeCenter.y} fill={stage.soft} r={NODE_R} stroke={stage.color} strokeWidth={2.5} />
      <g stroke={stage.color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} transform={`translate(${nodeCenter.x} ${nodeCenter.y})`}>
        <StageIcon icon={stage.icon} />
      </g>
      <text
        fill="#1E293B"
        fontFamily="ui-sans-serif, system-ui"
        fontSize={16}
        fontWeight={800}
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
        fontWeight={600}
        textAnchor={anchor}
        x={labelCenter.x + dx}
        y={labelCenter.y + 15}
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
        <circle cx={0} cy={-9} fill="currentColor" r={2.6} stroke="none" />
        <circle cx={-9} cy={8} fill="currentColor" r={2.6} stroke="none" />
        <circle cx={9} cy={8} fill="currentColor" r={2.6} stroke="none" />
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
        <circle cx={0} cy={0} fill="none" r={5} />
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
