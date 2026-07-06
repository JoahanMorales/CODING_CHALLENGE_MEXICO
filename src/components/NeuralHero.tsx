"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

// Cinematic 3D decision network for the landing hero. Rendered with Three.js on a
// dark canvas: additive glowing nodes laid out as the real pipeline (7 markets ->
// microstructure -> strategies -> ML ensemble -> risk -> execute/discard), a soft
// mesh of connections, and light pulses that stream left-to-right down the wires
// like signals resolving into a verdict. Gentle auto-sway + mouse parallax give it
// depth. Lazy-loaded (ssr:false) so three.js never touches the other routes, and
// it renders a single still frame under prefers-reduced-motion.

const LAYERS: Array<{ count: number; color: number }> = [
  { count: 7, color: 0x38bdf8 }, // mercados        (sky)
  { count: 5, color: 0x22d3ee }, // microestructura (cyan)
  { count: 4, color: 0x818cf8 }, // estrategias     (indigo)
  { count: 7, color: 0x34d399 }, // ensemble ML     (emerald)
  { count: 3, color: 0xfbbf24 }, // riesgo          (amber)
  { count: 2, color: 0x34d399 } // decisión         (emerald / rose override below)
];
const DISCARD = 0xfb7185; // rose: the "descartar" decision node

const X_SPAN = 9.2;
const Y_GAP = 0.92;

