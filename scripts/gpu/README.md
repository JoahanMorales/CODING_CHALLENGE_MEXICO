# GPU / PyTorch path (Jetson Orin)

The tree ensemble and the pure-TS `NeuralEdge` MLP train on the CPU. This folder
is the **GPU escape hatch**: a PyTorch environment that actually lights up the
Orin's Ampere cores, so we can train a bigger model (e.g. a GRU / temporal-CNN
for spread reversion on the real tape) than the hand-rolled TS backprop can.

## Setup (one time)

```bash
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r scripts/gpu/requirements-jetson.txt \
    --index-url https://pypi.jetson-ai-lab.io/jp6/cu126
```

The `.venv/` is git-ignored. This needs real network to `pypi.jetson-ai-lab.io`
(a third-party Jetson wheel index) — run it in your own shell.

## Verify the GPU works

```bash
.venv/bin/python scripts/gpu/verify_torch.py
```

Expect `device=cuda`, `GPU: Orin`, and a `NeuralEdge`-shaped MLP (24→32→16→1)
training on CUDA with val AUC climbing past 0.85 in a fraction of a second.

## Hard-won gotchas

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Failed to resolve pypi.jetson-ai-lab.dev` | The index moved domains | Use **`.io`**, not `.dev` |
| `libcudss.so.0: cannot open shared object file` | torch 2.9+/2.10/2.11 need cuDSS (CUDA 12.8/12.9 builds) | Pin **`torch==2.8.0`** |
| `CUBLAS_STATUS_ALLOC_FAILED calling cublasCreate` | cublas 12.9 (pulled by torch 2.11) vs the JetPack **12.6** driver | Pin **`torch==2.8.0`** — it links system CUDA 12.6 |
| `Failed to initialize NumPy` / pybind11 ABI warning | NumPy 2.x vs torch's NumPy-1.x ABI | `numpy<2` |

Full power for training: `sudo nvpmodel -m 2 && sudo jetson_clocks` (MAXN_SUPER).

## Done: PyTorch port + real-tape study

`scripts/trainNeural.ts` is ported to PyTorch here. See `FINDINGS.md` for the full
results; the honest bottom line is that the deep model matches the shipped one on
the synthetic task (and is more robust), while on real tape the reversion signal it
finds is mechanical and untradeable at retail fees.

Pipeline:

```bash
# Synthetic task (drop-in for the committee):
npm run train:neural:gpu              # dump -> GPU sweep -> verify export
npm run verify:neural:gpu             # re-check the export via real TS inference

# Real-tape spread reversion:
npm run dump:reversion data/tape-XXXX.jsonl        # streaming, observeBook live, float32 binary
DATA=scripts/gpu/data/reversion-samples.f32 META=scripts/gpu/data/reversion-meta.json \
  OUT_MODEL=public/model/neural-edge-reversion-gpu.json TAG=reversion \
  COMPARE_COMMITTED=0 SWEEP=small EPOCHS=120 BATCH=2048 \
  .venv/bin/python scripts/gpu/train_neural_gpu.py
npx tsx scripts/reversionBacktest.ts data/tape-XXXX.jsonl   # tradeability vs fees
```

- `train_neural_gpu.py`: CUDA trainer, hyperparam sweep, honest round-disjoint
  train/val/**test** split, drop-in export. Reads CSV or fast float32 binary. Env:
  `DATA META OUT_MODEL TAG EPOCHS BATCH SWEEP(full|small|quick) COMPARE_COMMITTED`.
- `verify_torch.py`: the original GPU smoke test.

**Key gotcha:** TS `matVec` uses `out[j]+=x[i]*W[i][j]`, so exported `W` is `[in][out]`
= the transpose of `nn.Linear.weight`. And floor near-zero-variance features before
z-scoring (`std<1e-8 → 1`) or the net fits amplified floating-point dust and turns
fragile.

## Next

A bigger sequence model (GRU / temporal-CNN) for spread reversion on the real tape.
