// card-screen — Lightweight card identity screener
//
// Takes an image (raw pixels via card-image), computes pHash + color histogram,
// compares against a reference database, returns a verdict.
//
// No OpenCV. No SSIM. No cropping. ~217KB reference payload for 42 cards.
//
// Usage:
//   const { loadRefs, screenCard } = require('card-screen');
//   const refs = await loadRefs('./refs/first-stage.json');
//   const result = await screenCard(imageInput, refs);
//   // → { verdict: 'match'|'likely'|'no_match', code: 'C01'|null, confidence: 0.95 }

const { phash, hammingDistance, hexToHash } = require('card-phash');
const image = require('card-image');

// Standard comparison dimensions
const STD_WIDTH = 343;
const STD_HEIGHT = 480;
const PHASH_SIZE = 32;

// Scoring weights
const W_PHASH = 0.75;
const W_HIST = 0.25;

// Verdict thresholds
const CONFIDENT_HAMMING = 6;
const LIKELY_HAMMING = 12;
const NO_MATCH_HAMMING = 18;
const SCORE_MARGIN = 0.05;
const MIN_CONFIDENT_SCORE = 0.75;

// Histogram config
const HIST_BINS = 8;
const HIST_SHIFT = 5;

/**
 * Load a reference database from a JSON file (Node) or parsed object.
 * @param {string|object} source - file path or pre-parsed object
 * @returns {Promise<array>} normalized reference array
 */
async function loadRefs(source) {
  let data;
  if (typeof source === 'string') {
    const fs = require('fs');
    data = JSON.parse(fs.readFileSync(source, 'utf8'));
  } else {
    data = source;
  }

  // Accept { cards: [...] } or [...] format
  const cards = Array.isArray(data) ? data : (data.cards || []);
  return cards;
}

/**
 * Normalize an image for matching:
 *   resize → RGB pixels → grayscale for pHash
 * @param {object|string} input - card-image compatible input (path/Blob) or raw pixels
 * @returns {Promise<{rgb: Uint8Array, gray32: Uint8Array, hash: bigint}>}
 */
async function normalize(input) {
  // If input is already raw pixels ({data, width, height, channels}), use directly
  let img;
  if (input && input.data && input.width && input.height) {
    img = input;
  } else {
    img = await image.loadImage(input);
  }

  // Resize to standard dimensions
  const resized = await image.resize(img, STD_WIDTH, STD_HEIGHT);
  const rgb = image.toRGB(resized);

  // 32×32 grayscale for pHash
  const gray32Img = await image.resize(img, PHASH_SIZE, PHASH_SIZE);
  const gray32 = image.toGrayscale(gray32Img);

  // Compute pHash
  const hash = phash(gray32, PHASH_SIZE, PHASH_SIZE);

  return { rgb, gray32, hash, width: STD_WIDTH, height: STD_HEIGHT };
}

/**
 * Compute color histogram from RGB pixels.
 * 8 bins per channel → 512 bins total.
 * @param {Uint8Array} rgb - RGB pixel data
 * @returns {Float32Array} 512 normalized probabilities
 */
function computeHistogram(rgb) {
  const numBins = HIST_BINS * HIST_BINS * HIST_BINS;
  const hist = new Float32Array(numBins);
  const pixels = rgb.length / 3;

  for (let i = 0; i < pixels; i++) {
    hist[(rgb[i * 3] >> HIST_SHIFT) * HIST_BINS * HIST_BINS + (rgb[i * 3 + 1] >> HIST_SHIFT) * HIST_BINS + (rgb[i * 3 + 2] >> HIST_SHIFT)]++;
  }

  for (let i = 0; i < numBins; i++) {
    hist[i] /= pixels;
  }

  return hist;
}

/**
 * Bhattacharyya coefficient between input RGB pixels and precomputed histogram.
 * @param {Uint8Array} rgb - input RGB pixels
 * @param {Float32Array|number[]} refHist - 512-bin reference histogram
 * @returns {number} 0-1 (1 = identical color distribution)
 */
function histSimilarity(rgb, refHist) {
  const numBins = HIST_BINS * HIST_BINS * HIST_BINS;
  const histA = new Float64Array(numBins);
  const pixels = rgb.length / 3;

  for (let i = 0; i < pixels; i++) {
    histA[(rgb[i * 3] >> HIST_SHIFT) * HIST_BINS * HIST_BINS + (rgb[i * 3 + 1] >> HIST_SHIFT) * HIST_BINS + (rgb[i * 3 + 2] >> HIST_SHIFT)]++;
  }

  let bc = 0;
  for (let i = 0; i < numBins; i++) {
    bc += Math.sqrt((histA[i] / pixels) * refHist[i]);
  }

  return bc;
}

