// card-crop — OpenCV-based card boundary detection and cropping
//
// Takes a scan (with sleeve/background/glare), finds the card via
// contour detection + brown ring validation, returns cropped raw pixels.
//
// Uses card-image for I/O. OpenCV only for detection math.
//
// Usage:
//   const { cropCard } = require('card-crop');
//   const result = await cropCard('/path/to/scan.png');
//   // → { cropped: {data, width, height, channels}, corners, bounds, method }
//   // or { cropped: null, reason: 'no_valid_card' }

const image = require('card-image');

let _cv = null;

async function getOpenCv() {
  if (_cv) return _cv;
  const cvModule = require('@techstark/opencv-js');
  if (cvModule instanceof Promise) {
    _cv = await cvModule;
  } else if (cvModule.Mat) {
    _cv = cvModule;
  } else {
    await new Promise((resolve) => {
      cvModule.onRuntimeInitialized = () => resolve();
    });
    _cv = cvModule;
  }
  return _cv;
}

// ── Geometry helpers ────────────────────────────────────────

function orderPoints(pts) {
  const sorted = [...pts].sort((a, b) => a[0] + a[1] - b[0] - b[1]);
  const tl = sorted[0];
  const br = sorted[sorted.length - 1];
  const remaining = pts.filter(p => p !== tl && p !== br);
  const tr = remaining[0][0] > remaining[1][0] ? remaining[0] : remaining[1];
  const bl = remaining[0][0] <= remaining[1][0] ? remaining[0] : remaining[1];
  return [tl, tr, br, bl];
}

function dist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function angleAt(a, b, c) {
  const v1x = a[0] - b[0], v1y = a[1] - b[1];
  const v2x = c[0] - b[0], v2y = c[1] - b[1];
  const dot = v1x * v2x + v1y * v2y;
  const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
  const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
  if (mag1 === 0 || mag2 === 0) return 0;
  const cosA = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.acos(cosA) * 180 / Math.PI;
}

// ── Card detection constants ────────────────────────────────

const TARGET_RATIO = 2.5 / 3.5; // Pokemon card aspect ratio
const RATIO_TOLERANCE = 0.15;
const RING_GATE = 0.03; // min brown ring fraction to pass

// ── Scoring ────────────────────────────────────────────────

function scoreQuad(quad) {
  const [tl, tr, br, bl] = quad;
  const top = dist(tl, tr);
  const right = dist(tr, br);
  const bottom = dist(br, bl);
  const left = dist(bl, tl);
  const avgW = (top + bottom) / 2;
  const avgH = (left + right) / 2;

  if (avgH === 0) return { score: 0, ratio: 0, ratioScore: 0, angleScore: 0, sideScore: 0, angles: [] };
  const ratio = avgW / avgH;
  const ratioOff = Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO;
  if (ratioOff > RATIO_TOLERANCE) return { score: 0, ratio, ratioScore: 0, angleScore: 0, sideScore: 0, angles: [] };
  const ratioScore = 1 - Math.min(1, ratioOff);

  const angles = [
    angleAt(bl, tl, tr),
    angleAt(tl, tr, br),
    angleAt(tr, br, bl),
    angleAt(br, bl, tl),
  ];
  const angleScore = angles.reduce((s, a) => s + (1 - Math.min(1, Math.abs(a - 90) / 45)), 0) / 4;

  const topBotDiff = Math.abs(top - bottom) / Math.max(top, bottom, 1);
  const leftRightDiff = Math.abs(left - right) / Math.max(left, right, 1);
  const sideScore = (1 - topBotDiff + 1 - leftRightDiff) / 2;

  const score = ratioScore * 0.35 + angleScore * 0.35 + sideScore * 0.30;
  return { score, ratio, ratioScore, angleScore, sideScore, angles };
}

// ── Brown ring detection ────────────────────────────────────

