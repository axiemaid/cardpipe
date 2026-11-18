// cardpipe frontend — client-side card screener
//
// Runs validate + screen entirely in the browser.
// pHash is pure math (inlined). Image I/O uses Canvas.
// Reference DB loaded from refs/first-stage.json.

(() => {
  'use strict';

  // ── Constants ────────────────────────────────────────

  const STD_WIDTH = 343;
  const STD_HEIGHT = 480;
  const PHASH_SIZE = 32;
  const W_PHASH = 0.75;
  const W_HIST = 0.25;
  const HIST_BINS = 8;
  const HIST_SHIFT = 5;

  // Validate constants
  const MIN_BYTES = 50 * 1024;
  const MIN_SHORT_SIDE = 400;
  const MAX_LONG_SIDE = 6000;
  const TARGET_RATIO = 2.5 / 3.5;
  const RATIO_TOLERANCE = 0.20;
  const MIN_SATURATION = 0.08;

  // ── pHash (pure math, from card-phash) ───────────────

  function dct1d(input) {
    const n = input.length;
    const output = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += input[i] * Math.cos((Math.PI / n) * (i + 0.5) * k);
      output[k] = sum;
    }
    return output;
  }

  function dct2d(data, width, height) {
    const temp = new Float64Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = new Float64Array(width);
      for (let x = 0; x < width; x++) row[x] = data[y * width + x];
      const dctRow = dct1d(row);
      for (let x = 0; x < width; x++) temp[y * width + x] = dctRow[x];
    }
    const result = new Float64Array(width * height);
    for (let x = 0; x < width; x++) {
      const col = new Float64Array(height);
      for (let y = 0; y < height; y++) col[y] = temp[y * width + x];
      const dctCol = dct1d(col);
      for (let y = 0; y < height; y++) result[y * width + x] = dctCol[y];
    }
    return result;
  }

  function phash(grayData, width, height) {
    const dct = dct2d(grayData, width, height);
    const values = [];
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++)
        values.push(dct[y * width + x]);
    const sorted = values.slice(1).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let hash = 0n;
    for (let i = 0; i < values.length; i++)
      if (values[i] > median) hash |= (1n << BigInt(i));
    return hash;
  }

  function hammingDistance(a, b) {
    let x = a ^ b, count = 0;
    while (x > 0n) { count += Number(x & 1n); x >>= 1n; }
    return count;
  }

  function hexToHash(hex) { return BigInt('0x' + hex); }

  // ── Image I/O (Canvas) ───────────────────────────────

  async function loadImage(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bitmap.close();
    return { data: new Uint8Array(imageData.data), width: imageData.width, height: imageData.height, channels: 4 };
  }

  async function resizeImage(img, targetW, targetH) {
    const srcCanvas = new OffscreenCanvas(img.width, img.height);
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const dstCanvas = new OffscreenCanvas(targetW, targetH);
    const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
    dstCtx.drawImage(srcCanvas, 0, 0, targetW, targetH);
    const result = dstCtx.getImageData(0, 0, targetW, targetH);
    return { data: new Uint8Array(result.data), width: targetW, height: targetH, channels: 4 };
  }

  function toGrayscale(img) {
    const pixels = img.width * img.height;
    const gray = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
      const idx = i * img.channels;
      gray[i] = Math.round(0.299 * img.data[idx] + 0.587 * img.data[idx + 1] + 0.114 * img.data[idx + 2]);
    }
    return gray;
  }

  function toRGB(img) {
    const pixels = img.width * img.height;
    const rgb = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      rgb[i * 3] = img.data[i * img.channels];
      rgb[i * 3 + 1] = img.data[i * img.channels + 1];
      rgb[i * 3 + 2] = img.data[i * img.channels + 2];
    }
    return rgb;
  }

  // ── Validate ─────────────────────────────────────────

  function detectFormat(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
    return null;
  }

  function validateImage(img, fileSize) {
    const failures = [];
    const warnings = [];

    if (fileSize < MIN_BYTES) {
      failures.push({ code: 'E_SIZE', message: `File too small: ${(fileSize / 1024).toFixed(1)} KB (min 50 KB)` });
    }

    const format = detectFormat(new Uint8Array(img.data.buffer || img.data));
    if (!format && failures.length === 0) {
      // Can't detect from raw pixels — skip format check if we already decoded
    }

    const shortSide = Math.min(img.width, img.height);
    const longSide = Math.max(img.width, img.height);

    if (shortSide < MIN_SHORT_SIDE) {
      failures.push({ code: 'E_RESOLUTION', message: `Resolution too low: ${img.width}×${img.height}` });
    }
    if (longSide > MAX_LONG_SIDE) {
      warnings.push({ code: 'W_LARGE', message: 'Very large image' });
    }

    const ratio = shortSide / longSide;
    const ratioOff = Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO;
    if (ratioOff > RATIO_TOLERANCE) {
      failures.push({ code: 'E_ASPECT', message: `Aspect ratio ${ratio.toFixed(3)} too far from card ratio` });
    }

    // Saturation check
    const pixels = img.width * img.height;
    let satSum = 0;
    for (let i = 0; i < pixels; i++) {
      const idx = i * img.channels;
      const r = img.data[idx], g = img.data[idx + 1], b = img.data[idx + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      satSum += max === 0 ? 0 : (max - min) / max;
    }
    const avgSat = satSum / pixels;
    if (avgSat < MIN_SATURATION) {
      warnings.push({ code: 'W_LOW_SATURATION', message: 'Low saturation — may be blank or translucent sleeve' });
    }

    return { passed: failures.length === 0, failures, warnings, avgSaturation: avgSat };
  }

  // ── Screen ───────────────────────────────────────────

  function computeHistogram(rgb) {
    const numBins = HIST_BINS * HIST_BINS * HIST_BINS;
    const hist = new Float32Array(numBins);
    const pixels = rgb.length / 3;
    for (let i = 0; i < pixels; i++) {
      hist[(rgb[i * 3] >> HIST_SHIFT) * HIST_BINS * HIST_BINS + (rgb[i * 3 + 1] >> HIST_SHIFT) * HIST_BINS + (rgb[i * 3 + 2] >> HIST_SHIFT)]++;
    }
    for (let i = 0; i < numBins; i++) hist[i] /= pixels;
    return hist;
  }

  function histSimilarity(rgb, refHist) {
    const numBins = HIST_BINS * HIST_BINS * HIST_BINS;
    const histA = new Float64Array(numBins);
    const pixels = rgb.length / 3;
    for (let i = 0; i < pixels; i++) {
      histA[(rgb[i * 3] >> HIST_SHIFT) * HIST_BINS * HIST_BINS + (rgb[i * 3 + 1] >> HIST_SHIFT) * HIST_BINS + (rgb[i * 3 + 2] >> HIST_SHIFT)]++;
    }
    let bc = 0;
    for (let i = 0; i < numBins; i++) bc += Math.sqrt((histA[i] / pixels) * refHist[i]);
    return bc;
  }

  async function screenCard(img, refs) {
    const resized = await resizeImage(img, STD_WIDTH, STD_HEIGHT);
    const rgb = toRGB(resized);

    const gray32Img = await resizeImage(img, PHASH_SIZE, PHASH_SIZE);
    const gray32 = toGrayscale(gray32Img);
    const hash = phash(gray32, PHASH_SIZE, PHASH_SIZE);

    const byCode = {};
    for (const ref of refs) {
      const refHash = hexToHash(ref.hashHex);
      const hamming = hammingDistance(hash, refHash);
      const hist = histSimilarity(rgb, ref.histogram);
      const phashScore = Math.max(0, 1 - hamming / 24);
      const score = phashScore * W_PHASH + hist * W_HIST;

      if (!byCode[ref.code] || hamming < byCode[ref.code].hamming) {
        byCode[ref.code] = { code: ref.code, hamming, hist: Math.round(hist * 1000) / 1000, score: Math.round(score * 1000) / 1000 };
      }
    }

    const results = Object.values(byCode).sort((a, b) => b.score - a.score);
    const best = results[0];
    const second = results[1];
    const margin = second ? best.score - second.score : 1.0;

    let verdict, code;
    if (best.hamming > 18 || best.score < 0.75) {
      verdict = 'no_match'; code = best.code;
    } else if (best.hamming <= 6 && margin >= 0.05) {
      verdict = 'match'; code = best.code;
    } else if (best.hamming <= 12 && best.hist > 0.9) {
      verdict = 'likely'; code = best.code;
    } else {
      verdict = 'no_match'; code = best.code;
    }

    return { verdict, code, confidence: best.score, results: results.slice(0, 5) };
  }

  // ── UI ───────────────────────────────────────────────

  let refs = null;
  let stats = { total: 0, match: 0, reject: 0, totalTime: 0 };

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const resultsEl = document.getElementById('results');
  const statsEl = document.getElementById('stats');

  // Load refs
  async function loadRefs() {
    try {
      const res = await fetch('refs/first-stage.json');
      if (!res.ok) throw new Error('Failed to load refs');
      const data = await res.json();
      refs = data.cards || data;
      console.log(`Loaded ${refs.length} references`);
    } catch (e) {
      console.error('Failed to load refs:', e);
      dropzone.querySelector('p').textContent = 'Error: could not load reference database';
    }
  }
  loadRefs();

  // Drag & drop
  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    fileInput.value = '';
  });

  async function handleFiles(files) {
    if (!refs) {
      console.warn('Refs not loaded yet');
      return;
    }

    for (const file of files) {
      await processFile(file);
    }
    updateStats();
  }

  async function processFile(file) {
    const startTime = performance.now();
    statsEl.hidden = false;
    resultsEl.hidden = false;

    // Create placeholder card
    const cardEl = document.createElement('div');
    cardEl.className = 'result-card';
    cardEl.innerHTML = `
      <div class="result-processing"><div class="spinner"></div> Processing ${escapeHtml(file.name)}...</div>
    `;
    resultsEl.prepend(cardEl);

    try {
      // Load image
      const img = await loadImage(file);

      // Validate
      const validation = validateImage(img, file.size);
      if (!validation.passed) {
        renderResult(cardEl, file, img, {
          verdict: 'reject',
          reason: validation.failures.map(f => f.message).join('; '),
          elapsed: performance.now() - startTime,
        });
        stats.total++;
        stats.reject++;
        stats.totalTime += performance.now() - startTime;
        return;
      }

      // Screen
      const screen = await screenCard(img, refs);
      const elapsed = performance.now() - startTime;

      renderResult(cardEl, file, img, {
        ...screen,
        warnings: validation.warnings,
        elapsed,
      });

      stats.total++;
      if (screen.verdict === 'match' || screen.verdict === 'likely') {
        stats.match++;
      } else {
        stats.reject++;
      }
      stats.totalTime += elapsed;

    } catch (e) {
      renderResult(cardEl, file, null, {
        verdict: 'error',
        reason: e.message,
        elapsed: performance.now() - startTime,
      });
      stats.total++;
      stats.reject++;
      stats.totalTime += performance.now() - startTime;
    }
  }

  function renderResult(cardEl, file, img, result) {
    const thumb = img ? createThumb(img) : '';
    const verdictLabels = { match: 'Match', likely: 'Likely', reject: 'Rejected', error: 'Error' };

    let badgeClass = 'badge-reject';
    let barClass = 'bar-reject';
    let barWidth = result.confidence ? Math.round(result.confidence * 100) : 0;

    if (result.verdict === 'match') { badgeClass = 'badge-match'; barClass = 'bar-match'; }
    else if (result.verdict === 'likely') { badgeClass = 'badge-likely'; barClass = 'bar-likely'; }
    else if (result.verdict === 'error') { badgeClass = 'badge-error'; barWidth = 0; }

    let details = '';
    if (result.verdict === 'match' || result.verdict === 'likely') {
      details = `<div>Confidence: <strong>${Math.round((result.confidence || 0) * 100)}%</strong></div>`;
      if (result.results && result.results.length > 1) {
        details += `<div style="margin-top:4px;font-size:11px;color:#555">2nd: ${result.results[1].code} (${Math.round(result.results[1].score * 100)}%)</div>`;
      }
    } else if (result.verdict === 'reject') {
      details = `<div>${escapeHtml(result.reason || 'Not a known Hyper Battle First Stage card')}</div>`;
      if (result.code) {
        const best = result.results?.[0];
        if (best) details += `<div style="margin-top:2px">Closest: ${best.code} (${Math.round(best.score * 100)}%, hamming=${best.hamming})</div>`;
      }
    } else {
      details = `<div>${escapeHtml(result.reason || 'Unknown error')}</div>`;
    }

    if (result.warnings?.length) {
      details += `<div style="margin-top:4px;font-size:11px;color:#666">⚠ ${result.warnings.map(w => w.code).join(', ')}</div>`;
    }

    details += `<div style="margin-top:4px;font-size:11px;color:#444">${Math.round(result.elapsed)}ms</div>`;

    cardEl.innerHTML = `
      ${thumb ? `<img class="result-thumb" src="${thumb}">` : '<div class="result-thumb"></div>'}
      <div class="result-body">
        <div class="result-header">
          <span class="result-badge ${badgeClass}">${verdictLabels[result.verdict] || result.verdict}</span>
          ${result.code && result.verdict !== 'reject' && result.verdict !== 'error' ? `<span class="result-code">${result.code}</span>` : ''}
        </div>
        <div class="result-filename">${escapeHtml(file.name)}</div>
        <div class="result-details">${details}</div>
        <div class="result-bar"><div class="result-bar-fill ${barClass}" style="width:${barWidth}%"></div></div>
      </div>
    `;
  }

  function createThumb(img) {
    const canvas = document.createElement('canvas');
    canvas.width = 72;
    canvas.height = 100;
    const ctx = canvas.getContext('2d');

    // Draw scaled cover
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = img.width;
    srcCanvas.height = img.height;
    const srcCtx = srcCanvas.getContext('2d');
    const imageData = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
    srcCtx.putImageData(imageData, 0, 0);

    // Cover fit
    const scale = Math.max(72 / img.width, 100 / img.height);
    const sw = img.width * scale;
    const sh = img.height * scale;
    const sx = (img.width - sw / scale) / 2 * scale;
    const sy = (img.height - sh / scale) / 2 * scale;
    ctx.drawImage(srcCanvas, 0, 0, img.width, img.height, (72 - sw) / 2, (100 - sh) / 2, sw, sh);

    return canvas.toDataURL('image/jpeg', 0.7);
  }

  function updateStats() {
    document.getElementById('statTotal').textContent = stats.total;
    document.getElementById('statMatch').textContent = stats.match;
    document.getElementById('statReject').textContent = stats.reject;
    const avg = stats.total > 0 ? Math.round(stats.totalTime / stats.total) : 0;
    document.getElementById('statTime').textContent = avg + 'ms';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
