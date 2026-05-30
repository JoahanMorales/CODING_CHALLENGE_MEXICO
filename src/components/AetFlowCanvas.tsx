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
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      if (canvas.width !== rect.width * scale || canvas.height !== rect.height * scale) {
        canvas.width = rect.width * scale;
        canvas.height = rect.height * scale;
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      drawFlow(context, rect.width, rect.height, frame, detailed);
      frame += reduceMotion ? 0 : 1;
      animationFrame = window.requestAnimationFrame(draw);
    };

    draw();
    return () => window.cancelAnimationFrame(animationFrame);
  }, [detailed]);

  return <canvas aria-label="Flujo visual determinístico del ArbitrAI Edge Tensor" className="h-full w-full" ref={canvasRef} />;
}

function drawFlow(context: CanvasRenderingContext2D, width: number, height: number, frame: number, detailed: boolean): void {
  const tensorX = width * 0.52;
  const tensorY = height * 0.5;
  const executionX = width * 0.88;
  const radius = Math.max(5, Math.min(8, width / 110));
  const routeStart = width * 0.09;

  context.lineWidth = 1;
  venues.forEach((venue, index) => {
    const y = 28 + index * ((height - 56) / (venues.length - 1));
    const selected = index === 1 || index === 4;
    context.strokeStyle = selected ? "rgba(14, 165, 233, 0.55)" : "rgba(148, 163, 184, 0.28)";
    context.beginPath();
    context.moveTo(routeStart + radius, y);
    context.lineTo(tensorX - 46, tensorY);
    context.stroke();
    drawDot(context, routeStart, y, radius, selected ? "#0ea5e9" : "#94a3b8");
    context.fillStyle = selected ? "#0369a1" : "#64748b";
    context.font = "700 10px ui-monospace, SFMono-Regular, monospace";
    context.fillText(venue, routeStart + 14, y + 4);
    drawPulse(context, routeStart + radius, y, tensorX - 48, tensorY, frame + index * 17, selected ? "#0ea5e9" : "#cbd5e1");
  });

  context.fillStyle = "rgba(224, 242, 254, 0.94)";
  context.strokeStyle = "#7dd3fc";
  roundedRect(context, tensorX - 46, tensorY - 46, 92, 92, 18);
  context.fill();
  context.stroke();
  context.fillStyle = "#075985";
  context.font = "900 17px ui-sans-serif, system-ui";
  context.textAlign = "center";
  context.fillText("AET", tensorX, tensorY - 5);
  context.font = "800 9px ui-monospace, SFMono-Regular, monospace";
  context.fillText("SURVIVAL 72%", tensorX, tensorY + 15);
  context.textAlign = "start";

  context.strokeStyle = "rgba(16, 185, 129, 0.7)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(tensorX + 46, tensorY);
  context.lineTo(executionX - 18, tensorY);
  context.stroke();
  drawPulse(context, tensorX + 46, tensorY, executionX - 20, tensorY, frame + 35, "#10b981");
  drawDot(context, executionX, tensorY, radius + 3, "#10b981");
  context.fillStyle = "#047857";
  context.font = "900 10px ui-monospace, SFMono-Regular, monospace";
  context.fillText("EXEC", executionX + 16, tensorY + 4);

  if (!detailed) return;
  const labels = ["MLOFI", "MICROPRICE", "COSTS", "LATENCY", "IMPACT"];
  labels.forEach((label, index) => {
    const x = tensorX - 118 + index * 58;
    const y = tensorY + 88;
    context.fillStyle = index < 3 ? "#e0f2fe" : "#fef3c7";
    context.strokeStyle = index < 3 ? "#bae6fd" : "#fde68a";
    roundedRect(context, x, y, 50, 22, 7);
    context.fill();
    context.stroke();
    context.fillStyle = index < 3 ? "#075985" : "#92400e";
    context.font = "800 7px ui-monospace, SFMono-Regular, monospace";
    context.textAlign = "center";
    context.fillText(label, x + 25, y + 14);
  });
  context.textAlign = "start";
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

