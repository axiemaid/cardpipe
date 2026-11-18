# cardpipe

Modular card processing pipeline for Hyper Battle First Stage trading cards. Each module is standalone, composable, and independently testable.

Built on the [CARDIMG](https://github.com/axiemaid/cardimg-upload) and [CARDSET](https://github.com/axiemaid/cardimg-bind) on-chain protocols on BSV.

## Why?

The previous tools (`cardid-detector`, `cardimg-upload`, `cardimg-bind`, `cardimg-validator`) each worked, but as they grew they became tangled — modules imported each other, I/O leaked across boundaries, and a breakage in one cascaded. This is a clean rewrite where every module has one job and no module knows about the next.

## Pipeline

```
image → validate → crop → screen → upload → bind
         │          │        │         │        │
         ▼          ▼        ▼         ▼        ▼
      {pass?}    {card}   {code?}   {txid}   {set txid}
```

| Step | What it checks | What it produces |
|------|---------------|-----------------|
| **validate** | Format, file size, resolution, aspect ratio, saturation | pass/fail + warnings |
| **crop** | OpenCV contour detection + brown ring validation → extract card from scan | cropped image pixels |
| **screen** | pHash + color histogram matching against 42-card reference DB | verdict (match/likely/no_match) + card code |
| **upload** | CARDIMG protocol: `OP_FALSE OP_RETURN "CARDIMG" <image>` on BSV | txid + SHA-256 hash |
| **bind** | CARDSET protocol: `OP_FALSE OP_RETURN "CARDSET" <txid1> <txid2> ...` on BSV | set txid |

Each step can be skipped or run in isolation. The orchestrator wires them together, but you can also call modules directly.

## Modules

### card-phash — Perceptual Hashing

DCT-based perceptual hashing. **Pure math, zero dependencies.** Copy it anywhere.

```
grayscale 32×32 → 2D DCT → top-left 8×8 → median → 64-bit hash
```

```js
const { phash, hammingDistance, hashToHex, hexToHash } = require('card-phash');

const hash = phash(grayUint8Array, 32, 32);  // → BigInt
const dist = hammingDistance(hashA, hashB);   // → 0-64 (0 = identical)
const hex = hashToHex(hash);                  // → "a3f2..." (for JSON storage)
```

### card-image — Isomorphic I/O Adapter

The single I/O boundary. Every other module receives raw pixels from here and never touches sharp or canvas directly.

```js
const { loadImage, resize, extractRegion, toGrayscale, toRGB } = require('card-image');

const img = await loadImage('./scan.png');     // → { data, width, height, channels }
const small = await resize(img, 343, 480);     // → { data, width, height, channels }
const gray = toGrayscale(small);                // → Uint8Array (1 channel)
const rgb = toRGB(small);                       // → Uint8Array (3 channels)
```

**Node:** uses `sharp`. **Browser:** uses `OffscreenCanvas`. Same API either way.

### card-validate — Scan Quality Gate

Fast pre-filter before crop/screen. Checks format, file size, resolution, aspect ratio, and average saturation. No OpenCV.

```js
const { validate } = require('card-validate');

const result = await validate('./scan.png');
// → { passed: true, warnings: [], width: 1080, height: 1520, avgSaturation: 0.42 }
// → { passed: false, failures: [{ code: 'E_SIZE', message: 'File too small...' }] }
```

Failure codes: `E_EMPTY`, `E_SIZE`, `E_FORMAT`, `E_RESOLUTION`, `E_ASPECT`, `E_DECODE`

### card-screen — Identity Matching

pHash (75%) + color histogram (25%) matching against a reference database. 42 Hyper Battle First Stage cards in ~214KB.

```js
const { loadRefs, screenCard } = require('card-screen');

const refs = await loadRefs('./refs/first-stage.json');
const result = await screenCard('./scan.png', refs);
// → { verdict: 'match', code: 'C01', confidence: 1.0 }
// → { verdict: 'no_match', code: 'C10', confidence: 0.45 }
```

Verdicts:
- **match** — Hamming ≤6 AND score margin ≥0.05
- **likely** — Hamming ≤12 AND histogram >0.9
- **no_match** — Hamming >18 OR score <0.75

### card-crop — Card Boundary Detection

OpenCV contour detection with brown ring validation. Finds the card in a messy scan (sleeve, background, glare) and extracts it.

```js
const { cropCard } = require('card-crop');

const result = await cropCard('./scan.png');
// → { cropped: {data, width, height, channels}, corners, bounds, method: 'contour' }
// → { cropped: null, reason: 'no_valid_card' }
```

Methods: `contour` (approxPolyDP), `hull` (convex hull fallback), `brown-hsv` (HSV mask fallback).

### card-upload — On-Chain Broadcast

CARDIMG protocol uploader. Broadcasts card image to BSV.

```js
const { uploadCard } = require('card-upload');

const result = await uploadCard('./scan.png', './wallet.json');
// → { txid: '3a512c...', hash: '858822a0...', size: 560000, fee: 56003 }

const dryRun = await uploadCard('./scan.png', './wallet.json', { dryRun: true });
// → { txid: null, hash, size, fee, txHex } (no broadcast)
```

Wallet format: `{ wif: "...", address: "..." }`

### card-bind — CARDSET Binding

Links 2+ CARDIMG txids together on BSV (front + back + supplementary angles).

```js
const { bindCards } = require('card-bind');

const result = await bindCards([frontTxid, backTxid], './wallet.json');
// → { txid: 'abc123...', count: 2, fee: 28 }
```

Positional ordering (convention): `0 = front`, `1 = back`, `2+ = supplementary`.

## Orchestrator

Wires all modules into the full pipeline. Short-circuits on failure.

```js
const { process, processBatch } = require('./orchestrator');

// Full pipeline: validate → crop → screen → upload → bind
const result = await process('./scan.png', {
  refsPath: './refs/first-stage.json',
  walletPath: './wallet.json',
  bindTxids: [existingBackTxid],  // bind front+back into a CARDSET
});

// → {
//   accepted: true,
//   code: 'C01',
//   confidence: 1.0,
//   uploadTxid: '3a512c...',
//   bindTxid: 'abc123...',
//   steps: [...]
// }
```

### Skip any step

```js
await process('./scan.png', { skipCrop: true });               // screen only (clean input)
await process('./scan.png', { skipUpload: true });              // validate + crop + screen, no broadcast
await process('./scan.png', { skipValidate: true });            // trust the input
await process('./scan.png', { dryRun: true, walletPath: '...' }); // build txs, don't broadcast
```

### Batch processing

Shares UTXO state across images so multiple uploads don't double-spend.

```js
const results = await processBatch(['./front.png', './back.png'], {
  walletPath: './wallet.json',
});
```

## CLI

```bash
# Screen only
node scripts/pipe.cjs ./scan.png --no-crop

# Full pipeline with dry-run upload
node scripts/pipe.cjs ./scan.png --wallet ./wallet.json --dry-run

# Full pipeline with real upload
node scripts/pipe.cjs ./scan.png --wallet ./wallet.json

# Batch
node scripts/pipe.cjs ./scan1.png ./scan2.png ./scan3.png --wallet ./wallet.json

# Debug mode (verbose)
node scripts/pipe.cjs ./scan.png --debug
```

## Building references

Place card images in `references/` named by code (`C01.png`, `C02.png`, ..., `S08.png`).

```bash
node scripts/build-refs.cjs
# → refs/first-stage.json (~214KB for 42 cards)
```

The reference DB stores pHash (64-bit) + color histogram (512 bins) per card. No image thumbnails, no SSIM data — that's 98% smaller than the old `refs.json`.

## Testing

```bash
node scripts/test.cjs
```

Tests every module independently:
- `card-phash` — hash computation, Hamming distance, hex roundtrip
- `card-image` — load, resize, grayscale
- `card-validate` — valid image pass, tiny/bad-format reject
- `card-screen` — all 42 cards self-match
- `card-crop` — 5 test scans cropped (contour + hull methods)
- `card-upload` — dry-run tx build
- `card-bind` — dry-run tx build + validation (single txid, duplicates)

## Architecture

```
cardpipe/
  packages/
    card-phash/        # zero deps, pure math
    card-image/        # sharp (Node) / Canvas (browser)
    card-validate/     # depends on: card-image
    card-screen/       # depends on: card-phash + card-image
    card-crop/         # depends on: card-image + opencv-js
    card-upload/       # depends on: bsv
    card-bind/         # depends on: bsv
  orchestrator/        # depends on: all modules
  scripts/
    build-refs.cjs     # build reference DB from card images
    test.cjs           # test all modules
    pipe.cjs           # CLI orchestrator
  refs/
    first-stage.json   # 42 cards, 214KB
```

### Dependency rules

- `card-phash` — **zero dependencies**, copy it anywhere
- `card-image` — the **only** module that touches `sharp` or `Canvas`
- `card-crop` — the **only** module that touches `opencv-js`
- `card-upload` / `card-bind` — the **only** modules that touch `bsv`
- No module imports another except through explicit `package.json` dependencies
- The orchestrator is the **only** place that knows the full pipeline

### Why no SSIM?

The old `cardid-detector` used pHash (60%) + histogram (25%) + SSIM (15%). SSIM required storing a 343×480 grayscale thumbnail per card (base64-encoded, ~165KB each), making `refs.json` 9.4MB.

For screening — "is this a known card?" — pHash + histogram is sufficient. The 214KB payload loads 44× faster and the matching is still 42/42 accurate on self-match. SSIM can be added back as an optional refinement step if needed.

## License

MIT
