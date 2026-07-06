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

## Next step (not done yet)

Port `scripts/trainNeural.ts` to PyTorch here: reuse the same 24-feature
synthetic generator + real-tape features, train on GPU, and export weights back
to the `public/model/neural-edge.json` schema the TS inference reads so the
committee stays a drop-in. `verify_torch.py` is the working skeleton to build on.
