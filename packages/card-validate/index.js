// card-validate — Scan quality gate
//
// Checks that an image is a valid card scan before it enters the pipeline.
// Lightweight: format, resolution, file size, aspect ratio, saturation.
// No OpenCV — that's card-crop's job. This is the fast pre-filter.
//
// Usage:
//   const { validate } = require('card-validate');
//   const result = await validate('./scan.png');
//   // → { passed: true, warnings: [] }
//   // → { passed: false, failures: ['E_SIZE', 'E_FORMAT'] }

const image = require('card-image');

// ── Constants ───────────────────────────────────────────────

const MIN_BYTES = 50 * 1024;          // 50KB
const MIN_SHORT_SIDE = 400;            // px
const MAX_LONG_SIDE = 6000;            // px
const TARGET_RATIO = 2.5 / 3.5;        // Pokemon card (portrait)
const RATIO_TOLERANCE = 0.20;          // 20% — generous, crop will refine
const MIN_SATURATION = 0.08;           // filter translucent sleeves / blank scans

// ── Format detection ────────────────────────────────────────

function detectFormat(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

// ── Checks ──────────────────────────────────────────────────

/**
 * Check file size and format from raw bytes.
 */
function checkFile(buf) {
  const failures = [];
  if (!buf || buf.length === 0) {
    failures.push({ code: 'E_EMPTY', message: 'Empty file' });
    return { valid: false, failures, format: null };
  }
  if (buf.length < MIN_BYTES) {
    failures.push({ code: 'E_SIZE', message: `File too small: ${(buf.length / 1024).toFixed(1)} KB (min ${MIN_BYTES / 1024} KB)` });
  }
  const format = detectFormat(buf);
  if (!format) {
    failures.push({ code: 'E_FORMAT', message: 'Unrecognized format (must be JPEG, PNG, or WebP)' });
  }
  return { valid: failures.length === 0, failures, format };
}

/**
 * Check image dimensions and aspect ratio.
 */
function checkDimensions(width, height) {
  const failures = [];
  const warnings = [];

  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);

  if (shortSide < MIN_SHORT_SIDE) {
    failures.push({ code: 'E_RESOLUTION', message: `Resolution too low: ${width}×${height} (min short side ${MIN_SHORT_SIDE}px)` });
  }
  if (longSide > MAX_LONG_SIDE) {
    warnings.push({ code: 'W_LARGE', message: `Very large image: ${width}×${height} — may be slow` });
  }

  // Aspect ratio check — card should be roughly portrait 2.5:3.5
  // Allow landscape (rotated) — just check the ratio of sides
  const ratio = shortSide / longSide;
  const ratioOff = Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO;
  if (ratioOff > RATIO_TOLERANCE) {
    failures.push({ code: 'E_ASPECT', message: `Aspect ratio ${ratio.toFixed(3)} too far from card ratio ${TARGET_RATIO.toFixed(3)} (tolerance ${RATIO_TOLERANCE * 100}%)` });
  }

  return { failures, warnings };
}

/**
 * Check average saturation — filters out blank/translucent sleeve scans
 * that are mostly gray/white pixels.
 */
function checkSaturation(img) {
  const warnings = [];
  const pixels = img.width * img.height;
  const data = img.data;
  const ch = img.channels;

  let satSum = 0;
  for (let i = 0; i < pixels; i++) {
    const idx = i * ch;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    satSum += sat;
  }

  const avgSat = satSum / pixels;
  if (avgSat < MIN_SATURATION) {
    warnings.push({ code: 'W_LOW_SATURATION', message: `Low saturation (${(avgSat * 100).toFixed(1)}%) — may be a blank scan or translucent sleeve` });
  }

  return { warnings, avgSat };
}

// ── Main entry point ────────────────────────────────────────

/**
 * Validate a card scan image.
 *
 * @param {string|object|Buffer} input - file path / Blob / raw pixels / Buffer
 * @returns {Promise<{ passed: boolean, failures: array, warnings: array, format?: string, width?: number, height?: number }>}
 */
async function validate(input) {
  const failures = [];
  const warnings = [];

  // If it's a Buffer (raw file bytes), check file header
  if (Buffer.isBuffer(input) || (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer)) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const fileCheck = checkFile(buf);
    if (!fileCheck.valid) return { passed: false, failures: fileCheck.failures, warnings };
    // Load image for dimension/saturation checks
    try {
      const img = await image.loadImage(buf);
      const dimCheck = checkDimensions(img.width, img.height);
      failures.push(...dimCheck.failures);
      warnings.push(...dimCheck.warnings);
      const satCheck = checkSaturation(img);
      warnings.push(...satCheck.warnings);
      return { passed: failures.length === 0, failures, warnings, format: fileCheck.format, width: img.width, height: img.height, avgSaturation: satCheck.avgSat };
    } catch (e) {
      failures.push({ code: 'E_DECODE', message: 'Could not decode image: ' + e.message });
      return { passed: false, failures, warnings };
    }
  }

  // Raw pixels already decoded
  if (input && input.data && input.width && input.height) {
    const dimCheck = checkDimensions(input.width, input.height);
    failures.push(...dimCheck.failures);
    warnings.push(...dimCheck.warnings);
    const satCheck = checkSaturation(input);
    warnings.push(...satCheck.warnings);
    return { passed: failures.length === 0, failures, warnings, width: input.width, height: input.height, avgSaturation: satCheck.avgSat };
  }

  // File path (Node) or Blob (browser) — load via card-image
  try {
    const img = await image.loadImage(input);
    const dimCheck = checkDimensions(img.width, img.height);
    failures.push(...dimCheck.failures);
    warnings.push(...dimCheck.warnings);
    const satCheck = checkSaturation(img);
    warnings.push(...satCheck.warnings);

    // If input is a file path, also check file size
    if (typeof input === 'string') {
      const fs = require('fs');
      const buf = fs.readFileSync(input);
      const fileCheck = checkFile(buf);
      if (!fileCheck.valid) {
        failures.push(...fileCheck.failures);
      }
      return { passed: failures.length === 0, failures, warnings, format: fileCheck.format, width: img.width, height: img.height, avgSaturation: satCheck.avgSat };
    }

    return { passed: failures.length === 0, failures, warnings, width: img.width, height: img.height, avgSaturation: satCheck.avgSat };
  } catch (e) {
    failures.push({ code: 'E_DECODE', message: 'Could not load image: ' + e.message });
    return { passed: false, failures, warnings };
  }
}

module.exports = {
  validate,
  checkFile,
  checkDimensions,
  checkSaturation,
  detectFormat,
  MIN_BYTES,
  MIN_SHORT_SIDE,
  MAX_LONG_SIDE,
  TARGET_RATIO,
  RATIO_TOLERANCE,
  MIN_SATURATION,
};
