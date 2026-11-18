# cardpipe

Modular card processing pipeline. Each module is standalone and composable.

## Modules

| Module | Job | Deps |
|--------|-----|------|
| `card-phash` | DCT-based perceptual hashing (pure math) | none |
| `card-image` | Isomorphic image I/O adapter (sharp/Canvas) | sharp (Node) |
| `card-screen` | Identity matching against reference DB | card-phash + card-image |
| `card-crop` | OpenCV card boundary detection + cropping | card-image + opencv-js |

## Pipeline

```
image → crop → screen → (upload → bind)
```

Each module takes raw pixels (`{ data, width, height, channels }`) via `card-image`.
No module touches sharp or canvas directly except `card-image`.

## Usage

```js
const { cropCard } = require('card-crop');
const { loadRefs, screenCard } = require('card-screen');

const refs = await loadRefs('./refs/first-stage.json');

// Option 1: crop then screen
const { cropped } = await cropCard('./scan.png');
const result = await screenCard(cropped, refs);

// Option 2: screen without crop (faster, less accurate on messy scans)
const result = await screenCard('./scan.png', refs);

console.log(result);
// → { verdict: 'match', code: 'C01', confidence: 0.95 }
```

## Building references

```bash
# Place card images in references/ (C01.png, C02.png, ...)
node scripts/build-refs.cjs
# → refs/first-stage.json (~217KB for 42 cards)
```
