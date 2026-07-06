#!/usr/bin/env python3
"""GPU smoke test for the Jetson PyTorch path.

Confirms torch sees the Orin GPU and trains the NeuralEdge-shaped MLP
(24 -> 32 -> 16 -> 1, ReLU, sigmoid) on CUDA end-to-end on synthetic data,
so we know the CUDA/cuDNN/cuBLAS stack is healthy before porting the real
trainNeural pipeline to the GPU.

Run:  .venv/bin/python scripts/gpu/verify_torch.py
Expect:  device=Orin, CUDA available, AUC climbing well above 0.5.
"""
import time

import torch
import torch.nn as nn

FEATURES = 24  # matches NeuralEdge's input width
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def make_synthetic(n: int, gen: torch.Generator) -> tuple[torch.Tensor, torch.Tensor]:
    """A separable-ish synthetic set: label depends on a weighted, noisy
    projection of the features -- enough for the MLP to actually learn on."""
    x = torch.randn(n, FEATURES, generator=gen)
    w = torch.linspace(-1.0, 1.0, FEATURES)
    logits = x @ w + 0.35 * torch.randn(n, generator=gen)
    y = (logits > 0).float().unsqueeze(1)
    return x, y


class NeuralEdge(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(FEATURES, 32), nn.ReLU(),
            nn.Linear(32, 16), nn.ReLU(),
            nn.Linear(16, 1), nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def auc(pred: torch.Tensor, target: torch.Tensor) -> float:
    """Rank-based AUC (Mann-Whitney), computed on CPU."""
    p = pred.flatten().cpu()
    t = target.flatten().cpu()
    pos, neg = p[t == 1], p[t == 0]
    if pos.numel() == 0 or neg.numel() == 0:
        return float("nan")
    order = torch.argsort(torch.cat([pos, neg]))
    ranks = torch.empty_like(order, dtype=torch.float)
    ranks[order] = torch.arange(1, order.numel() + 1, dtype=torch.float)
    r_pos = ranks[: pos.numel()].sum()
    return float((r_pos - pos.numel() * (pos.numel() + 1) / 2) / (pos.numel() * neg.numel()))


def main() -> None:
    print(f"torch {torch.__version__} | build cuda {torch.version.cuda} | device={DEVICE}")
    if DEVICE == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        free, total = torch.cuda.mem_get_info()
        print(f"GPU mem free/total: {free/1e9:.2f} / {total/1e9:.2f} GB")
    else:
        print("!! CUDA not available -- running on CPU (check torch version vs JetPack CUDA)")

    gen = torch.Generator().manual_seed(7)
    xtr, ytr = make_synthetic(20000, gen)
    xva, yva = make_synthetic(4000, gen)
    xtr, ytr, xva, yva = (t.to(DEVICE) for t in (xtr, ytr, xva, yva))

    model = NeuralEdge().to(DEVICE)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.BCELoss()

    t0 = time.time()
    for epoch in range(1, 31):
        model.train()
        opt.zero_grad()
        loss = loss_fn(model(xtr), ytr)
        loss.backward()
        opt.step()
        if epoch % 10 == 0:
            model.eval()
            with torch.no_grad():
                va_auc = auc(model(xva), yva)
            print(f"epoch {epoch:3d} | loss {loss.item():.4f} | val AUC {va_auc:.4f}")
    if DEVICE == "cuda":
        torch.cuda.synchronize()
    print(f"trained 30 epochs on {DEVICE} in {time.time()-t0:.2f}s")


if __name__ == "__main__":
    main()
