#!/usr/bin/env python3
"""Convert the sjvasquez/handwriting-synthesis TF checkpoint into the flat f16 blob
that crate/src/model.rs loads at runtime.

The model is Graves' RNN-MDN handwriting synthesiser (1308.0850): 3 stacked LSTM-400
layers with a soft attention "window" over the one-hot character sequence, and a 20-component
bivariate-Gaussian mixture-density output head. See crate/src/model.rs for the matching loader.

Run (one-off, dev-time only — end users never run this):

    uv run --python 3.11 --with tensorflow --with numpy \
        python tools/convert_weights.py /path/to/checkpoints/model-17900

Output: public/models/kg_model.f16.bin  (+ a manifest printed to stdout).

The 73-char alphabet, layer sizes and the blob layout here are mirrored verbatim in the Rust
loader; keep them in lockstep. The raw TF checkpoint is NOT committed (see .gitignore); only the
derived f16 blob is. License caveat: see tools/README.md.
"""
import struct
import sys
from pathlib import Path

import numpy as np
import tensorflow as tf

# Mirrors drawing.alphabet from the upstream repo. Index 0 is the NUL terminator. 73 chars;
# uppercase Q/X/Z are absent (rare in IAM-OnDB) — the Rust side substitutes them.
ALPHABET = (
    "\x00 !\"#'(),-.0123456789:;?"
    "ABCDEFGHIJKLMNOPRSTUVWYabcdefghijklmnopqrstuvwxyz"
)
ALPHABET_LEN = len(ALPHABET)          # 73
LSTM_SIZE = 400
ATTN_COMPONENTS = 10                  # K
OUTPUT_COMPONENTS = 20                # M
OUTPUT_UNITS = 6 * OUTPUT_COMPONENTS + 1  # 121

MAGIC = b"KGM1"
VERSION = 1

# Tensors in the fixed order the Rust loader expects. (checkpoint name, expected shape)
def tensor_specs():
    h = LSTM_SIZE
    in1 = ALPHABET_LEN + 3            # [w, inputs]
    in23 = 3 + h + ALPHABET_LEN       # [inputs, s_prev_out, w]
    return [
        ("rnn/LSTMAttentionCell/lstm_cell/kernel",   (in1 + h, 4 * h)),
        ("rnn/LSTMAttentionCell/lstm_cell/bias",     (4 * h,)),
        ("rnn/LSTMAttentionCell/attention/weights",  (ALPHABET_LEN + 3 + h, 3 * ATTN_COMPONENTS)),
        ("rnn/LSTMAttentionCell/attention/biases",   (3 * ATTN_COMPONENTS,)),
        ("rnn/LSTMAttentionCell/lstm_cell_1/kernel", (in23 + h, 4 * h)),
        ("rnn/LSTMAttentionCell/lstm_cell_1/bias",   (4 * h,)),
        ("rnn/LSTMAttentionCell/lstm_cell_2/kernel", (in23 + h, 4 * h)),
        ("rnn/LSTMAttentionCell/lstm_cell_2/bias",   (4 * h,)),
        ("rnn/gmm/weights",                          (h, OUTPUT_UNITS)),
        ("rnn/gmm/biases",                           (OUTPUT_UNITS,)),
    ]


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: convert_weights.py <checkpoint-prefix>  (e.g. checkpoints/model-17900)")
    ckpt = sys.argv[1]
    out_path = Path(__file__).resolve().parent.parent / "public" / "models" / "kg_model.f16.bin"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    reader = tf.train.load_checkpoint(ckpt)
    shape_map = reader.get_variable_to_shape_map()

    header = MAGIC + struct.pack(
        "<5I", VERSION, ALPHABET_LEN, LSTM_SIZE, ATTN_COMPONENTS, OUTPUT_COMPONENTS
    )
    body = bytearray()
    total_params = 0
    print(f"{'tensor':<48} {'shape':>16} {'f16 bytes':>12}")
    for name, expected in tensor_specs():
        if name not in shape_map:
            sys.exit(f"missing tensor in checkpoint: {name}")
        arr = reader.get_tensor(name)
        if tuple(arr.shape) != expected:
            sys.exit(f"shape mismatch for {name}: got {arr.shape}, expected {expected}")
        f16 = np.ascontiguousarray(arr, dtype=np.float32).astype(np.float16)
        body += f16.tobytes()
        total_params += arr.size
        print(f"{name:<48} {str(tuple(arr.shape)):>16} {f16.nbytes:>12}")

    blob = header + bytes(body)
    out_path.write_bytes(blob)
    print(f"\nalphabet_len={ALPHABET_LEN} lstm_size={LSTM_SIZE} K={ATTN_COMPONENTS} M={OUTPUT_COMPONENTS}")
    print(f"params={total_params:,}  blob={len(blob):,} bytes ({len(blob)/1e6:.2f} MB)")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
