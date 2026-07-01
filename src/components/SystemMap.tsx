"use client";

import { useEffect, useState } from "react";
import { EXCHANGE_IDS, EXCHANGE_LABELS } from "@/lib/config/exchanges";

interface NetNode {
  label?: string;
  color: string;
}

interface Layer {
  title: string;
  subtitle?: string;
  color: string;
  nodes: NetNode[];
  labelSide: "left" | "right" | "below";
}

const SKY = "#0EA5E9";
const CYAN = "#0891B2";
const INDIGO = "#6366F1";
const EMERALD = "#10B981";
const AMBER = "#F59E0B";
const ROSE = "#F43F5E";

const LAYERS: Layer[] = [
  {
    title: "MERCADOS",
    subtitle: "order books en vivo",
    color: SKY,
    labelSide: "left",
    nodes: EXCHANGE_IDS.map((id) => ({ label: EXCHANGE_LABELS[id], color: SKY }))
  },
  {
    title: "MICROESTRUCTURA",
    subtitle: "features del order book",
    color: CYAN,
    labelSide: "below",
    nodes: ["MLOFI", "Microprice", "Profundidad", "Volatilidad", "Quote age"].map((label) => ({ label, color: CYAN }))
  },
  {
    title: "ESTRATEGIAS",
    subtitle: "4 detectores en paralelo",
    color: INDIGO,
    labelSide: "below",
    nodes: ["Cross-Exchange", "Triangular", "Stat-Arb", "Latencia"].map((label) => ({ label, color: INDIGO }))
  },
  {
    title: "ENSEMBLE ML",
    subtitle: "hasta 32 árboles · AET",
    color: EMERALD,
    labelSide: "below",
    nodes: Array.from({ length: 7 }, () => ({ color: EMERALD }))
  },
  {
    title: "RIESGO",
    subtitle: "gates antes de operar",
    color: AMBER,
    labelSide: "below",
    nodes: ["Kelly sizing", "Circuit breaker", "Preflight 2 piernas"].map((label) => ({ label, color: AMBER }))
  },
  {
    title: "DECISIÓN",
    subtitle: "traza completa por señal",
    color: EMERALD,
    labelSide: "right",
    nodes: [
      { label: "Ejecutar", color: EMERALD },
      { label: "Descartar", color: ROSE }
    ]
  }
];

const VIEW_W = 1220;
const VIEW_H = 660;
const COL_X = [140, 328, 516, 704, 892, 1080];
const ROW_CENTER = 340;
const ROW_GAP = 64;

function nodeY(count: number, index: number): number {
  return ROW_CENTER + (index - (count - 1) / 2) * ROW_GAP;
}

// Integer-only hash (no transcendental functions) so the deterministic "weight"
// per edge renders identically on the server and the client -- Math.sin's last
// bit of precision isn't guaranteed to match across Node's and the browser's V8,
// which was causing a real hydration mismatch warning here.
function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

interface HoverKey {
  layer: number;
  index: number;
}

