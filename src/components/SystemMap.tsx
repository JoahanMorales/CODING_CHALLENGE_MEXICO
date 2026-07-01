"use client";

import { useEffect, useState } from "react";
import { EXCHANGE_IDS, EXCHANGE_LABELS } from "@/lib/config/exchanges";

const FEATURES = ["MLOFI", "Microprice", "Profundidad", "Volatilidad", "Quote age"];
const STRATEGIES = ["Cross-Exchange", "Triangular", "Stat-Arb", "Latencia"];

const MIND_X = 460;
const MIND_Y = 300;
const FEATURE_R = 132;
const STRATEGY_R = 178;

export function SystemMap({ compact = false }: { compact?: boolean }) {
  const [animated, setAnimated] = useState(true);

  useEffect(() => {
    setAnimated(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  return (
    <svg
      aria-label="Mapa del sistema ArbitrAI: siete venues, el Edge Tensor, filtrado de riesgo, ejecución y aprendizaje"
      className="h-full w-full"
      preserveAspectRatio={compact ? "xMidYMid meet" : "xMidYMid slice"}
      viewBox="0 0 1200 600"
    >
      <defs>
        <radialGradient id="mindGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#34D399" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#34D399" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="feederGradient" x1="0%" x2="100%">
          <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.08" />
        </linearGradient>
        <linearGradient id="riverGradient" x1="0%" x2="100%">
          <stop offset="0%" stopColor="#F472B6" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#A78BFA" stopOpacity="0.55" />
        </linearGradient>
        <marker id="ledgerDone" markerWidth="8" markerHeight="8" orient="auto" refX="4" refY="4" viewBox="0 0 8 8">
          <circle cx="4" cy="4" fill="#0D9488" r="3" />
        </marker>
      </defs>

      <BackgroundGrid />
      <IntakeFan animated={animated} />
      <Mind animated={animated} />
      <Funnel animated={animated} />
      <RiskGate />
      <ExecutionLedger animated={animated} />
      <LearningRiver animated={animated} />
    </svg>
  );
}

function Caption({ children, color, x, y }: { children: React.ReactNode; color: string; x: number; y: number }) {
  return (
    <text
      fill={color}
      fontFamily="ui-monospace, monospace"
      fontSize={10}
      fontWeight={800}
      letterSpacing="0.06em"
      paintOrder="stroke"
      stroke="white"
      strokeWidth={4}
      textAnchor="middle"
      x={x}
      y={y}
    >
      {children}
    </text>
  );
}

function BackgroundGrid() {
  const lines = [];
  for (let x = 0; x <= 1200; x += 48) lines.push(<line key={`v${x}`} stroke="rgba(186,230,253,0.16)" x1={x} x2={x} y1={0} y2={600} />);
  for (let y = 0; y <= 600; y += 48) lines.push(<line key={`h${y}`} stroke="rgba(186,230,253,0.16)" x1={0} x2={1200} y1={y} y2={y} />);
  return <g strokeWidth={1}>{lines}</g>;
}

function IntakeFan({ animated }: { animated: boolean }) {
  const converge = { x: 322, y: MIND_Y };
  const step = 480 / (EXCHANGE_IDS.length - 1);
  return (
    <g>
      {EXCHANGE_IDS.map((exchange, index) => {
        const y = 60 + index * step;
        const controlX = (78 + converge.x) / 2;
        const path = `M 78 ${y} Q ${controlX} ${y} ${converge.x} ${converge.y}`;
        return (
          <g key={exchange}>
            <path d={path} fill="none" stroke="url(#feederGradient)" strokeWidth={1.4} />
            {animated && (
              <circle fill="#38BDF8" r={2.6}>
                <animateMotion begin={`${index * 0.5}s`} dur="3.4s" path={path} repeatCount="indefinite" />
              </circle>
            )}
            <circle className={animated ? "live-dot" : undefined} cx={78} cy={y} fill="#0EA5E9" r={4.5} style={{ animationDelay: `${index * 0.18}s` }} />
            <text fill="#0369A1" fontFamily="ui-monospace, monospace" fontSize={12} fontWeight={800} x={92} y={y + 4}>
              {EXCHANGE_LABELS[exchange]}
            </text>
          </g>
        );
      })}
      <Caption color="#0284C7" x={90} y={40}>7 VENUES EN VIVO</Caption>
    </g>
  );
}

// 9 orbit slots (5 features + 4 strategies) spaced 40deg apart so no two labels
// ever land at nearly the same angle, regardless of which ring they sit on.
const ORBIT_SLOTS: Array<{ label: string; tone: "feature" | "strategy" }> = [
  { label: STRATEGIES[0], tone: "strategy" },
  { label: FEATURES[0], tone: "feature" },
  { label: STRATEGIES[1], tone: "strategy" },
  { label: FEATURES[1], tone: "feature" },
  { label: STRATEGIES[2], tone: "strategy" },
  { label: FEATURES[2], tone: "feature" },
  { label: STRATEGIES[3], tone: "strategy" },
  { label: FEATURES[3], tone: "feature" },
  { label: FEATURES[4], tone: "feature" }
];

function Mind({ animated }: { animated: boolean }) {
  const slotAngleStep = 360 / ORBIT_SLOTS.length;
  return (
    <g>
      <circle cx={MIND_X} cy={MIND_Y} fill="url(#mindGlow)" r={210} />

      {ORBIT_SLOTS.map((slot, index) => (
        <OrbitTag
          angleDeg={index * slotAngleStep - 90}
          centerX={MIND_X}
          centerY={MIND_Y}
          color={slot.tone === "feature" ? "#38BDF8" : "#818CF8"}
          key={slot.label}
          label={slot.label}
          radius={slot.tone === "feature" ? FEATURE_R : STRATEGY_R}
          tone={slot.tone}
        />
      ))}

      <circle cx={MIND_X} cy={MIND_Y} fill="none" r={STRATEGY_R} stroke="#C7D2FE" strokeDasharray="1 10" strokeWidth={1} />
      <circle cx={MIND_X} cy={MIND_Y} fill="none" r={FEATURE_R} stroke="#BAE6FD" strokeDasharray="1 8" strokeWidth={1} />

      {animated && (
        <g>
          <path d={`M ${MIND_X} ${MIND_Y} L ${MIND_X} ${MIND_Y - STRATEGY_R - 6}`} stroke="#A7F3D0" strokeWidth={2} opacity={0.55}>
            <animateTransform attributeName="transform" dur="26s" from={`0 ${MIND_X} ${MIND_Y}`} repeatCount="indefinite" to={`360 ${MIND_X} ${MIND_Y}`} type="rotate" />
          </path>
        </g>
      )}

      <circle cx={MIND_X} cy={MIND_Y} fill="#ECFDF5" r={96} stroke="#34D399" strokeWidth={1.75} />
      <circle cx={MIND_X + 38} cy={MIND_Y + 38} fill="#F5F3FF" fillOpacity={0.94} r={54} stroke="#A78BFA" strokeWidth={1.75} />

      <text fill="#065F46" fontFamily="ui-sans-serif, system-ui" fontSize={22} fontWeight={900} textAnchor="middle" x={MIND_X - 14} y={MIND_Y - 12}>
        AET
      </text>
      <text fill="#047857" fontFamily="ui-monospace, monospace" fontSize={9} fontWeight={800} letterSpacing="0.04em" textAnchor="middle" x={MIND_X - 14} y={MIND_Y + 6}>
        EDGE TENSOR
      </text>
      <text fill="#6D28D9" fontFamily="ui-monospace, monospace" fontSize={10} fontWeight={900} textAnchor="middle" x={MIND_X + 38} y={MIND_Y + 42}>
        + ML
      </text>
      <Caption color="#0284C7" x={MIND_X} y={MIND_Y - 196}>LA MENTE · SOBREVIVE COSTOS + RIESGO</Caption>
    </g>
  );
}

function OrbitTag({
  angleDeg,
  centerX,
  centerY,
  color,
  label,
  radius,
  tone
}: {
  angleDeg: number;
  centerX: number;
  centerY: number;
  color: string;
  label: string;
  radius: number;
  tone: "feature" | "strategy";
}) {
  const angle = (angleDeg * Math.PI) / 180;
  const x = centerX + radius * Math.cos(angle);
  const y = centerY + radius * Math.sin(angle);
  const anchor = Math.cos(angle) > 0.15 ? "start" : Math.cos(angle) < -0.15 ? "end" : "middle";
  const dx = anchor === "start" ? 8 : anchor === "end" ? -8 : 0;
  const dy = anchor === "middle" ? (Math.sin(angle) < 0 ? -10 : 17) : 3.5;
  return (
    <g>
      <circle cx={x} cy={y} fill={color} r={tone === "feature" ? 3.4 : 4} />
      <text
        fill={tone === "feature" ? "#0369A1" : "#4338CA"}
        fontFamily="ui-monospace, monospace"
        fontSize={10}
        fontWeight={800}
        paintOrder="stroke"
        stroke="white"
        strokeWidth={3}
        textAnchor={anchor}
        x={x + dx}
        y={y + dy}
      >
        {label}
      </text>
    </g>
  );
}

const FUNNEL_MOUTH_X = 660;
const FUNNEL_NECK_X = 820;
const FUNNEL_TOP_MOUTH_Y = 176;
const FUNNEL_TOP_NECK_Y = 272;
const FUNNEL_BOTTOM_MOUTH_Y = 424;
const FUNNEL_BOTTOM_NECK_Y = 328;
const SURVIVE_PATH = `M ${FUNNEL_MOUTH_X} ${MIND_Y} L ${FUNNEL_NECK_X} ${MIND_Y}`;
const REJECT_PATH = `M ${FUNNEL_MOUTH_X + 30} ${MIND_Y + 40} Q ${FUNNEL_MOUTH_X + 90} ${FUNNEL_BOTTOM_MOUTH_Y + 40} ${FUNNEL_MOUTH_X + 130} 520 T 900 560`;

function Funnel({ animated }: { animated: boolean }) {
  const topWall = `M ${FUNNEL_MOUTH_X} ${FUNNEL_TOP_MOUTH_Y} Q ${(FUNNEL_MOUTH_X + FUNNEL_NECK_X) / 2} ${FUNNEL_TOP_MOUTH_Y} ${FUNNEL_NECK_X} ${FUNNEL_TOP_NECK_Y}`;
  const bottomWall = `M ${FUNNEL_MOUTH_X} ${FUNNEL_BOTTOM_MOUTH_Y} Q ${(FUNNEL_MOUTH_X + FUNNEL_NECK_X) / 2} ${FUNNEL_BOTTOM_MOUTH_Y} ${FUNNEL_NECK_X} ${FUNNEL_BOTTOM_NECK_Y}`;
  return (
    <g>
      <path d={topWall} fill="none" stroke="#FDBA74" strokeWidth={2} />
      <path d={bottomWall} fill="none" stroke="#FDBA74" strokeWidth={2} />
      <path d={REJECT_PATH} fill="none" stroke="#FDA4AF" strokeDasharray="2 5" strokeWidth={1.4} />

      {animated && (
        <>
          {[0, 1].map((lane) => (
            <circle fill="#34D399" key={`survive-${lane}`} r={3}>
              <animateMotion begin={`${lane * 1.6}s`} dur="2.2s" path={SURVIVE_PATH} repeatCount="indefinite" />
            </circle>
          ))}
          {[0, 1, 2, 3].map((lane) => (
            <circle fill="#FB7185" key={`reject-${lane}`} r={2.4}>
              <animateMotion begin={`${lane * 0.9}s`} dur="3.6s" path={REJECT_PATH} repeatCount="indefinite" />
            </circle>
          ))}
        </>
      )}

      <Caption color="#C2410C" x={760} y={150}>EL EMBUDO · LA MAYORÍA NO SOBREVIVE</Caption>
      <Caption color="#BE123C" x={790} y={498}>filtrado</Caption>
    </g>
  );
}

function RiskGate() {
  const tags = ["Kelly sizing", "Circuit breaker", "Preflight 2 piernas"];
  return (
    <g>
      <rect fill="#FFF7ED" height={140} rx={12} stroke="#FDBA74" strokeWidth={1.5} width={60} x={FUNNEL_NECK_X} y={MIND_Y - 70} />
      <Caption color="#9A3412" x={FUNNEL_NECK_X + 30} y={MIND_Y - 78}>PUERTA DE RIESGO</Caption>
      {tags.map((tag, index) => (
        <text fill="#B45309" fontFamily="ui-monospace, monospace" fontSize={8.5} fontWeight={700} key={tag} textAnchor="middle" x={FUNNEL_NECK_X + 30} y={MIND_Y - 20 + index * 22}>
          {tag}
        </text>
      ))}
    </g>
  );
}

const LEDGER_STATES = ["DETECTED", "VALIDATED", "LEG A", "LEG B", "RECONCILED"];

function ExecutionLedger({ animated }: { animated: boolean }) {
  const startX = FUNNEL_NECK_X + 85;
  const gap = 48;
  return (
    <g>
      <line stroke="#5EEAD4" strokeWidth={1.5} x1={startX} x2={startX + gap * (LEDGER_STATES.length - 1)} y1={MIND_Y} y2={MIND_Y} />
      {LEDGER_STATES.map((state, index) => {
        const x = startX + index * gap;
        const isLast = index === LEDGER_STATES.length - 1;
        return (
          <g key={state}>
            <circle cx={x} cy={MIND_Y} fill={isLast ? "#0D9488" : "#99F6E4"} r={isLast ? 6 : 4} stroke="#0D9488" strokeWidth={isLast ? 0 : 1.4} />
            <text fill="#0F766E" fontFamily="ui-monospace, monospace" fontSize={8} fontWeight={800} textAnchor="middle" x={x} y={MIND_Y - 14}>
              {state}
            </text>
          </g>
        );
      })}
      {animated && (
        <circle fill="#0D9488" r={3}>
          <animateMotion dur="2.6s" path={`M ${startX} ${MIND_Y} L ${startX + gap * (LEDGER_STATES.length - 1)} ${MIND_Y}`} repeatCount="indefinite" />
        </circle>
      )}
      <Caption color="#0D9488" x={startX + gap * 2} y={MIND_Y + 34}>LEDGER DE EJECUCIÓN</Caption>
    </g>
  );
}

function LearningRiver({ animated }: { animated: boolean }) {
  const path = "M 1097 320 Q 1040 430 900 500 Q 700 560 500 555 Q 380 552 460 400";
  return (
    <g>
      <path d={path} fill="none" stroke="url(#riverGradient)" strokeDasharray="3 7" strokeWidth={1.8} />
      {animated && (
        <>
          <circle fill="#A78BFA" r={3}>
            <animateMotion dur="5.4s" keyPoints="1;0" keyTimes="0;1" path={path} repeatCount="indefinite" />
          </circle>
          <circle fill="#F472B6" r={2.4}>
            <animateMotion begin="2.4s" dur="5.4s" keyPoints="1;0" keyTimes="0;1" path={path} repeatCount="indefinite" />
          </circle>
        </>
      )}
      <Caption color="#7C3AED" x={780} y={575}>SHADOW LEARNING · RECALIBRA EL EDGE TENSOR CON CADA RESULTADO</Caption>
    </g>
  );
}