function brownRingCheck(cv, src, quad, width, height) {
  const xs = quad.map(c => c[0]);
  const ys = quad.map(c => c[1]);
  const x0 = Math.max(0, Math.round(Math.min(...xs)));
  const y0 = Math.max(0, Math.round(Math.min(...ys)));
  const x1 = Math.min(width - 1, Math.round(Math.max(...xs)));
  const y1 = Math.min(height - 1, Math.round(Math.max(...ys)));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 10 || bh < 10) return 0;

  const region = src.roi(new cv.Rect(x0, y0, bw, bh));
  const hsv = new cv.Mat();
  cv.cvtColor(region, hsv, cv.COLOR_RGB2HSV);

  const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [10, 40, 40, 0]);
  const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [30, 255, 220, 255]);
  const mask = new cv.Mat();
  cv.inRange(hsv, low, high, mask);

  const band = 5;
  let brownCount = 0;
  let totalCount = 0;

  for (let y = 0; y < Math.min(band, bh); y++) {
    for (let x = 0; x < bw; x++) { totalCount++; if (mask.data[y * bw + x]) brownCount++; }
  }
  for (let y = Math.max(0, bh - band); y < bh; y++) {
    for (let x = 0; x < bw; x++) { totalCount++; if (mask.data[y * bw + x]) brownCount++; }
  }
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < Math.min(band, bw); x++) { totalCount++; if (mask.data[y * bw + x]) brownCount++; }
  }
  for (let y = 0; y < bh; y++) {
    for (let x = Math.max(0, bw - band); x < bw; x++) { totalCount++; if (mask.data[y * bw + x]) brownCount++; }
  }

  region.delete(); hsv.delete(); low.delete(); high.delete(); mask.delete();
  return totalCount > 0 ? brownCount / totalCount : 0;
}

// ── Mat helpers ─────────────────────────────────────────────

function bufferToMat(cv, data, width, height, channels) {
  const mat = new cv.Mat(height, width, channels === 4 ? cv.CV_8UC4 : cv.CV_8UC3);
  mat.data.set(data);
  return mat;
}

function matToRawPixels(cv, mat) {
  return {
    data: new Uint8Array(mat.data),
    width: mat.cols,
    height: mat.rows,
    channels: mat.channels(),
  };
}

// ── Main detection ──────────────────────────────────────────

/**
 * Detect card contour in an image.
 * @param {object|string} input - file path / Blob / raw pixels {data,width,height,channels}
 * @param {object} [opts] - { debug: true }
 * @returns {Promise<{ corners, bounds, method } | { reason: string }>}
 */