export function SystemMap() {
  const [animated, setAnimated] = useState(true);
  const [hovered, setHovered] = useState<HoverKey | null>(null);

  useEffect(() => {
    setAnimated(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  return (
    <svg
      aria-label="Red de decisión de ArbitrAI: mercados, microestructura, estrategias, ensemble ML, riesgo y decisión final"
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
    >
      <defs>
        <filter height="240%" id="softBlur" width="240%" x="-70%" y="-70%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      {LAYERS.slice(0, -1).map((layer, layerIndex) => (
        <EdgeGroup animated={animated} hovered={hovered} key={layerIndex} layerIndex={layerIndex} />
      ))}

      {LAYERS.map((layer, layerIndex) => (
        <g key={layer.title}>
          <text
            fill={layer.color}
            fontFamily="ui-monospace, monospace"
            fontSize={17}
            fontWeight={800}
            letterSpacing="0.04em"
            textAnchor="middle"
            x={COL_X[layerIndex]}
            y={36}
          >
            {layer.title}
          </text>
          {layer.subtitle && (
            <text fill="#94A3B8" fontFamily="ui-sans-serif, system-ui" fontSize={12.5} fontWeight={600} textAnchor="middle" x={COL_X[layerIndex]} y={55}>
              {layer.subtitle}
            </text>
          )}
          {layer.nodes.map((node, nodeIndex) => (
            <Node
              hovered={hovered?.layer === layerIndex && hovered.index === nodeIndex}
              key={nodeIndex}
              labelSide={layer.labelSide}
              node={node}
              onHover={(state) => setHovered(state ? { layer: layerIndex, index: nodeIndex } : null)}
              x={COL_X[layerIndex]}
              y={nodeY(layer.nodes.length, nodeIndex)}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}

function EdgeGroup({ animated, hovered, layerIndex }: { animated: boolean; hovered: HoverKey | null; layerIndex: number }) {
  const from = LAYERS[layerIndex];
  const to = LAYERS[layerIndex + 1];
  const fromX = COL_X[layerIndex];
  const toX = COL_X[layerIndex + 1];

  const edges: Array<{ x1: number; y1: number; x2: number; y2: number; fromIdx: number; toIdx: number }> = [];
  from.nodes.forEach((_, i) => {
    to.nodes.forEach((__, j) => {
      edges.push({ x1: fromX, y1: nodeY(from.nodes.length, i), x2: toX, y2: nodeY(to.nodes.length, j), fromIdx: i, toIdx: j });
    });
  });

  // Keep this small: each pulse is one SMIL animation, and too many running at
  // once (e.g. one per edge) is enough concurrent SMIL work to keep the tab from
  // ever reaching an idle frame, which breaks headless screenshot capture.
  const activePulses = animated ? [edges[Math.floor(edges.length * 0.22)], edges[Math.floor(edges.length * 0.68)]] : [];

  return (
    <g>
      {edges.map((edge, i) => {
        const touchesHover =
          hovered && ((hovered.layer === layerIndex && hovered.index === edge.fromIdx) || (hovered.layer === layerIndex + 1 && hovered.index === edge.toIdx));
        const dimmed = hovered && !touchesHover;
        const baseOpacity = 0.08 + hash(edge.fromIdx, edge.toIdx + layerIndex * 11) * 0.22;
        return (
          <line
            key={i}
            opacity={dimmed ? 0.03 : touchesHover ? 0.85 : baseOpacity}
            stroke={touchesHover ? to.color : from.color}
            strokeWidth={touchesHover ? 2.2 : 0.9}
            style={{ transition: "opacity 160ms ease, stroke-width 160ms ease" }}
            x1={edge.x1}
            x2={edge.x2}
            y1={edge.y1}
            y2={edge.y2}
          />
        );
      })}
      {activePulses.map((edge, i) => (
        <circle fill={to.color} key={i} r={2.6}>
          <animateMotion
            begin={`${i * 1.1}s`}
            dur="2.8s"
            keyPoints="0;1;1"
            keyTimes="0;0.85;1"
            path={`M ${edge.x1} ${edge.y1} L ${edge.x2} ${edge.y2}`}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </g>
  );
}

function Node({
  hovered,
  labelSide,
  node,
  onHover,
  x,
  y
}: {
  hovered: boolean;
  labelSide: Layer["labelSide"];
  node: NetNode;
  onHover: (state: boolean) => void;
  x: number;
  y: number;
}) {
  const r = node.label === "Ejecutar" || node.label === "Descartar" ? 21 : 15;
  const labelX = labelSide === "left" ? x - r - 11 : labelSide === "right" ? x + r + 11 : x;
  const labelY = labelSide === "below" ? y + r + 20 : y + 5;
  const anchor = labelSide === "left" ? "end" : labelSide === "right" ? "start" : "middle";

  return (
    <g
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{ cursor: node.label ? "pointer" : "default" }}
    >
      {hovered && <circle cx={x} cy={y} fill={node.color} filter="url(#softBlur)" opacity={0.5} r={r + 14} />}
      <circle
        cx={x}
        cy={y}
        fill={node.color}
        opacity={hovered ? 1 : 0.88}
        r={hovered ? r + 3 : r}
        stroke="white"
        strokeWidth={1.5}
        style={{ transition: "r 160ms ease, opacity 160ms ease" }}
      />
      {node.label === "Ejecutar" && <polyline fill="none" points={`${x - 9},${y} ${x - 2},${y + 7} ${x + 10},${y - 9}`} stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.6} />}
      {node.label === "Descartar" && (
        <>
          <line stroke="white" strokeLinecap="round" strokeWidth={2.6} x1={x - 8} x2={x + 8} y1={y - 8} y2={y + 8} />
          <line stroke="white" strokeLinecap="round" strokeWidth={2.6} x1={x - 8} x2={x + 8} y1={y + 8} y2={y - 8} />
        </>
      )}
      {node.label && (
        <text
          fill={hovered ? "#0F172A" : "#334155"}
          fontFamily="ui-sans-serif, system-ui"
          fontSize={15.5}
          fontWeight={hovered ? 800 : 700}
          textAnchor={anchor}
          x={labelX}
          y={labelY}
        >
          {node.label}
        </text>
      )}
    </g>
  );
}
