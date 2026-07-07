#!/usr/bin/env python3
"""GPU/PyTorch port of scripts/trainNeural.ts for the Jetson Orin.

Trains the NeuralEdge MLP on CUDA over the *same* synthetic distribution the
pure-TS trainer uses (dumped to CSV by scripts/dumpNeuralData.ts), runs a small
hyper-parameter sweep, and exports the best model back into the exact
public/model/neural-edge.json schema the TS inference (NeuralEdge.ts) reads, so
the committee stays a drop-in.

Honest evaluation: rounds are split disjointly into train / val / test.
  - train:      fits the weights
  - val (15%):  selects the epoch AND the sweep config (model selection)
  - test (15%): the headline number, never touched during selection

It also scores the currently-committed public/model/neural-edge.json on the SAME
test set, so the morning read is apples-to-apples: "did the GPU model beat what's
shipped, on identical held-out data?".

Nothing committed is overwritten. Outputs go to:
  public/model/neural-edge-gpu.json      (candidate, drop-in schema)
  scripts/gpu/out/sweep-report.json      (every config: val + test AUC)
  scripts/gpu/out/sweep-report.md        (human summary)
  scripts/gpu/out/val-holdout.csv        (raw test features -> TS verifyExport.ts)

Run:  .venv/bin/python scripts/gpu/train_neural_gpu.py
Env:  EPOCHS (default 300)  QUICK=1 (tiny smoke sweep)  DATA=<csv>  BATCH (default 512)
"""
import csv
import itertools
import json
import os
import time
from datetime import datetime, timezone

import numpy as np
import torch
import torch.nn as nn

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.environ.get("DATA", os.path.join(ROOT, "scripts/gpu/data/neural-samples.csv"))
META = os.environ.get("META", os.path.join(ROOT, "scripts/gpu/data/neural-meta.json"))
OUT_DIR = os.path.join(ROOT, "scripts/gpu/out")
OUT_MODEL = os.environ.get("OUT_MODEL", os.path.join(ROOT, "public/model/neural-edge-gpu.json"))
COMMITTED = os.path.join(ROOT, "public/model/neural-edge.json")
# Filename stem for reports, so a reversion run doesn't clobber the synthetic one.
TAG = os.environ.get("TAG", "sweep")
# Compare against the committed synthetic neural-edge.json? Off for the real-data
# reversion task (different task/target -- meaningless baseline there).
COMPARE_COMMITTED = os.environ.get("COMPARE_COMMITTED", "1") == "1"

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
EPOCHS = int(os.environ.get("EPOCHS", "300"))
BATCH = int(os.environ.get("BATCH", "512"))
QUICK = os.environ.get("QUICK", "0") == "1"
SWEEP = os.environ.get("SWEEP", "full")  # full | small | quick


# ----------------------------------------------------------------------------
# Data
# ----------------------------------------------------------------------------
def load_data():
    with open(META) as f:
        meta = json.load(f)
    feature_keys = meta["featureKeys"]
    nf = len(feature_keys)
    if DATA.endswith((".f32", ".bin")):
        # Row-major float32 binary written by the dumpers: NF features + label + round.
        # Loads in milliseconds vs np.loadtxt's minutes on a big CSV.
        cols = meta.get("cols", nf + 2)
        rows = np.fromfile(DATA, dtype=np.float32).reshape(-1, cols)
    else:
        rows = np.loadtxt(DATA, delimiter=",", skiprows=1, dtype=np.float64)
    x = rows[:, :nf].astype(np.float32)
    y = rows[:, nf].astype(np.float32)
    rounds = rows[:, nf + 1].astype(np.int64)
    return feature_keys, x, y, rounds


def round_disjoint_masks(rounds):
    """Split by round so no round straddles two sets. Last 15% rounds = test,
    the 15% before that = val, the first 70% = train."""
    max_round = int(rounds.max())
    val_start = int(max_round * 0.70)
    test_start = int(max_round * 0.85)
    train = rounds < val_start
    val = (rounds >= val_start) & (rounds < test_start)
    test = rounds >= test_start
    return train, val, test


