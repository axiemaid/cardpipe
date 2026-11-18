// orchestrator — Pipeline coordinator
//
// Full pipeline:
//   image → validate → crop → screen → upload → bind
//
// Each step is a module call. Short-circuits on failure.
// Steps can be skipped via options.

const { validate } = require('card-validate');
const { cropCard } = require('card-crop');
const { loadRefs, screenCard } = require('card-screen');
const { uploadCard } = require('card-upload');
const { bindCards } = require('card-bind');
const image = require('card-image');
const fs = require('fs');
const path = require('path');

// Refs cache
let _refs = null;
let _refsPath = null;

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
 * @param {string} [opts.walletPath] - path to BSV wallet JSON (for upload/bind)
 * @param {boolean} [opts.skipValidate] - skip quality check
 * @param {boolean} [opts.skipCrop] - skip crop step
 * @param {boolean} [opts.skipUpload] - screen only, no broadcast
 * @param {boolean} [opts.skipBind] - don't create CARDSET
 * @param {boolean} [opts.dryRun] - build txs but don't broadcast
 * @param {Set} [opts.spentOutpoints] - track spent UTXOs across calls
 * @param {string[]} [opts.bindTxids] - additional txids to bind with upload txid
 * @param {boolean} [opts.topResults] - include top-N results
 * @param {boolean} [opts.debug] - verbose logging
 * @returns {Promise<object>}
 */
