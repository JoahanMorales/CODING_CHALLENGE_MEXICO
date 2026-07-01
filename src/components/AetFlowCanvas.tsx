"use client";

import { useEffect, useRef } from "react";

const venues = [
  { label: "BIN", hue: 199 },
  { label: "KRK", hue: 213 },
  { label: "CB", hue: 221 },
  { label: "OKX", hue: 229 },
  { label: "BYB", hue: 192 },
  { label: "BFX", hue: 206 },
  { label: "GATE", hue: 237 }
];

export function AetFlowCanvas({ detailed = false }: { detailed?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let animationFrame = 0;
    let visible = true;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(rect.width * scale) || canvas.height !== Math.round(rect.height * scale)) {
        canvas.width = Math.round(rect.width * scale);
        canvas.height = Math.round(rect.height * scale);
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      drawFlow(context, rect.width, rect.height, frame, detailed);
      frame += reduceMotion ? 0 : 1;
      if (!reduceMotion && visible) animationFrame = window.requestAnimationFrame(draw);
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      window.cancelAnimationFrame(animationFrame);
      if (visible) draw();
    });
    const resizeObserver = new ResizeObserver(() => {
      if (reduceMotion && visible) draw();
    });
    observer.observe(canvas);
    resizeObserver.observe(canvas);
    draw();
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, [detailed]);

  return <canvas aria-label="ArbitrAI Edge Tensor flow" className="h-full w-full" ref={canvasRef} />;
}

interface Stage {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawFlow(context: CanvasRenderingContext2D, width: number, height: number, frame: number, detailed: boolean): void {
  const compact = width < 620;
  const s = compact ? 0.74 : 1;
  const feedX = width * 0.04;
  const normalizeX = width * 0.235;
  const tensorX = width * 0.435;
  const preflightX = width * 0.645;
  const queueX = width * 0.825;
  const echoX = width * 0.95;
  const centerY = detailed ? height * 0.4 : height * 0.5;
  const riverY = centerY + Math.round((compact ? 46 : 62) * s);
  const top = detailed ? 28 : height * 0.14;
  const bottom = detailed ? height - 118 : height * 0.86;

  drawGrid(context, width, height);

  const stageH = Math.round(52 * s);
  const stageR = Math.round(13 * s);
  const breathe = (phase: number) => 1 + Math.sin(frame * 0.018 + phase) * 0.018;

  const normalize: Stage = { x: normalizeX, y: centerY, w: Math.round(92 * s * breathe(0)), h: stageH };
  const tensor: Stage = { x: tensorX, y: centerY, w: Math.round(108 * s * breathe(1.1)), h: stageH + 9 };
  const preflight: Stage = { x: preflightX, y: centerY, w: Math.round(90 * s * breathe(2.2)), h: stageH };
  const queue: Stage = { x: queueX, y: centerY, w: Math.round(78 * s * breathe(3.3)), h: stageH - 4 };

  drawVenueFeeds(context, feedX, normalizeX, centerY, top, bottom, normalize.w, frame, compact);

  drawCurvedConnector(context, normalize, tensor, "#7DD3FC");
  drawCurvedConnector(context, tensor, preflight, "#6EE7B7");
  drawCurvedConnector(context, preflight, queue, "#FDBA74");

  drawGatedParticles(context, normalize, tensor, frame, 0, 3, 1, "#38BDF8", riverY);
  drawGatedParticles(context, tensor, preflight, frame, 0.2, 3, 0, "#34D399", riverY);
  drawGatedParticles(context, preflight, queue, frame, 0.45, 5, 0, "#FB923C", riverY);

  drawFeedbackRiver(context, queue.x, tensor.x, riverY, frame, compact);
  drawExecutionEcho(context, queue, echoX, centerY, frame, compact);

  drawStage(context, normalize, stageR, "#F0F9FF", "#38BDF8", "NORMALIZA", "7 venues", frame, s);
  drawStage(context, tensor, stageR, "#ECFDF5", "#34D399", "EDGE TENSOR", survivalLabel(frame), frame, s);
  drawMlBadge(context, tensor, frame, compact, s);
  drawStage(context, preflight, stageR, "#FFF7ED", "#FB923C", "PREFLIGHT", "2 piernas", frame, s);
  drawStage(context, queue, stageR, "#EEF2FF", "#818CF8", "COLA EV", "por score", frame, s);