def auc_np(pred, target):
    """Rank-based AUC (Mann-Whitney), matches the TS trainer's auc()."""
    p = np.asarray(pred).ravel()
    t = np.asarray(target).ravel()
    pos = p[t == 1]
    neg = p[t == 0]
    if pos.size == 0 or neg.size == 0:
        return 0.5
    order = np.argsort(p, kind="mergesort")
    ranks = np.empty(p.size, dtype=np.float64)
    ranks[order] = np.arange(1, p.size + 1)
    rank_pos = ranks[t == 1].sum()
    return float((rank_pos - pos.size * (pos.size + 1) / 2) / (pos.size * neg.size))


# ----------------------------------------------------------------------------
# Model
# ----------------------------------------------------------------------------
class MLP(nn.Module):
    def __init__(self, nf, h1, h2, dropout):
        super().__init__()
        self.fc1 = nn.Linear(nf, h1)
        self.fc2 = nn.Linear(h1, h2)
        self.fc3 = nn.Linear(h2, 1)
        self.drop = nn.Dropout(dropout)

    def forward(self, x):
        a1 = self.drop(torch.relu(self.fc1(x)))
        a2 = self.drop(torch.relu(self.fc2(a1)))
        return torch.sigmoid(self.fc3(a2))


def export_bundle(model, feature_keys, mean, std, arch, test_auc, val_auc, n_train, n_val, extra):
    """Weights -> the TS schema. TS matVec uses out[j] += x[i]*W[i][j], i.e. W is
    [in][out] = the TRANSPOSE of nn.Linear.weight ([out][in]). Transpose here."""
    def wt(layer):
        return layer.weight.detach().cpu().numpy().T.astype(np.float64).tolist()

    def bs(layer):
        return layer.bias.detach().cpu().numpy().astype(np.float64).tolist()

    return {
        "version": 1,
        "kind": "mlp",
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "arch": arch,
        "featureKeys": list(feature_keys),
        "mean": mean.astype(np.float64).tolist(),
        "std": std.astype(np.float64).tolist(),
        "valAuc": round(float(test_auc), 4),
        "valAucSelection": round(float(val_auc), 4),
        "trainSamples": int(n_train),
        "valSamples": int(n_val),
        "trainedOn": "gpu",
        "device": torch.cuda.get_device_name(0) if DEVICE == "cuda" else "cpu",
        "sweep": extra,
        "weights": {
            "W1": wt(model.fc1), "b1": bs(model.fc1),
            "W2": wt(model.fc2), "b2": bs(model.fc2),
            "W3": wt(model.fc3), "b3": bs(model.fc3),
        },
    }


def score_committed(feature_keys, x_test_raw, y_test):
    """Run the committed neural-edge.json forward pass (numpy) on the SAME test
    set, using ITS own mean/std + weights, for an apples-to-apples baseline."""
    if not os.path.exists(COMMITTED):
        return None
    with open(COMMITTED) as f:
        b = json.load(f)
    keys = b["featureKeys"]
    idx = [feature_keys.index(k) for k in keys]  # align column order
    xc = x_test_raw[:, idx]
    mean = np.array(b["mean"], dtype=np.float64)
    std = np.array([s if s else 1.0 for s in b["std"]], dtype=np.float64)
    xn = (xc - mean) / std
    W1 = np.array(b["weights"]["W1"]); b1 = np.array(b["weights"]["b1"])
    W2 = np.array(b["weights"]["W2"]); b2 = np.array(b["weights"]["b2"])
    W3 = np.array(b["weights"]["W3"]); b3 = np.array(b["weights"]["b3"])
    a1 = np.maximum(xn @ W1 + b1, 0.0)
    a2 = np.maximum(a1 @ W2 + b2, 0.0)
    p = 1.0 / (1.0 + np.exp(-(a2 @ W3 + b3)))
    return auc_np(p, y_test), b.get("valAuc")


