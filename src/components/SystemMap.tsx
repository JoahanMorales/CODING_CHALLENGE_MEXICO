"use client";

import { useEffect, useState } from "react";
import { EXCHANGE_IDS, EXCHANGE_LABELS } from "@/lib/config/exchanges";

const CORE_X = 560;
const CORE_Y = 290;
const CORE_R = 128;
const EXEC_X = 1000;
const EXEC_Y = 290;
const CLUSTER_X = 168;
const CLUSTER_Y = 290;

export function SystemMap({ compact = false }: { compact?: boolean }) {
  const [animated, setAnimated] = useState(true);

  useEffect(() => {
    setAnimated(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  return (
    <svg
      aria-label="Mapa del sistema ArbitrAI: mercados en vivo, el Edge Tensor filtrando oportunidades, ejecución validada y aprendizaje continuo"
      className="h-full w-full"
      preserveAspectRatio={compact ? "xMidYMid meet" : "xMidYMid slice"}
      viewBox="0 0 1160 680"
    >
      <defs>
        <filter height="300%" id="softGlow" width="300%" x="-100%" y="-100%">
          <feGaussianBlur stdDeviation="20" />
        </filter>
        <radialGradient id="coreFill" cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#ECFDF5" />
          <stop offset="55%" stopColor="#D1FAE5" />
          <stop offset="100%" stopColor="#A7F3D0" />
        </radialGradient>
        <linearGradient id="wingFill" x1="0%" x2="100%">
          <stop offset="0%" stopColor="#34D399" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#2DD4BF" stopOpacity="0.16" />
        </linearGradient>
        <linearGradient id="inflowStroke" x1="0%" x2="100%">
          <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#34D399" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id="loopStroke" x1="0%" x2="100%">
          <stop offset="0%" stopColor="#2DD4BF" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#A78BFA" stopOpacity="0.6" />
        </linearGradient>
      </defs>

      <BackgroundBloom />
      <InflowRibbon animated={animated} />
      <Cluster animated={animated} />
      <Core />
      <FlowWing animated={animated} />
      <Execution />
      <LearningLoop animated={animated} />
    </svg>
  );
}

function BackgroundBloom() {
  return (
    <g filter="url(#softGlow)" opacity={0.55}>
      <circle cx={190} cy={140} fill="#BAE6FD" r={140} />
      <circle cx={980} cy={560} fill="#DDD6FE" r={170} />
      <circle cx={520} cy={600} fill="#A7F3D0" r={150} />
    </g>
  );
}

function Cluster({ animated }: { animated: boolean }) {
  const ringDots = 6;
  const dotR = 46;
  const names = EXCHANGE_IDS.map((id) => EXCHANGE_LABELS[id]).join(" · ");
  return (
    <g>
      <circle cx={CLUSTER_X} cy={CLUSTER_Y} fill="#38BDF8" opacity={0.08} r={92} />
      <circle className={animated ? "live-dot" : undefined} cx={CLUSTER_X} cy={CLUSTER_Y} fill="#0284C7" r={9} />
      {Array.from({ length: ringDots }, (_, index) => {
        const angle = (index / ringDots) * Math.PI * 2;
        const x = CLUSTER_X + dotR * Math.cos(angle);
        const y = CLUSTER_Y + dotR * Math.sin(angle);
        return <circle cx={x} cy={y} fill="#0EA5E9" key={index} r={5.5} style={{ animation: animated ? `live-pulse 1.8s ease-in-out ${index * 0.22}s infinite` : undefined }} />;
      })}
      <text fill="#0C4A6E" fontFamily="ui-sans-serif, system-ui" fontSize={17} fontWeight={800} textAnchor="middle" x={CLUSTER_X} y={CLUSTER_Y + 128}>
        7 mercados en vivo
      </text>
      <text fill="#64748B" fontFamily="ui-sans-serif, system-ui" fontSize={11} fontWeight={600} textAnchor="middle" x={CLUSTER_X} y={CLUSTER_Y + 148}>
        {names}
      </text>
    </g>
  );
}

function InflowRibbon({ animated }: { animated: boolean }) {
  const path = `M ${CLUSTER_X + 92} ${CLUSTER_Y} C ${CLUSTER_X + 220} ${CLUSTER_Y}, ${CORE_X - 220} ${CORE_Y}, ${CORE_X - CORE_R + 6} ${CORE_Y}`;
  return (
    <g>
      <path d={path} fill="none" stroke="url(#inflowStroke)" strokeLinecap="round" strokeWidth={10} />
      {animated && (
        <>
          <circle fill="#F0F9FF" r={5}>
            <animateMotion dur="3.2s" path={path} repeatCount="indefinite" />
          </circle>
          <circle fill="#ECFDF5" r={4}>
            <animateMotion begin="1.6s" dur="3.2s" path={path} repeatCount="indefinite" />
          </circle>
        </>
      )}
    </g>
  );
}

function Core() {
  return (
    <g>
      <circle cx={CORE_X} cy={CORE_Y} fill="#34D399" filter="url(#softGlow)" opacity={0.25} r={CORE_R + 30} />
      <circle cx={CORE_X} cy={CORE_Y} fill="url(#coreFill)" r={CORE_R} stroke="#10B981" strokeWidth={2} />
      <circle cx={CORE_X} cy={CORE_Y} fill="none" r={CORE_R - 16} stroke="#6EE7B7" strokeDasharray="1 9" strokeWidth={1.5} />

      <text fill="#064E3B" fontFamily="ui-sans-serif, system-ui" fontSize={30} fontWeight={900} textAnchor="middle" x={CORE_X} y={CORE_Y - 8}>
        Edge Tensor
      </text>
      <text fill="#047857" fontFamily="ui-sans-serif, system-ui" fontSize={13} fontWeight={700} letterSpacing="0.01em" textAnchor="middle" x={CORE_X} y={CORE_Y + 16}>
        AET · segunda opinión de un ensemble ML
      </text>

      <RoundedTag color="#0369A1" fillColor="#E0F2FE" text="MLOFI · microprice · profundidad · latencia" x={CORE_X} y={CORE_Y + 48} />
      <RoundedTag color="#6D28D9" fillColor="#F5F3FF" text="Cross-Exchange · Triangular · Stat-Arb · Latencia" x={CORE_X} y={CORE_Y + 76} />
    </g>
  );
}

function RoundedTag({ color, fillColor, text, x, y }: { color: string; fillColor: string; text: string; x: number; y: number }) {
  const width = text.length * 5.6 + 28;
  return (
    <g>
      <rect fill={fillColor} height={22} rx={11} width={width} x={x - width / 2} y={y - 15} />
      <text fill={color} fontFamily="ui-monospace, monospace" fontSize={10.5} fontWeight={700} textAnchor="middle" x={x} y={y + 1}>
        {text}
      </text>
    </g>
  );
}

function FlowWing({ animated }: { animated: boolean }) {
  const wing = `M ${CORE_X + 96} ${CORE_Y - 58} C ${CORE_X + 260} ${CORE_Y - 86}, ${EXEC_X - 150} ${EXEC_Y - 34}, ${EXEC_X - 54} ${EXEC_Y - 10}
                L ${EXEC_X - 54} ${EXEC_Y + 10} C ${EXEC_X - 150} ${EXEC_Y + 34}, ${CORE_X + 260} ${CORE_Y + 86}, ${CORE_X + 96} ${CORE_Y + 58} Z`;
  const spine = `M ${CORE_X + 110} ${CORE_Y} C ${CORE_X + 300} ${CORE_Y}, ${EXEC_X - 220} ${EXEC_Y}, ${EXEC_X - 50} ${EXEC_Y}`;
  const discard = `M ${CORE_X + 210} ${CORE_Y + 44} Q ${CORE_X + 270} ${CORE_Y + 110} ${CORE_X + 190} ${CORE_Y + 148}`;
  return (
    <g>
      <path d={wing} fill="url(#wingFill)" />
      <path d={discard} fill="none" stroke="#FDA4AF" strokeLinecap="round" strokeWidth={3} />
      <circle cx={CORE_X + 186} cy={CORE_Y + 156} fill="#FFF1F2" r={13} stroke="#FB7185" strokeWidth={1.75} />
      <text fill="#E11D48" fontFamily="ui-sans-serif, system-ui" fontSize={16} fontWeight={800} textAnchor="middle" x={CORE_X + 186} y={CORE_Y + 161}>
        –
      </text>
      <text fill="#9F1239" fontFamily="ui-sans-serif, system-ui" fontSize={12} fontWeight={700} textAnchor="middle" x={CORE_X + 186} y={CORE_Y + 184}>
        se descarta
      </text>

      {animated && (
        <circle fill="#10B981" r={4.5}>
          <animateMotion dur="2.8s" path={spine} repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
}

function Execution() {
  return (
    <g>
      <circle cx={EXEC_X} cy={EXEC_Y} fill="#F0FDFA" r={58} stroke="#14B8A6" strokeWidth={2} />
      <path d={`M ${EXEC_X - 20} ${EXEC_Y} l 13 13 l 26 -28`} fill="none" stroke="#0D9488" strokeLinecap="round" strokeLinejoin="round" strokeWidth={5} />
      <text fill="#115E59" fontFamily="ui-sans-serif, system-ui" fontSize={15} fontWeight={800} textAnchor="middle" x={EXEC_X} y={EXEC_Y + 82}>
        Ejecución validada
      </text>
      <text fill="#64748B" fontFamily="ui-sans-serif, system-ui" fontSize={11} fontWeight={600} textAnchor="middle" x={EXEC_X} y={EXEC_Y + 100}>
        preflight · Kelly sizing · circuit breaker
      </text>
    </g>
  );
}

function LearningLoop({ animated }: { animated: boolean }) {
  const path = `M ${EXEC_X - 20} ${EXEC_Y + 58} C ${EXEC_X - 60} ${EXEC_Y + 260}, ${CORE_X + 140} ${CORE_Y + 340}, ${CORE_X - 20} ${CORE_Y + 300} S ${CORE_X - 90} ${CORE_Y + 80} ${CORE_X - 46} ${CORE_Y + 8}`;
  return (
    <g>
      <path d={path} fill="none" stroke="url(#loopStroke)" strokeDasharray="1 10" strokeLinecap="round" strokeWidth={3} />
      {animated && (
        <circle fill="#7C3AED" r={4}>
          <animateMotion dur="6s" keyPoints="1;0" keyTimes="0;1" path={path} repeatCount="indefinite" />
        </circle>
      )}
      <text fill="#6D28D9" fontFamily="ui-sans-serif, system-ui" fontSize={14} fontWeight={700} textAnchor="middle" x={CORE_X + 60} y={CORE_Y + 360}>
        Shadow learning: recalibra con cada resultado, gane o pierda
      </text>
    </g>
  );
}
