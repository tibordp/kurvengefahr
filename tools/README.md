# tools/ — handwriting model weight conversion (dev-time only)

These scripts convert the pretrained **Graves RNN-MDN** handwriting-synthesis weights into the flat
`public/models/kg_model.f16.bin` blob that the WASM crate loads at runtime. **End users never run
these** — the committed `.bin` is all the app needs.

## Source weights & license caveat

Weights come from [`sjvasquez/handwriting-synthesis`](https://github.com/sjvasquez/handwriting-synthesis)
(`checkpoints/model-17900`), trained on the **IAM-OnDB** online-handwriting database. The upstream
repo ships **no LICENSE file**, and IAM-OnDB carries its own academic-use terms. We bundle only the
derived f16 weight blob for this personal pen-plotter project; if this is ever distributed more
broadly, revisit the licensing of both the weights and IAM-OnDB.

The raw 43.5 MB TF checkpoint is **not** committed (see `.gitignore`); only the 7.3 MB f16 blob is.

## Regenerating the blob

```sh
# 1. get the checkpoint + style samples
git clone --depth 1 https://github.com/sjvasquez/handwriting-synthesis.git /tmp/hws

# 2. convert weights -> public/models/kg_model.f16.bin
uv run --python 3.11 --with tensorflow --with numpy \
    python tools/convert_weights.py /tmp/hws/checkpoints/model-17900

# 3. export the golden priming sample -> crate/src/golden.bin (committed, ~9 KB)
uv run --python 3.11 --with numpy \
    python tools/export_golden.py /tmp/hws/styles/style-9
```

## Golden priming sample (`crate/src/golden.bin`)

Every handwriting word is primed on one fixed human exemplar so an element's words share a single
consistent hand (Graves' priming). `export_golden.py` converts one upstream `style-N` example into
the committed `golden.bin` that `crate/src/model.rs` embeds via `include_bytes!`. We use style 9;
swap the prefix to choose another. The primed state is computed once at load, so the sample's length
doesn't matter at runtime.

## Verifying / fixtures

`reference.py` is a NumPy port of the exact forward pass, reading the same blob the Rust loader uses.

```sh
# eyeball that the weights produce legible handwriting (renders /tmp/kg_sample.png)
uv run --python 3.11 --with numpy --with matplotlib \
    python tools/reference.py render "hello world" 0.75 7

# regenerate the Rust gold-test fixtures (crate/tests/fixtures.json):
# deterministic teacher-forced MDN params the Rust port must reproduce
uv run --python 3.11 --with numpy python tools/reference.py fixtures
```

## Blob layout (mirrored in `crate/src/model.rs`)

Header: `"KGM1"`, then `<5×u32>` = version, alphabet_len(73), lstm_size(400), K(10), M(20).
Body: f16 tensors, row-major, in this fixed order — `lstm1 {kernel,bias}`, `attention {weights,biases}`,
`lstm2 {kernel,bias}`, `lstm3 {kernel,bias}`, `gmm {weights,biases}`. Shapes are derived from the header
constants, so the loader carries no per-tensor metadata.
