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

// Every distinct node colour, so we can pre-declare one glossy "bead" radial
// gradient and one soft glow per colour instead of inlining fills.
const PALETTE = [SKY, CYAN, INDIGO, EMERALD, AMBER, ROSE];
function colorId(hex: string): string {
  return hex.replace("#", "");
}

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
        <filter height="320%" id="pulseGlow" width="320%" x="-110%" y="-110%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id="auraBlur" x="-60%" y="-60%" height="220%" width="220%">
          <feGaussianBlur stdDeviation="60" />
        </filter>
        {/* Soft column-to-column colour transition: signal edges flow from the
            source layer's colour into the next layer's, left to right. */}
        {LAYERS.slice(0, -1).map((layer, i) => (
          <linearGradient gradientUnits="userSpaceOnUse" id={`edge-${i}`} key={i} x1={COL_X[i]} x2={COL_X[i + 1]} y1="0" y2="0">
            <stop offset="0%" stopColor={layer.color} />
            <stop offset="100%" stopColor={LAYERS[i + 1].color} />
          </linearGradient>
        ))}
        {/* Glossy bead: a light specular highlight up-left fading into the node
            colour, so nodes read as lit glass rather than flat discs. */}
        {PALETTE.map((color) => (
          <radialGradient cx="35%" cy="30%" id={`bead-${colorId(color)}`} key={color} r="75%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.92} />
            <stop offset="42%" stopColor={color} stopOpacity={0.98} />
            <stop offset="100%" stopColor={color} stopOpacity={1} />
          </radialGradient>
        ))}
      </defs>

      {/* Colour depth behind the network -- three soft drifting auras tracing the
          pipeline's palette so the card reads as a lit space. Reduced-motion safe. */}
      <g opacity={0.18}>
        <circle cx={360} cy={250} fill={SKY} filter="url(#auraBlur)" r={165}>
          {animated && <animate attributeName="cy" dur="13s" repeatCount="indefinite" values="250;325;250" />}
        </circle>
        <circle cx={720} cy={430} fill={INDIGO} filter="url(#auraBlur)" r={175}>
          {animated && <animate attributeName="cy" dur="17s" repeatCount="indefinite" values="430;355;430" />}
        </circle>
        <circle cx={1050} cy={300} fill={EMERALD} filter="url(#auraBlur)" r={150}>
          {animated && <animate attributeName="cy" dur="15s" repeatCount="indefinite" values="300;370;300" />}
        </circle>
      </g>

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
              animated={animated}
              focal={node.label === "Ejecutar" || node.label === "Descartar"}
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

  const edges: Array<{ x1: number; y1: number; x2: number; y2: number; fromIdx: number; toIdx: number; weight: number }> = [];
  from.nodes.forEach((_, i) => {
    to.nodes.forEach((__, j) => {
      edges.push({
        x1: fromX,
        y1: nodeY(from.nodes.length, i),
        x2: toX,
        y2: nodeY(to.nodes.length, j),
        fromIdx: i,
        toIdx: j,
        weight: hash(i, j + layerIndex * 11)
      });
    });
  });

  // Send signal pulses down the three heaviest-weight edges of each layer, staggered
  // in time. Bounded per layer (not one-per-edge) so total concurrent SMIL stays
  // modest and the animation reads as deliberate signal flow, not noise.
  const pulseEdges = animated
    ? [...edges].sort((a, b) => b.weight - a.weight).slice(0, 3)
    : [];

  return (
    <g>
      {edges.map((edge, i) => {
        const touchesHover =
          hovered && ((hovered.layer === layerIndex && hovered.index === edge.fromIdx) || (hovered.layer === layerIndex + 1 && hovered.index === edge.toIdx));
        const dimmed = hovered && !touchesHover;
        const baseOpacity = 0.1 + edge.weight * 0.24;
        return (
          <line
            key={i}
            opacity={dimmed ? 0.035 : touchesHover ? 0.9 : baseOpacity}
            stroke={touchesHover ? to.color : `url(#edge-${layerIndex})`}
            strokeWidth={touchesHover ? 2.4 : 1}
            style={{ transition: "opacity 160ms ease, stroke-width 160ms ease" }}
            x1={edge.x1}
            x2={edge.x2}
            y1={edge.y1}
            y2={edge.y2}
          />
        );
      })}
      {pulseEdges.map((edge, i) => {
        const path = `M ${edge.x1} ${edge.y1} L ${edge.x2} ${edge.y2}`;
        return (
          // One animateMotion carries the whole spark (soft coloured halo + bright
          // white core) down the wire -- a signal travelling the network.
          <g key={`pulse-${i}`} opacity={hovered ? 0.35 : 1}>
            <animateMotion begin={`${i * 0.9 + layerIndex * 0.25}s`} dur="2.6s" keyPoints="0;1;1" keyTimes="0;0.82;1" path={path} repeatCount="indefinite" />
            <circle fill={to.color} filter="url(#pulseGlow)" r={7} />
            <circle fill="#ffffff" r={2.8} />
          </g>
        );
      })}
    </g>
  );
}

function Node({
  animated,
  focal,
  hovered,
  labelSide,
  node,
  onHover,
  x,
  y
}: {
  animated: boolean;
  focal: boolean;
  hovered: boolean;
  labelSide: Layer["labelSide"];
  node: NetNode;
  onHover: (state: boolean) => void;
  x: number;
  y: number;
}) {
  const r = focal ? 21 : 15;
  const labelX = labelSide === "left" ? x - r - 11 : labelSide === "right" ? x + r + 11 : x;
  const labelY = labelSide === "below" ? y + r + 20 : y + 5;
  const anchor = labelSide === "left" ? "end" : labelSide === "right" ? "start" : "middle";

  return (
    <g
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{ cursor: node.label ? "pointer" : "default" }}
    >
      {/* Always-on soft glow so every node reads as lit; hover intensifies it.
          The two decision nodes breathe gently as the focal points of the graph. */}
      <circle cx={x} cy={y} fill={node.color} filter="url(#softBlur)" opacity={hovered ? 0.55 : focal ? 0.32 : 0.2} r={hovered ? r + 14 : r + 6}>
        {animated && focal && !hovered && <animate attributeName="opacity" dur="2.4s" repeatCount="indefinite" values="0.22;0.5;0.22" />}
      </circle>
      <circle
        cx={x}
        cy={y}
        fill={`url(#bead-${colorId(node.color)})`}
        opacity={hovered ? 1 : 0.96}
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