# ----------------------------------------------------------------------------
# Train one config
# ----------------------------------------------------------------------------
def train_config(cfg, tensors, nf):
    xtr, ytr, xva, yva, xte, yte = tensors
    torch.manual_seed(cfg["seed"])
    model = MLP(nf, cfg["h1"], cfg["h2"], cfg["dropout"]).to(DEVICE)
    opt = torch.optim.Adam(model.parameters(), lr=cfg["lr"], weight_decay=cfg["wd"])
    loss_fn = nn.BCELoss()
    n = xtr.shape[0]

    best_val = -1.0
    best_state = None
    for epoch in range(EPOCHS):
        model.train()
        perm = torch.randperm(n, device=DEVICE)
        for i in range(0, n, BATCH):
            b = perm[i : i + BATCH]
            opt.zero_grad()
            loss = loss_fn(model(xtr[b]), ytr[b])
            loss.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            va = auc_np(model(xva).cpu().numpy(), yva.cpu().numpy())
        if va > best_val:
            best_val = va
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        te = auc_np(model(xte).cpu().numpy(), yte.cpu().numpy())
    return model, best_val, te


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"torch {torch.__version__} | device={DEVICE} | epochs={EPOCHS} | quick={QUICK}")
    if DEVICE == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")

    feature_keys, x, y, rounds = load_data()
    nf = len(feature_keys)
    tr, va, te = round_disjoint_masks(rounds)
    print(f"samples={x.shape[0]} nf={nf} | train={tr.sum()} val={va.sum()} test={te.sum()} "
          f"| rounds={int(rounds.max())+1}")

    # Standardise on TRAIN ONLY (no val/test leakage). Floor near-zero variance,
    # not just exact-zero: features that are effectively constant (e.g.
    # buy/sellImbalance == 1/24) otherwise get std ~1e-14, and z-scoring divides
    # floating-point dust by it -> the amplified noise dominates and the model
    # fits it, giving a headline AUC that is fragile to input precision. Treating
    # them as std=1 neutralises the constant instead of amplifying its noise.
    mean = x[tr].mean(axis=0)
    std = x[tr].std(axis=0)
    near_const = std < 1e-8
    if near_const.any():
        print(f"neutralising {int(near_const.sum())} near-constant feature(s): "
              f"{[feature_keys[i] for i in np.where(near_const)[0]]}")
    std[near_const] = 1.0
    xn = (x - mean) / std

    def dev(a):
        return torch.tensor(a, device=DEVICE)

    tensors = (
        dev(xn[tr]), dev(y[tr]).unsqueeze(1),
        dev(xn[va]), dev(y[va]).unsqueeze(1),
        dev(xn[te]), dev(y[te]).unsqueeze(1),
    )

    baseline = score_committed(feature_keys, x[te], y[te]) if COMPARE_COMMITTED else None
    if baseline:
        print(f"committed neural-edge.json  test AUC = {baseline[0]:.4f}  (its stored valAuc={baseline[1]})")

    # Sweep grid (kept 3-layer so the export stays drop-in for TS inference).
    if QUICK or SWEEP == "quick":
        grid = dict(seed=[0], h1=[32], h2=[16], dropout=[0.0], wd=[0.0], lr=[3e-3])
    elif SWEEP == "small":
        grid = dict(seed=[0, 1, 2], h1=[32, 64], h2=[16], dropout=[0.0, 0.1], wd=[0.0, 1e-4], lr=[3e-3])
    else:
        grid = dict(
            seed=[0, 1, 2],
            h1=[32, 48, 64],
            h2=[16, 24, 32],
            dropout=[0.0, 0.1],
            wd=[0.0, 1e-5],
            lr=[3e-3],
        )
    keys = list(grid.keys())
    combos = [dict(zip(keys, vals)) for vals in itertools.product(*[grid[k] for k in keys])]
    print(f"sweep: {len(combos)} configs x {EPOCHS} epochs")

    results = []
    best = None  # (val_auc, test_auc, cfg, model)
    t0 = time.time()
    for i, cfg in enumerate(combos):
        model, val_auc, test_auc = train_config(cfg, tensors, nf)
        results.append({**cfg, "valAuc": round(val_auc, 4), "testAuc": round(test_auc, 4)})
        print(f"[{i+1:>2}/{len(combos)}] {cfg} -> val {val_auc:.4f} | test {test_auc:.4f}")
        # Select on VAL only.
        if best is None or val_auc > best[0]:
            best = (val_auc, test_auc, cfg, model)
    if DEVICE == "cuda":
        torch.cuda.synchronize()
    elapsed = time.time() - t0

    best_val, best_test, best_cfg, best_model = best
    arch = [nf, best_cfg["h1"], best_cfg["h2"], 1]
    bundle = export_bundle(
        best_model, feature_keys, mean, std, arch, best_test, best_val,
        int(tr.sum()), int(va.sum()),
        {"selectedBy": "val", "config": best_cfg, "configsTried": len(combos),
         "committedTestAuc": round(baseline[0], 4) if baseline else None},
    )
    os.makedirs(os.path.dirname(OUT_MODEL), exist_ok=True)
    with open(OUT_MODEL, "w") as f:
        json.dump(bundle, f, indent=2)

    # Raw test features for the TS end-to-end verifier (NeuralEdge standardises
    # internally, so dump un-standardised features in featureKeys order). Use
    # repr() for full float64 round-trip precision: truncating here (e.g. 8 sig
    # figs) perturbs inputs enough to flip a razor-sharp model's predictions and
    # makes verifyExport report a spurious AUC collapse.
    with open(os.path.join(OUT_DIR, "val-holdout.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(list(feature_keys) + ["y"])
        for row, label in zip(x[te], y[te]):
            w.writerow([repr(float(v)) for v in row] + [int(label)])

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "device": bundle["device"],
        "samples": int(x.shape[0]),
        "split": {"train": int(tr.sum()), "val": int(va.sum()), "test": int(te.sum())},
        "epochs": EPOCHS,
        "elapsedSec": round(elapsed, 1),
        "committedTestAuc": round(baseline[0], 4) if baseline else None,
        "best": {"config": best_cfg, "valAuc": round(best_val, 4), "testAuc": round(best_test, 4)},
        "beatsCommitted": (baseline is not None and best_test > baseline[0]),
        "results": sorted(results, key=lambda r: -r["valAuc"]),
    }
    with open(os.path.join(OUT_DIR, f"{TAG}-report.json"), "w") as f:
        json.dump(report, f, indent=2)

    lines = [
        "# NeuralEdge GPU sweep\n",
        f"- generated: {report['generatedAt']}",
        f"- device: {report['device']}",
        f"- samples: {report['samples']} (train {report['split']['train']} / "
        f"val {report['split']['val']} / test {report['split']['test']})",
        f"- epochs/config: {EPOCHS} | configs: {len(combos)} | elapsed: {elapsed:.1f}s\n",
        "## Headline (honest, on held-out TEST set)\n",
        f"- **committed neural-edge.json**: test AUC "
        f"**{baseline[0]:.4f}**" if baseline else "- committed model: n/a",
        f"- **GPU best** ({best_cfg}): val {best_val:.4f} → **test {best_test:.4f}**",
        f"- beats committed on test: **{'YES' if report['beatsCommitted'] else 'no'}**\n",
        "## Top configs (by val AUC)\n",
        "| val | test | seed | h1 | h2 | dropout | wd | lr |",
        "|----:|-----:|----:|---:|---:|--------:|---:|---:|",
    ]
    for r in report["results"][:12]:
        lines.append(f"| {r['valAuc']:.4f} | {r['testAuc']:.4f} | {r['seed']} | "
                     f"{r['h1']} | {r['h2']} | {r['dropout']} | {r['wd']} | {r['lr']} |")
    with open(os.path.join(OUT_DIR, f"{TAG}-report.md"), "w") as f:
        f.write("\n".join(lines) + "\n")

    print("\n=== done ===")
    print(f"  best config     : {best_cfg}")
    print(f"  best val AUC     : {best_val:.4f}")
    print(f"  best TEST AUC    : {best_test:.4f}")
    if baseline:
        print(f"  committed test   : {baseline[0]:.4f}  -> beats: {report['beatsCommitted']}")
    print(f"  model exported   : {OUT_MODEL}")
    print(f"  report           : {os.path.join(OUT_DIR, 'sweep-report.md')}")


if __name__ == "__main__":
    main()
