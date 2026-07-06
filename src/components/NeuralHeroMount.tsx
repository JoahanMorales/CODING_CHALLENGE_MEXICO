"use client";

import dynamic from "next/dynamic";

// Lazy client boundary so three.js is code-split into its own chunk and only loads
// on the landing, after the shell paints. ssr:false is required (WebGL is
// browser-only) and is only allowed inside a client component -- hence this wrapper.
const NeuralHero = dynamic(() => import("./NeuralHero").then((mod) => mod.NeuralHero), {
  ssr: false,
  loading: () => null
});

export function NeuralHeroMount() {
  return <NeuralHero />;
}
