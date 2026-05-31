"use client";

import { useEffect, useRef } from "react";

const venues = ["BIN", "KRK", "CB", "OKX", "BYB", "BFX", "GATE"];

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

  return <canvas aria-label="Flujo visual del ArbitrAI Edge Tensor" className="h-full w-full" ref={canvasRef} />;
}

function drawFlow(context: CanvasRenderingContext2D, width: number, height: number, frame: number, detailed: boolean): void {
  const compact = width < 620;
  const routeStart = compact ? 22 : width * 0.06;
  const normalizeX = compact ? width * 0.31 : width * 0.29;
  const tensorX = compact ? width * 0.59 : width * 0.56;
  const executionX = compact ? width * 0.84 : width * 0.84;
  const centerY = detailed ? height * 0.42 : height * 0.5;
  const top = detailed ? 34 : 26;
  const bottom = detailed ? height - 104 : height - 28;
  const radius = compact ? 4 : 5;

  drawGrid(context, width, height);
  drawStage(context, normalizeX, centerY, compact ? 64 : 82, compact ? 60 : 76, "#F0F9FF", "#7DD3FC", "NORMALIZA", "top 5");
  drawStage(context, tensorX, centerY, compact ? 72 : 96, compact ? 74 : 88, "#ECFDF5", "#6EE7B7", "AET", "72% surv.");
  drawStage(context, executionX, centerY, compact ? 62 : 84, compact ? 60 : 76, "#FFF7ED", "#FDBA74", "COLA", "score");

  venues.forEach((venue, index) => {
    const y = top + index * ((bottom - top) / (venues.length - 1));
    const selected = index === 1 || index === 4;
    drawLine(context, routeStart + radius, y, normalizeX - (compact ? 33 : 43), centerY, selected ? "rgba(14,165,233,0.58)" : "rgba(148,163,184,0.25)");
    drawDot(context, routeStart, y, radius, selected ? "#0EA5E9" : "#CBD5E1");
    if (!compact || index % 2 === 0) {
      context.fillStyle = selected ? "#0369A1" : "#64748B";
      context.font = `${selected ? 800 : 700} ${compact ? 8 : 9}px ui-monospace, SFMono-Regular, monospace`;
      context.fillText(venue, routeStart + 10, y + 3);
    }
    drawPulse(context, routeStart + radius, y, normalizeX - (compact ? 34 : 44), centerY, frame + index * 17, selected ? "#0EA5E9" : "#CBD5E1");
  });

  drawLine(context, normalizeX + (compact ? 33 : 43), centerY, tensorX - (compact ? 37 : 49), centerY, "rgba(14,165,233,0.64)", 2);
  drawPulse(context, normalizeX + 34, centerY, tensorX - 39, centerY, frame + 26, "#0EA5E9");
  drawLine(context, tensorX + (compact ? 37 : 49), centerY, executionX - (compact ? 32 : 44), centerY, "rgba(16,185,129,0.72)", 2);
  drawPulse(context, tensorX + 39, centerY, executionX - 34, centerY, frame + 52, "#10B981");

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
      const y = height - 54;
      context.fillStyle = fill;
      context.strokeStyle = text;
      roundedRect(context, x, y, boxWidth, 24, 7);
      context.fill();
      context.globalAlpha = 0.34;
      context.stroke();
      context.globalAlpha = 1;
      context.fillStyle = text;
      context.font = `800 ${compact ? 7 : 8}px ui-monospace, SFMono-Regular, monospace`;
      context.textAlign = "center";
      context.fillText(label, x + boxWidth / 2, y + 15);
    });
    context.textAlign = "start";
  }
}

function drawGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.strokeStyle = "rgba(186,230,253,0.25)";
  context.lineWidth = 1;
  for (let x = 0; x < width; x += 32) drawLine(context, x, 0, x, height, context.strokeStyle);
  for (let y = 0; y < height; y += 32) drawLine(context, 0, y, width, y, context.strokeStyle);
}

function drawStage(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: string, stroke: string, title: string, value: string): void {
  context.fillStyle = fill;
  context.strokeStyle = stroke;
  context.lineWidth = 1.4;
  roundedRect(context, x - width / 2, y - height / 2, width, height, 16);
  context.fill();
  context.stroke();
  context.textAlign = "center";
  context.fillStyle = "#0F172A";
  context.font = `900 ${width < 80 ? 9 : 11}px ui-sans-serif, system-ui`;
  context.fillText(title, x, y - 4);
  context.fillStyle = "#0369A1";
  context.font = `800 ${width < 80 ? 8 : 9}px ui-monospace, SFMono-Regular, monospace`;
  context.fillText(value, x, y + 14);
  context.textAlign = "start";
}

function drawLine(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 1): void {
  context.strokeStyle = color;
  context.lineWidth = width;
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function drawDot(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string): void {
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

function drawPulse(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, frame: number, color: string): void {
  const progress = (frame % 120) / 120;
  drawDot(context, x1 + (x2 - x1) * progress, y1 + (y2 - y1) * progress, 3, color);
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}
