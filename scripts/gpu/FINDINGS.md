# GPU / PyTorch model work — consolidated findings

Everything the GPU path (`scripts/gpu/`) produced, and the honest conclusions. All
models here are **research artifacts**; the committed `neural-edge.json` /
`edge-model.json` remain the shipped ones unless explicitly promoted.

## 1. NeuralEdge ported to the Orin GPU (synthetic task)
- `scripts/dumpNeuralData.ts` → `train_neural_gpu.py` → `verifyExport.ts`, orchestrated
  by `run_overnight.sh` (`npm run train:neural:gpu`). Trains the MLP on CUDA with a
  hyper-parameter sweep + honest round-disjoint train/val/**test** split, exports a
  drop-in `public/model/neural-edge-gpu.json`.
- **Weight-transpose gotcha:** TS `matVec` uses `out[j]+=x[i]*W[i][j]`, so `W` is
  `[in][out]` = the transpose of `nn.Linear.weight`. Export transposes. Verified faithful:
  Python AUC == TS-inference AUC to <1e-4.
- At full precision committed `neural-edge.json` scores **test AUC 0.9975**, GPU best
  **0.9976** — equivalent. The GPU model is also **robust** to input precision; the
  committed one is fragile (see below).

## 2. A real robustness bug in the synthetic model
- `buy/sellImbalance` are effectively constant (=1/24), so their std ≈ 2e-14. Z-scoring
  `(x-mean)/std` amplifies floating-point dust into a dominant signal the pure-TS trainer
  latched onto. The committed model's 0.9975 **rides that noise** — rounding just those two
  features to 8 sig figs collapses it to AUC 0.508, while rounding any other feature is
  harmless. Risk: browser-vs-gateway "identical" scoring can diverge if float paths differ.
- **Fixes (GPU path):** floor near-zero variance (`std<1e-8 → 1`) instead of exact-zero;
  write verifier holdout at full precision. `trainNeural.ts` has the same latent bug
  (`Math.sqrt(...) || 1`) — recommended to fix + retrain, left for review.

## 3. Real-tape spread reversion — does the deep model find anything?
Trained on **real recorded tape** (not synthetic), same labelling as `reversionStudy.ts`.
- `scripts/dumpReversionData.ts` (streaming, two-pass, feeds `observeBook`, writes float32
  binary for instant load) → `train_neural_gpu.py`. Full tape: 61,915 rounds → **518,172
  candidates** (36.8% revert).
- **Test AUC ≈ 0.64–0.67** (walk-forward, tens of thousands out-of-sample), **leakage-clean**
  (shuffled-label control → 0.46). BUT **mostly mechanical**: `|netEdgeBps|` (current
  deviation magnitude) alone gives **AUC 0.634** — regression-to-the-mean, a statistical
  certainty, not alpha.
- **Microstructure adds ~nothing beyond the mechanical baseline.** With `observeBook`
  history live (momentum / realized-vol / imbalance-delta populated — only 4 features remain
  constant vs 9 before), the full-tape 120-epoch sweep lands at **test AUC 0.6495** vs the
  **0.634** mechanical baseline — the microstructure adds ~0.015, negligible.

## 4. Is the reversion tradeable? (`scripts/reversionBacktest.ts`)
**No — categorically, even with perfect foresight.**
| metric | value |
| --- | ---: |
| cheapest round-trip taker fee | **40 bps** |
| mean gross reversion captured, ALL candidates | 0.293 bps |
| mean gross reversion, PERFECT foresight (reverted only) | **1.296 bps** ← ceiling |
| net, perfect foresight | **−83 bps** |
| % of candidates that beat the fee, perfect foresight | **0%** |

Even a perfect crystal ball capturing every reversion nets deeply negative after fees. No
model — whatever its AUC — makes this profitable at retail taker fees. This is the concrete,
model-independent proof of why execution stays gated.

## Honest bottom line
The deep model genuinely learns real market structure (a step up from the tree's ~0.5), but
that structure is **mechanical mean-reversion, untradeable at retail fees**. This **refines**
the efficient-market thesis rather than overturning it — a stronger, more credible story than
either "0.99 alpha" (synthetic only) or "no signal at all".

## Artifacts (git-ignored `out/` unless noted)
- Models: `public/model/neural-edge-gpu.json`, `neural-edge-reversion-gpu.json`,
  `neural-edge-reversion-obs-gpu.json` (tracked).
- Reports/logs: `scripts/gpu/out/*` (regenerable): `reversion-obs-report.md`,
  `reversion-backtest.json`, run logs.
