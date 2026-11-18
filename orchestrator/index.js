// orchestrator — Pipeline coordinator
//
// Wires standalone modules into a processing pipeline.
// Each step is a function call. If any step fails, the pipeline
// short-circuits with a rejection reason. No step knows about
// the next one — the orchestrator decides the flow.
//
// Current pipeline:
//   image → crop → screen → result
//
// Future:
//   image → validate → crop → screen → upload → bind

const { cropCard } = require('card-crop');
const { loadRefs, screenCard } = require('card-screen');
const image = require('card-image');

/**
 * Process a card submission through the pipeline.
 *
 * @param {string|object} input - file path (Node) / Blob (browser) / raw pixels
 * @param {object} opts
 * @param {array} [opts.refs] - pre-loaded reference database
 * @param {string} [opts.refsPath] - path to refs JSON (loaded if opts.refs not provided)
 * @param {boolean} [opts.skipCrop] - skip crop step (faster, less accurate on messy scans)
 * @param {boolean} [opts.topResults] - include top-N match results in output
 * @param {boolean} [opts.debug] - verbose logging
 * @returns {Promise<object>} { accepted, code, confidence, steps, ... }
 */
async function process(input, opts = {}) {
  const steps = [];
  const log = opts.debug ? (...a) => console.log(`  [pipe]`, ...a) : () => {};

  // Load refs if not provided
  let refs = opts.refs;
  if (!refs) {
    const refsPath = opts.refsPath || require('path').join(__dirname, '..', 'refs', 'first-stage.json');
    log('loading refs from', refsPath);
    refs = await loadRefs(refsPath);
  }
  log(`loaded ${refs.length} references`);

  // Step 1: Crop (optional)
  let cardImage = input;
  if (!opts.skipCrop) {
    log('step 1: crop');
    const t0 = Date.now();
    const crop = await cropCard(input, { debug: opts.debug });
    steps.push({ step: 'crop', ms: Date.now() - t0, ok: !!crop.cropped, reason: crop.reason });

    if (!crop.cropped) {
      log(`reject: crop failed — ${crop.reason}`);
      return reject('crop_failed', crop.reason, steps);
    }

    cardImage = crop.cropped;
    steps[steps.length - 1].size = `${crop.cropped.width}×${crop.cropped.height}`;
    steps[steps.length - 1].method = crop.method;
    log(`cropped: ${crop.cropped.width}×${crop.cropped.height} (${crop.method})`);
  } else {
    log('step 1: crop skipped');
    steps.push({ step: 'crop', skipped: true });
  }

  // Step 2: Screen
  log('step 2: screen');
  const t1 = Date.now();
  const screenOpts = {};
  if (opts.topResults) screenOpts.top = opts.topResults;

  const screen = await screenCard(cardImage, refs, screenOpts);
  steps.push({
    step: 'screen',
    ms: Date.now() - t1,
    verdict: screen.verdict,
    code: screen.code,
    confidence: screen.confidence,
  });

  log(`screen: ${screen.verdict} code=${screen.code} conf=${screen.confidence}`);

  // Gate: only accept match or likely
  if (screen.verdict === 'no_match') {
    log(`reject: screen — no match`);
    return reject('screen_failed', 'not a known Hyper Battle First Stage card', steps, screen);
  }

  // Success
  return {
    accepted: true,
    code: screen.code,
    confidence: screen.confidence,
    verdict: screen.verdict,
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
 * Batch process multiple images.
 * Processes sequentially to avoid memory spikes on large images.
 *
 * @param {array} inputs - array of file paths / Blobs / raw pixels
 * @param {object} opts - same as process()
 * @returns {Promise<array>} results in same order as inputs
 */
async function processBatch(inputs, opts = {}) {
  const results = [];
  for (const input of inputs) {
    try {
      const result = await process(input, opts);
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

module.exports = {
  process,
  processBatch,
  reject,
};