async function process(input, opts = {}) {
  const steps = [];
  const log = opts.debug ? (...a) => console.log(`  [pipe]`, ...a) : () => {};
  const spentOutpoints = opts.spentOutpoints || new Set();

  // Load refs
  let refs = opts.refs;
  if (!refs) {
    const refsPath = opts.refsPath || path.join(__dirname, '..', 'refs', 'first-stage.json');
    log('loading refs from', refsPath);
    refs = await getRefs(refsPath);
  }
  log(`loaded ${refs.length} references`);

  // ── Step 0: Validate ────────────────────────
  if (!opts.skipValidate) {
    log('step 0: validate');
    const t0 = Date.now();
    const validation = await validate(input);
    steps.push({
      step: 'validate',
      ms: Date.now() - t0,
      passed: validation.passed,
      failures: validation.failures,
      warnings: validation.warnings,
    });

    if (!validation.passed) {
      log(`reject: validation — ${validation.failures.map(f => f.code).join(', ')}`);
      return reject('validate_failed', validation.failures.map(f => f.message).join('; '), steps);
    }

    if (validation.warnings?.length) {
      log(`warnings: ${validation.warnings.map(w => w.code).join(', ')}`);
    }
  } else {
    steps.push({ step: 'validate', skipped: true });
  }

  // ── Step 1: Crop ────────────────────────────
  let cardInput = input;
  if (!opts.skipCrop) {
    log('step 1: crop');
    const t1 = Date.now();
    const crop = await cropCard(input, { debug: opts.debug });
    steps.push({ step: 'crop', ms: Date.now() - t1, ok: !!crop.cropped, reason: crop.reason });

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

  // ── Step 2: Screen ──────────────────────────
  log('step 2: screen');
  const t2 = Date.now();
  const screenOpts = {};
  if (opts.topResults) screenOpts.top = opts.topResults;

  const screen = await screenCard(cardInput, refs, screenOpts);
  steps.push({
    step: 'screen',
    ms: Date.now() - t2,
    verdict: screen.verdict,
    code: screen.code,
    confidence: screen.confidence,
  });

  log(`screen: ${screen.verdict} code=${screen.code} conf=${screen.confidence}`);

  if (screen.verdict === 'no_match') {
    log(`reject: screen — no match`);
    return reject('screen_failed', 'not a known Hyper Battle First Stage card', steps, screen);
  }

  // ── Step 3: Upload ──────────────────────────
  if (opts.skipUpload || !opts.walletPath) {
    log(opts.skipUpload ? 'step 3: upload skipped' : 'step 3: upload skipped (no wallet)');
    steps.push({ step: 'upload', skipped: true });
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
  const t3 = Date.now();

  // Get image bytes for upload
  let imageBytes;
  if (typeof input === 'string' && opts.skipCrop) {
    imageBytes = fs.readFileSync(input);
  } else if (cardInput && cardInput.data) {
    // Raw pixels from crop — encode as PNG
    const sharp = require('sharp');
    const img = cardInput.channels === 3
      ? sharp(cardInput.data, { raw: { width: cardInput.width, height: cardInput.height, channels: 3 } })
      : sharp(cardInput.data, { raw: { width: cardInput.width, height: cardInput.height, channels: 4 } });
    imageBytes = await img.png().toBuffer();
  } else if (Buffer.isBuffer(input)) {
    imageBytes = input;
  } else {
    const sharp = require('sharp');
    const img = cardInput.channels === 3
      ? sharp(cardInput.data, { raw: { width: cardInput.width, height: cardInput.height, channels: 3 } })
      : sharp(cardInput.data, { raw: { width: cardInput.width, height: cardInput.height, channels: 4 } });
    imageBytes = await img.png().toBuffer();
  }

  const upload = await uploadCard(imageBytes, opts.walletPath, { dryRun: opts.dryRun, spentOutpoints });
  steps.push({
    step: 'upload',
    ms: Date.now() - t3,
    txid: upload.txid,
    size: upload.size,
    fee: upload.fee,
    dryRun: opts.dryRun || false,
  });

  log(`upload: txid=${upload.txid || '(dry run)'} size=${upload.size} fee=${upload.fee}`);

  // ── Step 4: Bind ────────────────────────────
  const bindTxids = opts.bindTxids || [];
  if (opts.skipBind || bindTxids.length === 0) {
    if (opts.skipBind) {
      log('step 4: bind skipped');
    } else {
      log('step 4: bind skipped (no bindTxids)');
    }
    steps.push({ step: 'bind', skipped: true });
  } else if (!upload.txid) {
    log('step 4: bind skipped (dry run, no upload txid)');
    steps.push({ step: 'bind', skipped: true, reason: 'dry_run' });
  } else {
    log('step 4: bind');
    const t4 = Date.now();

    // Upload txid goes first (front), then provided txids
    const allTxids = [upload.txid, ...bindTxids];
    const bindResult = await bindCards(allTxids, opts.walletPath, { dryRun: opts.dryRun, spentOutpoints });
    steps.push({
      step: 'bind',
      ms: Date.now() - t4,
      txid: bindResult.txid,
      count: bindResult.count,
      fee: bindResult.fee,
      dryRun: opts.dryRun || false,
    });

    log(`bind: txid=${bindResult.txid || '(dry run)'} count=${bindResult.count} fee=${bindResult.fee}`);

    return {
      accepted: true,
      code: screen.code,
      confidence: screen.confidence,
      verdict: screen.verdict,
      uploadTxid: upload.txid,
      uploadHash: upload.hash,
      bindTxid: bindResult.txid,
      steps,
      ...(screen.results ? { results: screen.results } : {}),
    };
  }

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

function reject(stage, reason, steps, extra = {}) {
  return { accepted: false, rejectedAt: stage, reason, steps, ...extra };
}

/**
 * Batch process multiple images sequentially.
 * Shares spentOutpoints across all images for UTXO continuity.
 */
async function processBatch(inputs, opts = {}) {
  const results = [];
  const spentOutpoints = opts.spentOutpoints || new Set();
  for (const input of inputs) {
    try {
      const result = await process(input, { ...opts, spentOutpoints });
      results.push(result);
    } catch (err) {
      results.push({ accepted: false, rejectedAt: 'error', reason: err.message, steps: [] });
    }
  }
  return results;
}

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