  if (detailed) drawFeatureChips(context, width, height, compact);
}

function survivalLabel(frame: number): string {
  const wobble = Math.sin(frame * 0.013) * 5.2 + Math.sin(frame * 0.031) * 1.8;
  return `${(71 + wobble).toFixed(0)}% surv.`;
}

function drawVenueFeeds(
  context: CanvasRenderingContext2D,
  feedX: number,
  lineEndX: number,
  centerY: number,
  top: number,
  bottom: number,
  gatherWidth: number,
  frame: number,
  compact: boolean
): void {
  const convergeX = lineEndX - Math.round(46 * (compact ? 0.74 : 1)) - gatherWidth * 0.1;
  venues.forEach((venue, index) => {
    const y = top + (index * (bottom - top)) / (venues.length - 1);
    const hue = venue.hue;

    const gradient = context.createLinearGradient(feedX + 12, y, convergeX, centerY);
    gradient.addColorStop(0, `hsla(${hue}, 75%, 56%, 0.32)`);
    gradient.addColorStop(1, `hsla(${hue + 18}, 75%, 60%, 0.1)`);
    context.strokeStyle = gradient;
    context.lineWidth = 1.4;
    context.beginPath();
    context.moveTo(feedX + 12, y);
    context.quadraticCurveTo((feedX + convergeX) / 2, y, convergeX, centerY);
    context.stroke();

    const glowRadius = 5 + Math.sin(frame * 0.045 + index * 1.3) * 1.4;
    context.fillStyle = `hsla(${hue}, 75%, 56%, 0.14)`;
    context.beginPath();
    context.arc(feedX + 12, y, glowRadius + 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = `hsla(${hue}, 75%, 52%, 1)`;
    context.beginPath();
    context.arc(feedX + 12, y, 3.6, 0, Math.PI * 2);
    context.fill();

    if (!compact || index % 2 === 0) {
      context.fillStyle = `hsla(${hue}, 55%, 32%, 1)`;
      context.font = `800 ${compact ? 7 : 9}px ui-monospace, monospace`;
      context.fillText(venue.label, feedX + 22, y + 3);
    }

    const speed = 0.0044 + index * 0.00045;
    for (let echo = 0; echo < 3; echo += 1) {
      const progress = (frame * speed + index * 0.16 - echo * 0.045 + 1) % 1;
      const t = bezierEase(progress);
      const px = feedX + 12 + (convergeX - (feedX + 12)) * t;
      const curveLift = (1 - t) * (y - centerY) * (1 - t);
      const py = y + (centerY - y) * t + curveLift * 0;
      const alpha = (1 - echo * 0.32) * Math.sin(progress * Math.PI) * 0.85;
      if (alpha <= 0) continue;
      context.fillStyle = `hsla(${hue}, 85%, 68%, ${alpha})`;
      context.beginPath();
      context.arc(px, py, 2.6 - echo * 0.6, 0, Math.PI * 2);
      context.fill();
    }
  });
}

function bezierEase(t: number): number {
  return t * t * (3 - 2 * t);
}

function drawCurvedConnector(context: CanvasRenderingContext2D, from: Stage, to: Stage, color: string): void {
  const startX = from.x + from.w / 2;
  const endX = to.x - to.w / 2;
  context.strokeStyle = color;
  context.globalAlpha = 0.45;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(startX, from.y);
  context.bezierCurveTo((startX + endX) / 2, from.y, (startX + endX) / 2, to.y, endX, to.y);
  context.stroke();
  context.globalAlpha = 1;

  const angle = Math.atan2(to.y - from.y, endX - startX);
  const headLen = 7;
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(endX, to.y);
  context.lineTo(endX - headLen * Math.cos(angle - 0.4), to.y - headLen * Math.sin(angle - 0.4));
  context.lineTo(endX - headLen * Math.cos(angle + 0.4), to.y - headLen * Math.sin(angle + 0.4));
  context.closePath();
  context.fill();
}

function curvePoint(from: Stage, to: Stage, t: number): { x: number; y: number } {
  const startX = from.x + from.w / 2;
  const endX = to.x - to.w / 2;
  const cx = (startX + endX) / 2;
  const x = (1 - t) ** 3 * startX + 3 * (1 - t) ** 2 * t * cx + 3 * (1 - t) * t ** 2 * cx + t ** 3 * endX;
  const y = (1 - t) ** 3 * from.y + 3 * (1 - t) ** 2 * t * from.y + 3 * (1 - t) * t ** 2 * to.y + t ** 3 * to.y;
  return { x, y };
}

// Each lane is a deterministic, repeating "candidate opportunity" traveling this
// segment of the pipeline. rejectEvery > 0 means one out of every N lane cycles
// peels off toward the shadow-learning river instead of reaching the next stage —
// a visible stand-in for AET/ML/preflight actually filtering most raw spreads out.
function drawGatedParticles(
  context: CanvasRenderingContext2D,
  from: Stage,
  to: Stage,
  frame: number,
  phaseOffset: number,
  rejectEvery: number,
  rejectRemainder: number,
  color: string,
  riverY: number
): void {
  const lanes = 3;
  for (let lane = 0; lane < lanes; lane += 1) {
    const speed = 0.0062;
    const raw = frame * speed + phaseOffset + lane / lanes;
    const cycle = Math.floor(raw);
    const t = raw - cycle;
    const rejected = rejectEvery > 0 && Math.abs(cycle * 7 + lane * 3) % rejectEvery === rejectRemainder;

    if (!rejected) {
      const point = curvePoint(from, to, t);
      const alpha = Math.sin(t * Math.PI) * 0.9 + 0.1;
      context.fillStyle = withAlpha(color, alpha);
      context.beginPath();
      context.arc(point.x, point.y, 2.8, 0, Math.PI * 2);
      context.fill();
      continue;
    }

    if (t < 0.42) {
      const point = curvePoint(from, to, t);
      const alpha = (1 - t / 0.42) * 0.9 + 0.1;
      context.fillStyle = withAlpha(color, alpha);
      context.beginPath();
      context.arc(point.x, point.y, 2.8, 0, Math.PI * 2);
      context.fill();
      continue;
    }

    const fallT = (t - 0.42) / 0.58;
    const gatePoint = curvePoint(from, to, 0.42);
    const fx = gatePoint.x + (from.x - gatePoint.x) * 0.18 * fallT;
    const fy = gatePoint.y + (riverY - gatePoint.y) * easeOutCubic(fallT);
    const alpha = (1 - fallT) * 0.75;
    if (alpha <= 0.02) continue;
    context.fillStyle = `rgba(244, 114, 182, ${alpha})`;
    context.beginPath();
    context.arc(fx, fy, 2.2 - fallT * 0.8, 0, Math.PI * 2);
    context.fill();
  }
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function withAlpha(hexOrRgb: string, alpha: number): string {
  if (hexOrRgb.startsWith("#")) {
    const r = parseInt(hexOrRgb.slice(1, 3), 16);
    const g = parseInt(hexOrRgb.slice(3, 5), 16);
    const b = parseInt(hexOrRgb.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hexOrRgb;
}

function drawFeedbackRiver(context: CanvasRenderingContext2D, queueX: number, tensorX: number, riverY: number, frame: number, compact: boolean): void {
  context.strokeStyle = "rgba(167,139,250,0.28)";
  context.lineWidth = 1.2;
  context.setLineDash([3, 6]);
  context.lineDashOffset = -(frame * 0.18) % 9;
  context.beginPath();
  context.moveTo(queueX, riverY);
  context.lineTo(tensorX, riverY);
  context.stroke();
  context.setLineDash([]);
  context.lineDashOffset = 0;

  if (!compact) {
    context.fillStyle = "rgba(124,58,237,0.55)";
    context.font = "700 7px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText("shadow learning recalibra AET", (queueX + tensorX) / 2, riverY + 13);
    context.textAlign = "start";
  }
}

function drawMlBadge(context: CanvasRenderingContext2D, tensor: Stage, frame: number, compact: boolean, s: number): void {
  const pulse = 0.55 + Math.sin(frame * 0.05) * 0.25;
  const label = compact ? "+ ML" : "+ ML ensemble · veto";
  context.font = `800 ${compact ? 6.5 : 7.5}px ui-monospace, monospace`;
  const padX = Math.round(7 * s);
  const textWidth = context.measureText(label).width;
  const pillW = textWidth + padX * 2;
  const pillH = Math.round(15 * s);
  const x = tensor.x - pillW / 2;
  const y = tensor.y + tensor.h / 2 + Math.round(7 * s);

  context.fillStyle = `rgba(139,92,246,${0.1 + pulse * 0.08})`;
  context.strokeStyle = `rgba(139,92,246,${0.4 + pulse * 0.3})`;
  context.lineWidth = 1;
  roundedRect(context, x, y, pillW, pillH, pillH / 2);
  context.fill();
  context.stroke();

  context.fillStyle = "#6D28D9";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, x + pillW / 2, y + pillH / 2 + 0.5);
  context.textAlign = "start";
  context.textBaseline = "alphabetic";
}

function drawExecutionEcho(context: CanvasRenderingContext2D, queue: Stage, echoX: number, centerY: number, frame: number, compact: boolean): void {
  const startX = queue.x + queue.w / 2;
  context.strokeStyle = "rgba(20,184,166,0.4)";
  context.lineWidth = 1.6;
  context.beginPath();
  context.moveTo(startX, centerY);
  context.lineTo(echoX, centerY);
  context.stroke();

  const cycle = 90;
  const t = (frame % cycle) / cycle;
  if (t < 0.7) {
    const ringT = t / 0.7;
    const radius = 2 + ringT * 9;
    context.strokeStyle = `rgba(20,184,166,${(1 - ringT) * 0.8})`;
    context.lineWidth = 1.4;
    context.beginPath();
    context.arc(echoX, centerY, radius, 0, Math.PI * 2);
    context.stroke();
  }

  context.fillStyle = "#0D9488";
  context.beginPath();
  context.arc(echoX, centerY, 3, 0, Math.PI * 2);
  context.fill();

  if (!compact) {
    context.fillStyle = "rgba(13,148,136,0.85)";
    context.font = "700 7px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText("ejecutado", echoX, centerY + 16);
    context.textAlign = "start";
  }
}

function drawGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.strokeStyle = "rgba(186,230,253,0.18)";
  context.lineWidth = 1;
  for (let x = 0; x < width; x += 40) {
    drawLine(context, x, 0, x, height, context.strokeStyle);
  }
  for (let y = 0; y < height; y += 40) {
    drawLine(context, 0, y, width, y, context.strokeStyle);
  }
}

function drawStage(
  context: CanvasRenderingContext2D,
  stage: Stage,
  r: number,
  fill: string,
  stroke: string,
  title: string,
  value: string,
  frame: number,
  s: number
): void {
  const { x, y, w, h } = stage;

  const glow = context.createRadialGradient(x, y, 0, x, y, w * 0.72);
  glow.addColorStop(0, withAlpha(stroke, 0.14));
  glow.addColorStop(1, withAlpha(stroke, 0));
  context.fillStyle = glow;
  context.beginPath();
  context.arc(x, y, w * 0.72, 0, Math.PI * 2);
  context.fill();

  context.save();
  context.shadowColor = withAlpha(stroke, 0.22);
  context.shadowBlur = 14;
  context.shadowOffsetY = 4;
  context.fillStyle = fill;
  roundedRect(context, x - w / 2, y - h / 2, w, h, r);
  context.fill();
  context.restore();

  context.strokeStyle = stroke;
  context.lineWidth = 1.5;
  roundedRect(context, x - w / 2, y - h / 2, w, h, r);
  context.stroke();

  context.textAlign = "center";
  context.fillStyle = "#0F172A";
  context.font = `900 ${Math.round(w * 0.108)}px ui-sans-serif, system-ui`;
  context.fillText(title, x, y - 3);

  context.fillStyle = "#0369A1";
  context.font = `800 ${Math.round(w * 0.088)}px ui-monospace, monospace`;
  context.fillText(value, x, y + 14);
  context.textAlign = "start";
  void frame;
  void s;
}

function drawFeatureChips(context: CanvasRenderingContext2D, width: number, height: number, compact: boolean): void {
  const labels: Array<[string, string, string]> = compact
    ? [["MLOFI", "#E0F2FE", "#075985"], ["ML", "#EDE9FE", "#5B21B6"], ["RIESGO", "#FFE4E6", "#BE123C"]]
    : [
        ["MLOFI TOP-5", "#E0F2FE", "#075985"],
        ["MICROPRICE", "#E0F2FE", "#075985"],
        ["ML ENSEMBLE", "#EDE9FE", "#5B21B6"],
        ["COSTOS", "#FEF3C7", "#92400E"],
        ["LATENCIA", "#FEF3C7", "#92400E"],
        ["RIESGO", "#FFE4E6", "#BE123C"]
      ];
  const gap = compact ? 6 : 8;
  const boxWidth = compact ? 58 : 76;
  const totalWidth = labels.length * boxWidth + (labels.length - 1) * gap;
  const startX = Math.max(10, (width - totalWidth) / 2);
  labels.forEach(([label, fill, text], index) => {
    const x = startX + index * (boxWidth + gap);
    const y = height - 50;
    context.fillStyle = fill;
    context.strokeStyle = text;
    roundedRect(context, x, y, boxWidth, 24, 7);
    context.fill();
    context.globalAlpha = 0.34;
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = text;
    context.font = `800 ${compact ? 6.5 : 7.5}px ui-monospace, monospace`;
    context.textAlign = "center";
    context.fillText(label, x + boxWidth / 2, y + 15);
  });
  context.textAlign = "start";
}

function drawLine(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, lineWidth = 1): void {
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}
