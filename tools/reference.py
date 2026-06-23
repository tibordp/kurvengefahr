#!/usr/bin/env python3
"""NumPy reference implementation of the Graves RNN-MDN forward pass, reading the SAME
kg_model.f16.bin blob that crate/src/model.rs loads. Two jobs:

  * `python tools/reference.py render "hello world"` — free-run sample + render a PNG to
    /tmp/kg_sample.png, so a human (or Claude via Read) can eyeball that the weights + math
    actually produce legible handwriting. This is the end-to-end correctness check.

  * `python tools/reference.py fixtures` — dump deterministic *teacher-forced* MDN params to
    crate/tests/fixtures.json. The Rust port feeds the identical inputs and must reproduce these
    within tolerance. This pins network correctness independent of the (stochastic) sampler.

Mirrors tools/convert_weights.py for the alphabet and blob layout.
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np

ALPHABET = (
    "\x00 !\"#'(),-.0123456789:;?"
    "ABCDEFGHIJKLMNOPRSTUVWYabcdefghijklmnopqrstuvwxyz"
)
ROOT = Path(__file__).resolve().parent.parent
BLOB = ROOT / "public" / "models" / "kg_model.f16.bin"


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def softplus(x):
    return np.log1p(np.exp(-np.abs(x))) + np.maximum(x, 0.0)


def softmax(x):
    e = np.exp(x - x.max())
    return e / e.sum()


class Model:
    def __init__(self, path=BLOB):
        raw = path.read_bytes()
        assert raw[:4] == b"KGM1", "bad magic"
        version, A, H, K, M = struct.unpack_from("<5I", raw, 4)
        self.A, self.H, self.K, self.M = A, H, K, M
        self.U = 6 * M + 1
        off = 4 + 5 * 4
        data = np.frombuffer(raw, dtype=np.float16, offset=off).astype(np.float32)
        cur = [0]

        def take(rows, cols):
            n = rows * cols
            block = data[cur[0]:cur[0] + n].reshape(rows, cols) if cols > 1 else data[cur[0]:cur[0] + n]
            cur[0] += n
            return block

        in1 = A + 3
        in23 = 3 + H + A
        self.k1 = take(in1 + H, 4 * H)
        self.b1 = take(4 * H, 1)
        self.aw = take(A + 3 + H, 3 * K)
        self.ab = take(3 * K, 1)
        self.k2 = take(in23 + H, 4 * H)
        self.b2 = take(4 * H, 1)
        self.k3 = take(in23 + H, 4 * H)
        self.b3 = take(4 * H, 1)
        self.gw = take(H, self.U)
        self.gb = take(self.U, 1)
        assert cur[0] == data.size, f"blob leftover: {cur[0]} != {data.size}"

    def lstm(self, kernel, bias, x_full, h, c):
        H = self.H
        z = np.concatenate([x_full, h]) @ kernel + bias
        i, j, f, o = z[0:H], z[H:2 * H], z[2 * H:3 * H], z[3 * H:4 * H]
        c_new = sigmoid(f + 1.0) * c + sigmoid(i) * np.tanh(j)   # forget_bias = 1.0
        h_new = sigmoid(o) * np.tanh(c_new)
        return h_new, c_new

    def zero_state(self):
        H, K, A = self.H, self.K, self.A
        return dict(h1=np.zeros(H), c1=np.zeros(H), h2=np.zeros(H), c2=np.zeros(H),
                    h3=np.zeros(H), c3=np.zeros(H), kappa=np.zeros(K), w=np.zeros(A))

    def step(self, x, st, onehot):
        """One timestep. x = [dx,dy,eos], onehot = [U_chars, A]. Returns (gmm_params(121), new_state, phi)."""
        H = self.H
        # lstm 1
        h1, c1 = self.lstm(self.k1, self.b1, np.concatenate([st["w"], x]), st["h1"], st["c1"])
        # attention
        attn_in = np.concatenate([st["w"], x, h1])
        params = softplus(attn_in @ self.aw + self.ab)
        alpha, beta, kappa_hat = params[0:self.K], params[self.K:2 * self.K], params[2 * self.K:3 * self.K]
        kappa = st["kappa"] + kappa_hat / 25.0
        beta = np.maximum(beta, 0.01)
        u = np.arange(onehot.shape[0])                       # 0..U-1
        # phi[u] = sum_k alpha_k exp(-(kappa_k - u)^2 / beta_k)
        phi = (alpha[:, None] * np.exp(-((kappa[:, None] - u[None, :]) ** 2) / beta[:, None])).sum(axis=0)
        w = phi @ onehot                                      # [A]
        # lstm 2 & 3
        h2, c2 = self.lstm(self.k2, self.b2, np.concatenate([x, h1, w]), st["h2"], st["c2"])
        h3, c3 = self.lstm(self.k3, self.b3, np.concatenate([x, h2, w]), st["h3"], st["c3"])
        gmm = h3 @ self.gw + self.gb
        new = dict(h1=h1, c1=c1, h2=h2, c2=c2, h3=h3, c3=c3, kappa=kappa, w=w)
        return gmm, new, phi

    def parse(self, gmm, bias):
        M = self.M
        pis = gmm[0:M]
        sigmas = gmm[M:3 * M]
        rhos = gmm[3 * M:4 * M]
        mus = gmm[4 * M:6 * M]
        es = gmm[6 * M]
        pis = softmax(pis * (1.0 + bias))
        sig = np.clip(np.exp(sigmas - bias), 1e-4, np.inf)
        rho = np.clip(np.tanh(rhos), -1 + 1e-8, 1 - 1e-8)
        e = sigmoid(es)
        return pis, mus[:M], mus[M:], sig[:M], sig[M:], rho, e


def encode(text):
    idx = {c: i for i, c in enumerate(ALPHABET)}
    seq = [idx.get(c, 0) for c in text] + [0]   # trailing NUL terminator
    oh = np.zeros((len(seq), len(ALPHABET)), dtype=np.float32)
    for r, c in enumerate(seq):
        oh[r, c] = 1.0
    return oh


def free_run(model, text, bias=0.75, max_steps=None, seed=1):
    oh = encode(text)
    U = oh.shape[0]
    max_steps = max_steps or 40 * len(text)
    rng = np.random.RandomState(seed)
    st = model.zero_state()
    x = np.array([0.0, 0.0, 1.0])
    coords = []
    for t in range(max_steps):
        gmm, st, phi = model.step(x, st, oh)
        pis, mu1, mu2, s1, s2, rho, e = model.parse(gmm, bias)
        k = rng.choice(model.M, p=pis / pis.sum())
        z1, z2 = rng.randn(2)
        dx = mu1[k] + s1[k] * z1
        dy = mu2[k] + s2[k] * (rho[k] * z1 + np.sqrt(1 - rho[k] ** 2) * z2)
        eos = 1.0 if rng.rand() < e else 0.0
        coords.append((dx, dy, eos))
        x = np.array([dx, dy, eos])
        # termination
        amax = int(np.argmax(phi))
        if amax >= U - 1 and eos == 1.0:
            break
        if amax >= U:
            break
    return np.array(coords)


def render(text, bias=0.75, seed=1, out="/tmp/kg_sample.png"):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    model = Model()
    offsets = free_run(model, text, bias=bias, seed=seed)
    xy = np.cumsum(offsets[:, :2], axis=0)
    eos = offsets[:, 2]
    fig, ax = plt.subplots(figsize=(12, 2.5))
    stroke = [[], []]
    for (x, y), e in zip(xy, eos):
        stroke[0].append(x)
        stroke[1].append(-y)           # image y grows down
        if e == 1.0:
            ax.plot(stroke[0], stroke[1], "k", linewidth=2)
            stroke = [[], []]
    if stroke[0]:
        ax.plot(stroke[0], stroke[1], "k", linewidth=2)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(f'"{text}"  (bias={bias}, seed={seed})')
    fig.savefig(out, dpi=110, bbox_inches="tight")
    print(f"steps={len(offsets)}  wrote {out}")


def fixtures(out=None):
    """Teacher-forced: fixed chars + fixed input offsets → dump raw gmm params + window."""
    out = out or (ROOT / "crate" / "tests" / "fixtures.json")
    model = Model()
    text = "hi"
    oh = encode(text)                      # "hi" + NUL -> 3 chars
    inputs = [[0.0, 0.0, 1.0], [0.6, 0.15, 0.0], [0.4, -0.25, 0.0], [0.5, 0.05, 0.0]]
    st = model.zero_state()
    steps = []
    for x in inputs:
        gmm, st, phi = model.step(np.array(x), st, oh)
        steps.append(dict(gmm=gmm.tolist(), w=st["w"].tolist(), phi=phi.tolist(),
                          h3_head=st["h3"][:8].tolist()))
    payload = dict(text=text, char_indices=[ALPHABET.index(c) for c in text] + [0],
                   inputs=inputs, steps=steps)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2))
    print(f"wrote {out}  ({len(steps)} steps, gmm dim {len(steps[0]['gmm'])})")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "render"
    if cmd == "render":
        text = sys.argv[2] if len(sys.argv) > 2 else "hello world"
        bias = float(sys.argv[3]) if len(sys.argv) > 3 else 0.75
        seed = int(sys.argv[4]) if len(sys.argv) > 4 else 1
        render(text, bias=bias, seed=seed)
    elif cmd == "fixtures":
        fixtures()
    else:
        sys.exit(f"unknown command {cmd}")