function hash(n: number): number {
  let h = (n * 374761393) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function glowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.9)");
  g.addColorStop(0.45, "rgba(255,255,255,0.32)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

interface NodeInfo {
  pos: THREE.Vector3;
  color: number;
}

export function NeuralHero() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = mount.clientWidth || 640;
    let height = mount.clientHeight || 480;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070b16, 0.055);

    const camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 100);
    camera.position.set(0, 0.1, 9.6);

    // WebGL context creation throws ("Error creating WebGL context.") when the
    // browser can't give us a GPU context -- headless/VNC/software-render setups
    // (e.g. the Jetson over a remote display), WebGL disabled, or a lost driver.
    // Catch it here and bail to the static dark background instead of letting the
    // throw bubble out of useEffect into the global error boundary and take the
    // whole landing down.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch (err) {
      console.warn("NeuralHero: WebGL unavailable, skipping the 3D hero.", err);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const disposables: Array<{ dispose: () => void }> = [];
    const glow = glowTexture();
    disposables.push(glow);

    const group = new THREE.Group();
    scene.add(group);

    // ---- Nodes: one soft glow sprite + a bright core sprite each ----
    const nodes: NodeInfo[][] = [];
    let counter = 0;
    LAYERS.forEach((layer, li) => {
      const x = -X_SPAN / 2 + (li * X_SPAN) / (LAYERS.length - 1);
      const layerNodes: NodeInfo[] = [];
      for (let i = 0; i < layer.count; i += 1) {
        const y = (i - (layer.count - 1) / 2) * Y_GAP;
        const z = (hash(counter * 7 + 3) - 0.5) * 1.7;
        counter += 1;
        const color = li === LAYERS.length - 1 && i === 1 ? DISCARD : layer.color;
        const pos = new THREE.Vector3(x, y, z);
        layerNodes.push({ pos, color });

        const isDecision = li === LAYERS.length - 1;
        const glowMat = new THREE.SpriteMaterial({ map: glow, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 });
        const glowSprite = new THREE.Sprite(glowMat);
        glowSprite.scale.setScalar(isDecision ? 1.5 : 1.05);
        glowSprite.position.copy(pos);
        group.add(glowSprite);
        disposables.push(glowMat);

        const coreMat = new THREE.SpriteMaterial({ map: glow, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95 });
        const coreSprite = new THREE.Sprite(coreMat);
        coreSprite.scale.setScalar(isDecision ? 0.5 : 0.34);
        coreSprite.position.copy(pos);
        group.add(coreSprite);
        disposables.push(coreMat);
      }
      nodes.push(layerNodes);
    });

    // ---- Connections: soft additive mesh between adjacent layers, gradient
    // coloured from source node to target node ----
    const connections: Array<{ a: THREE.Vector3; b: THREE.Vector3; color: number }> = [];
    const linePositions: number[] = [];
    const lineColors: number[] = [];
    const cFrom = new THREE.Color();
    const cTo = new THREE.Color();
    for (let li = 0; li < nodes.length - 1; li += 1) {
      nodes[li].forEach((from) => {
        nodes[li + 1].forEach((to) => {
          connections.push({ a: from.pos, b: to.pos, color: to.color });
          cFrom.setHex(from.color);
          cTo.setHex(to.color);
          linePositions.push(from.pos.x, from.pos.y, from.pos.z, to.pos.x, to.pos.y, to.pos.z);
          lineColors.push(cFrom.r, cFrom.g, cFrom.b, cTo.r, cTo.g, cTo.b);
        });
      });
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
    lineGeo.setAttribute("color", new THREE.Float32BufferAttribute(lineColors, 3));
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    group.add(lines);
    disposables.push(lineGeo, lineMat);

    // ---- Signal pulses: bright sparks streaming down random wires ----
    const PULSE_COUNT = reduce ? 10 : 30;
    const pulses: Array<{ ci: number; t: number; speed: number; sprite: THREE.Sprite }> = [];
    for (let i = 0; i < PULSE_COUNT; i += 1) {
      const ci = Math.floor(hash(i * 13 + 1) * connections.length);
      const mat = new THREE.SpriteMaterial({ map: glow, color: connections[ci].color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 1 });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.setScalar(0.42);
      group.add(sprite);
      disposables.push(mat);
      pulses.push({ ci, t: hash(i * 29 + 5), speed: 0.18 + hash(i * 17 + 2) * 0.28, sprite });
    }

    function placePulse(p: (typeof pulses)[number]): void {
      const conn = connections[p.ci];
      p.sprite.position.lerpVectors(conn.a, conn.b, p.t);
      const fade = Math.sin(Math.min(1, p.t) * Math.PI); // fade in/out along the wire
      (p.sprite.material as THREE.SpriteMaterial).opacity = 0.15 + fade * 0.95;
    }
    pulses.forEach(placePulse);

    let mouseX = 0;
    let mouseY = 0;
    function onMove(event: PointerEvent): void {
      const rect = mount!.getBoundingClientRect();
      mouseX = (event.clientX - rect.left) / rect.width - 0.5;
      mouseY = (event.clientY - rect.top) / rect.height - 0.5;
    }
    mount.addEventListener("pointermove", onMove);

    const clock = new THREE.Clock();
    let raf = 0;
    let running = false;
    let onScreen = true;
    let targetRx = -0.04;
    let targetRy = 0;
    function frame(): void {
      const t = clock.getElapsedTime();
      targetRy += ((Math.sin(t * 0.16) * 0.32 + mouseX * 0.55) - targetRy) * 0.05;
      targetRx += ((-0.04 + mouseY * 0.28) - targetRx) * 0.05;
      group.rotation.y = targetRy;
      group.rotation.x = targetRx;

      for (const p of pulses) {
        p.t += p.speed * 0.016;
        if (p.t >= 1) {
          p.t = 0;
          p.ci = Math.floor(Math.random() * connections.length);
          (p.sprite.material as THREE.SpriteMaterial).color.setHex(connections[p.ci].color);
        }
        placePulse(p);
      }
      renderer.render(scene, camera);
      if (running) raf = requestAnimationFrame(frame);
    }
    function start(): void {
      if (running || reduce) return;
      running = true;
      raf = requestAnimationFrame(frame);
    }
    function stop(): void {
      running = false;
      cancelAnimationFrame(raf);
    }

    if (reduce) {
      group.rotation.set(-0.04, 0.18, 0);
      renderer.render(scene, camera);
    } else {
      start();
    }

    // Pause the loop when the hero is scrolled out of view or the tab is hidden --
    // no wasted GPU/CPU when nobody is watching it.
    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
        if (onScreen && !document.hidden) start();
        else stop();
      },
      { threshold: 0.01 }
    );
    io.observe(mount);
    const onVisibility = () => {
      if (!document.hidden && onScreen) start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // If the GPU drops the context mid-run (common on memory-constrained devices
    // like the Jetson), stop the loop instead of throwing on every frame. Prevent
    // the default so the browser doesn't mark it permanently unrecoverable.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      console.warn("NeuralHero: WebGL context lost, pausing the 3D hero.");
      stop();
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    const resize = () => {
      width = mount!.clientWidth || width;
      height = mount!.clientHeight || height;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      mount.removeEventListener("pointermove", onMove);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    };
  }, []);

  return <div aria-hidden className="absolute inset-0" ref={mountRef} />;
}
