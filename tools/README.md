# tools/ — dev-time asset generators

Scripts that produce committed assets: the docs screenshots, the handwriting model weight blob,
and the Hershey font data. **End users never run these** — the committed artifacts are all the
app needs.

## Docs screenshots (`docs/showcase.png`, `public/og.png`)

`screenshot.mjs` renders a `.kgz` document to a PNG through the real app in headless Chrome:
imports the container, waits for generation to settle, fits the view, screenshots. Regenerate the
README screenshot after a visible UI change:

```sh
node tools/screenshot.mjs docs/showcase.kgz   # rewrites docs/showcase.png
```

Any `.kgz` works, and every committed screenshot keeps its source `.kgz` beside it (see the
script header for `--url/--width/--height/--scale/--theme`). The social-preview card
(`public/og.png`, referenced from `index.html`) is a 1200x630 crop of the showcase screenshot --
refresh it after regenerating:

```sh
sips --resampleWidth 1200 docs/showcase.png --out public/og.png
sips --cropToHeightWidth 630 1200 public/og.png
```

## Hershey fonts (`crate/fonts/hershey.json`)

`gen_hershey.py` regenerates the single-stroke font data from the public-domain Hershey JHF
sources, with each glyph's **true horizontal advance** (JHF right − left) as `a`:

```sh
git clone --depth 1 https://github.com/kamalmostafa/hershey-fonts /tmp/hershey-fonts
python3 tools/gen_hershey.py /tmp/hershey-fonts/hershey-fonts
```

Stdlib-only. The script self-checks against the existing json (stroke `d`-strings must match
exactly) so a JHF parsing bug can't silently reshape the glyphs.

# Handwriting model weight conversion

These scripts convert the pretrained **Graves RNN-MDN** handwriting-synthesis weights into the flat
`public/models/kg_model.f16.bin` blob that the WASM crate loads at runtime.

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
