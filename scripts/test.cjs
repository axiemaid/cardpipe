// scripts/test.cjs — Test the pipeline modules independently
//
// Verifies:
//   1. card-phash: hash computation + Hamming distance
//   2. card-image: load + resize + grayscale
//   3. card-screen: normalize + match + verdict
//   4. card-crop: detect + crop (if test images available)

const path = require('path');
const fs = require('fs');

const REF_DIR = path.join(__dirname, '..', 'references');
const TEST_DIR = path.join(__dirname, '..', 'test-images');
const REFS_FILE = path.join(__dirname, '..', 'refs', 'first-stage.json');

async function testPhash() {
  console.log('\n── card-phash ──');
  const { phash, hammingDistance, hashToHex, hexToHash } = require('../packages/card-phash');

  // Create a simple test pattern
  const gray1 = new Uint8Array(32 * 32);
  for (let i = 0; i < gray1.length; i++) gray1[i] = (i * 7) % 256;
  const gray2 = new Uint8Array(gray1); // identical
  const gray3 = new Uint8Array(gray1);
  for (let i = 0; i < 10; i++) gray3[i] = 255; // slightly different

  const h1 = phash(gray1, 32, 32);
  const h2 = phash(gray2, 32, 32);
  const h3 = phash(gray3, 32, 32);

  const d12 = hammingDistance(h1, h2);
  const d13 = hammingDistance(h1, h3);

  console.log(`  identical hashes: ${d12 === 0 ? 'PASS' : 'FAIL'} (dist=${d12})`);
  console.log(`  different hashes: ${d13 > 0 ? 'PASS' : 'FAIL'} (dist=${d13})`);
  console.log(`  hex roundtrip: ${hexToHash(hashToHex(h1)) === h1 ? 'PASS' : 'FAIL'}`);
}

async function testImage() {
  console.log('\n── card-image ──');
  const image = require('../packages/card-image');

  const testFile = fs.readdirSync(REF_DIR).find(f => f.endsWith('.png'));
  if (!testFile) { console.log('  SKIP: no reference images'); return; }

  const img = await image.loadImage(path.join(REF_DIR, testFile));
  console.log(`  loadImage: ${img.width}×${img.height} ch=${img.channels} ${img.data.length > 0 ? 'PASS' : 'FAIL'}`);

  const small = await image.resize(img, 343, 480);
  console.log(`  resize: ${small.width}×${small.height} ${small.width === 343 && small.height === 480 ? 'PASS' : 'FAIL'}`);

  const gray = image.toGrayscale(small);
  console.log(`  toGrayscale: ${gray.length === 343 * 480 ? 'PASS' : 'FAIL'} (${gray.length} bytes)`);
}

async function testScreen() {
  console.log('\n── card-screen ──');
  const { buildRefs, loadRefs, screenCard } = require('../packages/card-screen');
  const image = require('../packages/card-image');

  // Build refs if they don't exist
  if (!fs.existsSync(REFS_FILE)) {
    console.log('  Building refs (first run)...');
    const refs = await buildRefs(REF_DIR);
    const outDir = path.dirname(REFS_FILE);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(REFS_FILE, JSON.stringify({ version: 1, count: refs.length, cards: refs }));
  }

  const refs = await loadRefs(REFS_FILE);
  console.log(`  loadRefs: ${refs.length} refs ${refs.length > 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  payload: ${fs.statSync(REFS_FILE).size} bytes`);

  // Test: each reference image should match itself
  let passCount = 0;
  for (const ref of refs) {
    const refFile = path.join(REF_DIR, `${ref.code}.png`);
    if (!fs.existsSync(refFile)) continue;

    const result = await screenCard(refFile, refs);
    if (result.code === ref.code && (result.verdict === 'match' || result.verdict === 'likely')) {
      passCount++;
    } else {
      console.log(`  FAIL: ${ref.code} → ${result.verdict} code=${result.code} conf=${result.confidence}`);
    }
  }
  console.log(`  self-match: ${passCount}/${refs.length} ${passCount === refs.length ? 'PASS' : 'PARTIAL'}`);
}

async function testCrop() {
  console.log('\n── card-crop ──');

  const testImages = fs.existsSync(TEST_DIR) ? fs.readdirSync(TEST_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f)) : [];
  if (testImages.length === 0) {
    console.log('  SKIP: no test images in test-images/');
    return;
  }

  const { cropCard } = require('../packages/card-crop');
  let passCount = 0;

  for (const file of testImages.slice(0, 5)) {
    const result = await cropCard(path.join(TEST_DIR, file));
    if (result.cropped) {
      console.log(`  ${file}: ${result.cropped.width}×${result.cropped.height} (${result.method}) PASS`);
      passCount++;
    } else {
      console.log(`  ${file}: ${result.reason} FAIL`);
    }
  }
  console.log(`  crop: ${passCount}/${testImages.length} passed`);
}

async function main() {
  console.log('cardpipe — module tests\n');
  await testPhash();
  await testImage();
  await testScreen();
  await testCrop();
  console.log('\nDone.');
}

main().catch(console.error);