async function detectCard(input, opts = {}) {
  const { debug = false } = opts;
  const cv = await getOpenCv();

  // Load via card-image, then downscale for detection
  let img;
  if (input && input.data && input.width) {
    img = input;
  } else {
    img = await image.loadImage(input);
  }

  // Downscale to 400px wide for detection
  const detectW = 400;
  const detectH = Math.round(400 * (img.height / img.width));
  const small = await image.resize(img, detectW, detectH);

  const src = bufferToMat(cv, small.data, detectW, detectH, small.channels);

  // Grayscale + blur
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

  const imageSize = detectW * detectH;
  const candidates = [];

  const cannyThresholds = [[50, 150], [75, 200], [30, 100]];

  // Phase 1: approxPolyDP on all contours
  for (const [lo, hi] of cannyThresholds) {
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, lo, hi, 3, false);
    const dilated = new cv.Mat();
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area < imageSize * 0.2) { contour.delete(); continue; }

      const approx = new cv.Mat();
      const peri = cv.arcLength(contour, true);
      cv.approxPolyDP(contour, approx, 0.02 * peri, true);
      if (approx.rows !== 4) { approx.delete(); continue; }

      const pts = [];
      for (let j = 0; j < 4; j++) pts.push([approx.data32S[j * 2], approx.data32S[j * 2 + 1]]);
      approx.delete();

      const ordered = orderPoints(pts);
      const metrics = scoreQuad(ordered);
      if (metrics.score < 0.1) continue;

      candidates.push({ corners: ordered, area, areaPct: area / imageSize, canny: [lo, hi], ...metrics });
    }

    edges.delete(); dilated.delete(); kernel.delete();
    contours.delete(); hierarchy.delete();
  }

  // Brown ring check
  for (const c of candidates) {
    c.ringScore = brownRingCheck(cv, src, c.corners, detectW, detectH);
    const ringBonus = Math.min(1, c.ringScore / 0.15);
    c.finalScore = c.score * 0.6 + ringBonus * 0.4;
  }

  const passed = candidates.filter(c => c.ringScore >= RING_GATE);
  passed.sort((a, b) => b.finalScore - a.finalScore);

  if (debug) {
    console.log(`  ${candidates.length} candidates, ${passed.length} passed ring gate`);
  }

  // Phase 2: Hull fallback if nothing passed
  if (passed.length === 0) {
    if (debug) console.log('  Trying hull fallback...');

    for (const [lo, hi] of cannyThresholds) {
      const edges = new cv.Mat();
      cv.Canny(blurred, edges, lo, hi, 3, false);
      const dilated = new cv.Mat();
      const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area < imageSize * 0.2) { contour.delete(); continue; }

        const hull = new cv.Mat();
        cv.convexHull(contour, hull, false, true);

        let quadPts = null;
        if (hull.rows >= 4) {
          const hullPeri = cv.arcLength(hull, true);
          for (const eps of [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15]) {
            const hullApprox = new cv.Mat();
            cv.approxPolyDP(hull, hullApprox, eps * hullPeri, true);
            if (hullApprox.rows === 4) {
              quadPts = [];
              for (let j = 0; j < 4; j++) quadPts.push([hullApprox.data32S[j * 2], hullApprox.data32S[j * 2 + 1]]);
              hullApprox.delete();
              break;
            }
            hullApprox.delete();
          }
        }

        // minAreaRect fallback
        if (!quadPts) {
          const rect = cv.minAreaRect(contour);
          const boxPts = cv.boxPoints(rect);
          if (boxPts && boxPts.rows === 4) {
            quadPts = [];
            for (let j = 0; j < 4; j++) quadPts.push([Math.round(boxPts.data32F[j * 2]), Math.round(boxPts.data32F[j * 2 + 1])]);
          }
        }

        hull.delete();
        if (!quadPts) continue;

        const ordered = orderPoints(quadPts);
        const metrics = scoreQuad(ordered);
        if (metrics.score < 0.1) continue;

        const ringScore = brownRingCheck(cv, src, ordered, detectW, detectH);
        if (ringScore < RING_GATE) continue;

        const ringBonus = Math.min(1, ringScore / 0.15);
        const finalScore = metrics.score * 0.6 + ringBonus * 0.4;
        passed.push({ corners: ordered, area, areaPct: area / imageSize, canny: [lo, hi], method: 'hull', ...metrics, ringScore, finalScore });
      }

      edges.delete(); dilated.delete(); kernel.delete();
      contours.delete(); hierarchy.delete();
      if (passed.length > 0) break;
    }
  }

  src.delete(); gray.delete(); blurred.delete();

  if (passed.length === 0) {
    return { reason: 'no_valid_card' };
  }

  // Select outermost candidate
  const BORDER_MARGIN = 3;
  function bbox(c) {
    const xs = c.corners.map(p => p[0]);
    const ys = c.corners.map(p => p[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }
  function touchesBorder(c) {
    const b = bbox(c);
    return b.minX < BORDER_MARGIN || b.minY < BORDER_MARGIN || b.maxX > detectW - BORDER_MARGIN || b.maxY > detectH - BORDER_MARGIN;
  }
  function contains(a, b) {
    const ba = bbox(a), bb = bbox(b);
    return bb.minX >= ba.minX && bb.maxX <= ba.maxX && bb.minY >= ba.minY && bb.maxY <= ba.maxY;
  }

  const nonBorder = passed.filter(c => !touchesBorder(c));
  const pool = nonBorder.length > 0 ? nonBorder : passed;
  let best = pool[0];
  for (const c of pool) { if (contains(c, best)) best = c; }

  // Scale corners back to original resolution
  const scaleX = img.width / detectW;
  const scaleY = img.height / detectH;
  const corners = best.corners.map(([x, y]) => [Math.round(x * scaleX), Math.round(y * scaleY)]);

  const xs = corners.map(c => c[0]);
  const ys = corners.map(c => c[1]);
  const bounds = {
    left: Math.max(0, Math.round(Math.min(...xs))),
    top: Math.max(0, Math.round(Math.min(...ys))),
    right: Math.min(img.width, Math.round(Math.max(...xs))),
    bottom: Math.min(img.height, Math.round(Math.max(...ys))),
  };

  return { corners, bounds, method: best.method || 'contour' };
}

/**
 * Crop an image to the detected card face.
 * @param {object|string} input - file path / Blob / raw pixels
 * @param {object} [opts] - { debug: true }
 * @returns {Promise<{ cropped: object, corners, bounds, method } | { cropped: null, reason: string }>}
 */
async function cropCard(input, opts = {}) {
  let img;
  if (input && input.data && input.width) {
    img = input;
  } else {
    img = await image.loadImage(input);
  }

  const detection = await detectCard(img, opts);

  if (detection.reason) {
    return { cropped: null, reason: detection.reason };
  }

  const b = detection.bounds;
  const w = b.right - b.left;
  const h = b.bottom - b.top;

  if (w < 10 || h < 10) {
    return { cropped: null, reason: 'crop_too_small' };
  }

  const cropped = await image.extractRegion(img, b.left, b.top, w, h);

  return {
    cropped,
    corners: detection.corners,
    bounds: detection.bounds,
    method: detection.method,
  };
}

module.exports = {
  detectCard,
  cropCard,
  getOpenCv,
  orderPoints,
  scoreQuad,
  brownRingCheck,
  angleAt,
  dist,
  TARGET_RATIO,
  RATIO_TOLERANCE,
  RING_GATE,
};