/**
 * Build the reference database from raw image files.
 * Run once, save output as refs.json.
 * @param {string} refDir - directory with C01.png, C02.png, etc.
 * @returns {Promise<array>} [{ code, hashHex, histogram }]
 */
async function buildRefs(refDir) {
  const fs = require('fs');
  const path = require('path');
  const { hashToHex } = require('card-phash');

  const files = fs.readdirSync(refDir).filter(f => /\.(png|jpg|jpeg|webp|bmp)$/i.test(f));
  const refs = [];

  for (const file of files) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    const code = base.toUpperCase();
    const fullPath = path.join(refDir, file);

    const norm = await normalize(fullPath);
    const histogram = computeHistogram(norm.rgb);

    refs.push({
      code,
      hashHex: hashToHex(norm.hash),
      histogram: Array.from(histogram),
    });
  }

  return refs;
}

/**
 * Match normalized input against reference database.
 * @param {object} inputNorm - result of normalize()
 * @param {array} refs - reference array from loadRefs()
 * @returns {array} sorted results (best first)
 */
function matchAgainstRefs(inputNorm, refs) {
  const byCode = {};

  for (const ref of refs) {
    const refHash = hexToHash(ref.hashHex);
    const hamming = hammingDistance(inputNorm.hash, refHash);
    const hist = histSimilarity(inputNorm.rgb, ref.histogram);
    const phashScore = Math.max(0, 1 - hamming / 24);
    const score = phashScore * W_PHASH + hist * W_HIST;

    const entry = {
      code: ref.code,
      hamming,
      hist: Math.round(hist * 1000) / 1000,
      score: Math.round(score * 1000) / 1000,
    };

    if (!byCode[ref.code] || hamming < byCode[ref.code].hamming) {
      byCode[ref.code] = entry;
    }
  }

  const results = Object.values(byCode);
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Determine verdict from match results.
 * @param {array} results - sorted match results
 * @returns {{ verdict: string, code: string|null, confidence: number }}
 */
function getVerdict(results) {
  if (!results.length) {
    return { verdict: 'no_match', code: null, confidence: 0 };
  }

  const best = results[0];
  const second = results[1];
  const margin = second ? best.score - second.score : 1.0;
  const confidence = best.score;

  // No match: hamming too high or score too low
  if (best.hamming > NO_MATCH_HAMMING || best.score < MIN_CONFIDENT_SCORE) {
    return { verdict: 'no_match', code: best.code, confidence };
  }

  // Confident: low hamming AND good margin
  if (best.hamming <= CONFIDENT_HAMMING && margin >= SCORE_MARGIN) {
    return { verdict: 'match', code: best.code, confidence };
  }

  // Likely: moderate hamming with good histogram
  if (best.hamming <= LIKELY_HAMMING && best.hist > 0.9) {
    return { verdict: 'likely', code: best.code, confidence };
  }

  return { verdict: 'no_match', code: best.code, confidence };
}

/**
 * Full screening pipeline: image → normalize → match → verdict
 * @param {object|string} input - file path (Node) / Blob (browser) / raw pixels
 * @param {array} refs - reference database from loadRefs()
 * @param {object} [opts] - { top: N } to include top-N results
 * @returns {Promise<{ verdict, code, confidence, results? }>}
 */
async function screenCard(input, refs, opts = {}) {
  const norm = await normalize(input);
  const results = matchAgainstRefs(norm, refs);
  const verdict = getVerdict(results);

  const output = {
    verdict: verdict.verdict,
    code: verdict.code,
    confidence: verdict.confidence,
  };

  if (opts.top) {
    output.results = results.slice(0, opts.top);
  }

  return output;
}

module.exports = {
  loadRefs,
  normalize,
  computeHistogram,
  histSimilarity,
  buildRefs,
  matchAgainstRefs,
  getVerdict,
  screenCard,
  STD_WIDTH,
  STD_HEIGHT,
  W_PHASH,
  W_HIST,
  CONFIDENT_HAMMING,
  LIKELY_HAMMING,
  NO_MATCH_HAMMING,
  SCORE_MARGIN,
  MIN_CONFIDENT_SCORE,
};
