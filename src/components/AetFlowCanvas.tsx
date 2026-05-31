"use client";

import { useEffect, useRef } from "react";

const venues = [
  { label: "BIN", color: "#F0B90B" },
  { label: "KRK", color: "#5841D8" },
  { label: "CB",  color: "#0052FF" },
  { label: "OKX", color: "#1A1A1A" },
  { label: "BYB", color: "#0AA9F0" },
  { label: "BFX", color: "#172D3E" },
  { label: "GATE",color: "#1F2126" }
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

function drawFlow(context: CanvasRenderingContext2D, width: number, height: number, frame: number, detailed: boolean): void {
  const compact = width < 620;
  const feedX = compact ? width * 0.04 : width * 0.04;
  const normalizeX = compact ? width * 0.26 : width * 0.24;
  const tensorX = compact ? width * 0.46 : width * 0.44;
  const preflightX = compact ? width * 0.66 : width * 0.65;
  const queueX = compact ? width * 0.85 : width * 0.85;
  const centerY = detailed ? height * 0.40 : height * 0.5;
  const top = detailed ? 28 : height * 0.14;
  const bottom = detailed ? height - 110 : height * 0.86;
  const s = compact ? 0.72 : 1;

  drawGrid(context, width, height);

  const stageH = Math.round(52 * s);
  const stageR = Math.round(12 * s);

  drawStage(context, normalizeX, centerY, Math.round(90 * s), stageH, stageR, "#F0F9FF", "#38BDF8", "NORMALIZA", "depth 5", frame * 0.3);
  drawStage(context, tensorX, centerY, Math.round(104 * s), stageH + 8, stageR, "#ECFDF5", "#34D399", "EDGE TENSOR", "72% surv.", frame * 0.5);
  drawStage(context, preflightX, centerY, Math.round(88 * s), stageH, stageR, "#FFF7ED", "#FB923C", "PREFLIGHT", "2-leg check", frame * 0.7);
  drawStage(context, queueX, centerY, Math.round(76 * s), stageH - 4, stageR, "#F5F3FF", "#A78BFA", "COLA EV", "score", frame * 0.9);

  // venue dots with connection lines
  venues.forEach((venue, index) => {
    const y = top + index * ((bottom - top) / (venues.length - 1));
    const lineEndX = normalizeX - Math.round(44 * s);
    const pulseSpeed = 0.005 + index * 0.0006;
    const hue = 200 + index * 8;

    // connection line with gradient
    const gradient = context.createLinearGradient(feedX + 12, y, lineEndX, centerY);
    gradient.addColorStop(0, `hsla(${hue}, 70%, 55%, 0.35)`);
    gradient.addColorStop(1, `hsla(${hue + 30}, 70%, 60%, 0.15)`);
    context.strokeStyle = gradient;
    context.lineWidth = 1.6;
    context.beginPath();
    context.moveTo(feedX + 12, y);
    context.lineTo(lineEndX, centerY);
    context.stroke();

    // venue dot with glow
    const glowRadius = 5 + Math.sin(frame * 0.04 + index * 1.2) * 1.5;
    context.fillStyle = `hsla(${hue}, 70%, 55%, 0.15)`;
    context.beginPath();
    context.arc(feedX + 12, y, glowRadius + 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = `hsla(${hue}, 70%, 55%, 1)`;
    context.beginPath();
    context.arc(feedX + 12, y, 4, 0, Math.PI * 2);
    context.fill();

    // label
    if (!compact || index % 2 === 0) {
      context.fillStyle = `hsla(${hue}, 60%, 30%, 1)`;
      context.font = `800 ${compact ? 7 : 9}px ui-monospace, monospace`;
      context.fillText(venue.label, feedX + 22, y + 3);
    }

    // particle on the line
    const progress = (frame * pulseSpeed + index * 0.15) % 1;
    const px = feedX + 12 + (lineEndX - feedX - 12) * progress;
    const py = y + (centerY - y) * progress;
    context.fillStyle = `hsla(${hue}, 80%, 70%, ${0.6 + Math.sin(progress * Math.PI) * 0.4})`;
    context.beginPath();
    context.arc(px, py, 2.5, 0, Math.PI * 2);
    context.fill();
  });

  // inter-stage arrows with pulses
  drawArrowLine(context, normalizeX + Math.round(45 * s), centerY, tensorX - Math.round(52 * s), centerY, "rgba(56,189,248,0.5)", 2);
  drawParticle(context, normalizeX + 45 * s, centerY, tensorX - 52 * s, centerY, frame * 0.008 + 0.1, "#38BDF8");
  drawArrowLine(context, tensorX + Math.round(52 * s), centerY, preflightX - Math.round(44 * s), centerY, "rgba(52,211,153,0.5)", 2);
  drawParticle(context, tensorX + 52 * s, centerY, preflightX - 44 * s, centerY, frame * 0.008 + 0.3, "#34D399");
  drawArrowLine(context, preflightX + Math.round(44 * s), centerY, queueX - Math.round(38 * s), centerY, "rgba(251,146,60,0.5)", 2);
  drawParticle(context, preflightX + 44 * s, centerY, queueX - 38 * s, centerY, frame * 0.008 + 0.5, "#FB923C");

  // feedback loop from queue back to tensor
  if (!compact) {
    const feedbackY = centerY + Math.round(60 * s);
    context.strokeStyle = "rgba(139,92,246,0.2)";
    context.lineWidth = 1;
    context.setLineDash([4, 6]);
    context.beginPath();
    context.moveTo(queueX, feedbackY);
    context.lineTo(tensorX, feedbackY);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "rgba(139,92,246,0.4)";
    context.font = `700 ${Math.round(7 * s)}px ui-monospace, monospace`;
    context.textAlign = "center";
    context.fillText("shadow learning", (queueX + tensorX) / 2, feedbackY + 12);
    context.textAlign = "start";
  }

  if (detailed) {
    const labels = compact
      ? [["MLOFI", "#E0F2FE", "#075985"], ["COSTOS", "#FEF3C7", "#92400E"], ["RIESGO", "#FFE4E6", "#BE123C"]]
      : [["MLOFI TOP-5", "#E0F2FE", "#075985"], ["MICROPRICE", "#E0F2FE", "#075985"], ["COSTOS", "#FEF3C7", "#92400E"], ["LATENCIA", "#FEF3C7", "#92400E"], ["RIESGO", "#FFE4E6", "#BE123C"]];
    const gap = compact ? 6 : 8;
    const boxWidth = compact ? 64 : 82;
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
      context.font = `800 ${compact ? 7 : 8}px ui-monospace, monospace`;
      context.textAlign = "center";
      context.fillText(label, x + boxWidth / 2, y + 15);
    });
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
  x: number, y: number, w: number, h: number, r: number,
  fill: string, stroke: string, title: string, value: string, phase = 0
): void {
  // glow
  const glow = context.createRadialGradient(x, y, 0, x, y, w * 0.7);
  glow.addColorStop(0, stroke.replace(")", ",0.12)").replace("rgb", "rgba"));
  glow.addColorStop(1, "transparent");
  context.fillStyle = glow;
  context.beginPath();
  context.arc(x, y, w * 0.7, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = fill;
  context.strokeStyle = stroke;
  context.lineWidth = 1.5;
  roundedRect(context, x - w / 2, y - h / 2, w, h, r);
  context.fill();
  context.stroke();

  // Title
  context.textAlign = "center";
  context.fillStyle = "#0F172A";
  context.font = `900 ${Math.round(w * 0.11)}px ui-sans-serif, system-ui`;
  context.fillText(title, x, y - 3);

  // Value
  context.fillStyle = "#0369A1";
  context.font = `800 ${Math.round(w * 0.09)}px ui-monospace, monospace`;
  context.fillText(value, x, y + 14);
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

function drawArrowLine(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, lineWidth: number): void {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = 8;
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(x2, y2);
  context.lineTo(x2 - headLen * Math.cos(angle - 0.4), y2 - headLen * Math.sin(angle - 0.4));
  context.lineTo(x2 - headLen * Math.cos(angle + 0.4), y2 - headLen * Math.sin(angle + 0.4));
  context.closePath();
  context.fill();
}

function drawParticle(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, progress: number, color: string): void {
  const t = ((progress % 1) + 1) % 1;
  const px = x1 + (x2 - x1) * t;
  const py = y1 + (y2 - y1) * t;
  const alpha = Math.sin(t * Math.PI) * 0.8;
  context.fillStyle = color.replace(")", `,${alpha})`).replace("rgb", "rgba");
  context.beginPath();
  context.arc(px, py, 3, 0, Math.PI * 2);
  context.fill();
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}
