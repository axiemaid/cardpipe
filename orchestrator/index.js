// orchestrator — Pipeline coordinator
//
// Wires standalone modules into a processing pipeline.
// Each step is a function call. If any step fails, the pipeline
// short-circuits with a rejection reason. No step knows about
// the next one — the orchestrator decides the flow.
//
// Pipeline:
//   image → crop → screen → upload
//
// Options:
//   skipCrop  — skip crop step (for clean pre-cropped inputs)
//   skipUpload — screen only, no on-chain broadcast
//   dryRun    — build tx but don't broadcast
//   walletPath — required for upload step

const { cropCard } = require('card-crop');
const { loadRefs, screenCard } = require('card-screen');
const { uploadCard } = require('card-upload');
const image = require('card-image');
const fs = require('fs');
const path = require('path');

// Refs cache — loaded once, reused across calls
let _refs = null;
let _refsPath = null;

/**
 * Get cached refs, loading from path if needed.
 */
async function getRefs(refsPath) {
  if (_refs && _refsPath === refsPath) return _refs;
  _refs = await loadRefs(refsPath);
  _refsPath = refsPath;
  return _refs;
}

/**
 * Process a card submission through the full pipeline.
 *
 * @param {string|object} input - file path / Blob / raw pixels
 * @param {object} opts
 * @param {array} [opts.refs] - pre-loaded reference database
 * @param {string} [opts.refsPath] - path to refs JSON
 * @param {string} [opts.walletPath] - path to BSV wallet JSON (required for upload)
 * @param {boolean} [opts.skipCrop] - skip crop step
 * @param {boolean} [opts.skipUpload] - screen only, no broadcast
 * @param {boolean} [opts.dryRun] - build tx but don't broadcast
 * @param {Set} [opts.spentOutpoints] - track spent UTXOs across calls
 * @param {boolean} [opts.topResults] - include top-N results
 * @param {boolean} [opts.debug] - verbose logging
 * @returns {Promise<object>}
 */
async function process(input, opts = {}) {
  const steps = [];
  const log = opts.debug ? (...a) => console.log(`  [pipe]`, ...a) : () => {};

  // Load refs
  let refs = opts.refs;
  if (!refs) {
    const refsPath = opts.refsPath || path.join(__dirname, '..', 'refs', 'first-stage.json');
    log('loading refs from', refsPath);
    refs = await getRefs(refsPath);
  }
  log(`loaded ${refs.length} references`);

  // ── Step 1: Crop ──────────────────────────────
  let cardInput = input;
  if (!opts.skipCrop) {
    log('step 1: crop');
    const t0 = Date.now();
    const crop = await cropCard(input, { debug: opts.debug });
    steps.push({ step: 'crop', ms: Date.now() - t0, ok: !!crop.cropped, reason: crop.reason });

    if (!crop.cropped) {
      log(`reject: crop failed — ${crop.reason}`);
      return reject('crop_failed', crop.reason, steps);
    }

    cardInput = crop.cropped;
    steps[steps.length - 1].size = `${crop.cropped.width}×${crop.cropped.height}`;
    steps[steps.length - 1].method = crop.method;
    log(`cropped: ${crop.cropped.width}×${crop.cropped.height} (${crop.method})`);
  } else {
    log('step 1: crop skipped');
    steps.push({ step: 'crop', skipped: true });
  }

  // ── Step 2: Screen ────────────────────────────
  log('step 2: screen');
  const t1 = Date.now();
  const screenOpts = {};
  if (opts.topResults) screenOpts.top = opts.topResults;

  const screen = await screenCard(cardInput, refs, screenOpts);
  steps.push({
    step: 'screen',
    ms: Date.now() - t1,
    verdict: screen.verdict,
    code: screen.code,
    confidence: screen.confidence,
  });

  log(`screen: ${screen.verdict} code=${screen.code} conf=${screen.confidence}`);

  if (screen.verdict === 'no_match') {
    log(`reject: screen — no match`);
    return reject('screen_failed', 'not a known Hyper Battle First Stage card', steps, screen);
  }

  // ── Step 3: Upload ────────────────────────────
  if (opts.skipUpload || !opts.walletPath) {
    if (opts.skipUpload) {
      log('step 3: upload skipped');
      steps.push({ step: 'upload', skipped: true });
    } else {
      log('step 3: upload skipped (no walletPath)');
      steps.push({ step: 'upload', skipped: true, reason: 'no_wallet' });
    }

    return {
      accepted: true,
      code: screen.code,
      confidence: screen.confidence,
      verdict: screen.verdict,
      steps,
      ...(screen.results ? { results: screen.results } : {}),
    };
  }

  log('step 3: upload');
  const t2 = Date.now();

  // Get image bytes for upload — if we cropped, we need the raw pixels as a Buffer
  // If input was a file path and we didn't crop, read directly
  // If we cropped, cardInput is { data, width, height, channels } — need to encode
  let imageBytes;
  if (typeof input === 'string' && opts.skipCrop) {
    // File path, no crop — upload the original file
    imageBytes = fs.readFileSync(input);
  } else if (cardInput && cardInput.data) {
    // Raw pixels from crop — encode as PNG via card-image (sharp)
    const sharp = require('sharp');
    const img = cardInput.channels === 3
      ? sharp(cardInput.data, { raw: { width: cardInput.width, height: cardInput.height, channels: 3 } })
      : sharp(cardInput.data, { raw: { width: cardInput.width, height: cardInput.height, channels: 4 } });
    imageBytes = await img.png().toBuffer();
  } else if (Buffer.isBuffer(input)) {
    imageBytes = input;
  } else {
    // File path with crop — read original, but we cropped it
    // Re-crop to get a buffer
    const sharp = require('sharp');
    const img = cardInput.channels === 3
      ? sharp(cardInput.data, { raw: { width: cardInput.width, height: cardInput.height, channels: 3 } })
      : sharp(cardInput.data, { raw: { width: cardInput.width, height: cardInput.height, channels: 4 } });
    imageBytes = await img.png().toBuffer();
  }

  const uploadOpts = {
    dryRun: opts.dryRun,
    spentOutpoints: opts.spentOutpoints || new Set(),
  };

  const upload = await uploadCard(imageBytes, opts.walletPath, uploadOpts);
  steps.push({
    step: 'upload',
    ms: Date.now() - t2,
    txid: upload.txid,
    size: upload.size,
    fee: upload.fee,
    dryRun: opts.dryRun || false,
  });

  log(`upload: txid=${upload.txid || '(dry run)'} size=${upload.size} fee=${upload.fee}`);

  return {
    accepted: true,
    code: screen.code,
    confidence: screen.confidence,
    verdict: screen.verdict,
    txid: upload.txid,
    hash: upload.hash,
    size: upload.size,
    fee: upload.fee,
    steps,
    ...(screen.results ? { results: screen.results } : {}),
  };
}

/**
 * Build a rejection result.
 */
function reject(stage, reason, steps, extra = {}) {
  return {
    accepted: false,
    rejectedAt: stage,
    reason,
    steps,
    ...extra,
  };
}

/**
 * Batch process multiple images sequentially.
 * @param {array} inputs
 * @param {object} opts - same as process()
 * @returns {Promise<array>}
 */
async function processBatch(inputs, opts = {}) {
  const results = [];
  const spentOutpoints = opts.spentOutpoints || new Set();
  for (const input of inputs) {
    try {
      const result = await process(input, { ...opts, spentOutpoints });
      results.push(result);
    } catch (err) {
      results.push({
        accepted: false,
        rejectedAt: 'error',
        reason: err.message,
        steps: [],
      });
    }
  }
  return results;
}

/**
 * Clear cached refs (force reload on next process call).
 */
function clearCache() {
  _refs = null;
  _refsPath = null;
}

module.exports = {
  process,
  processBatch,
  reject,
  clearCache,
};
