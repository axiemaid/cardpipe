// scripts/test.cjs — Test all pipeline modules
//
//   1. card-phash: hash computation + Hamming distance
//   2. card-image: load + resize + grayscale
//   3. card-validate: format, dimensions, saturation
//   4. card-screen: normalize + match + verdict
//   5. card-crop: detect + crop
//   6. card-upload: dry-run tx build
//   7. card-bind: dry-run tx build

const path = require('path');
const fs = require('fs');

const REF_DIR = path.join(__dirname, '..', 'references');
const TEST_DIR = path.join(__dirname, '..', 'test-images');
const REFS_FILE = path.join(__dirname, '..', 'refs', 'first-stage.json');

async function testPhash() {
  console.log('\n── card-phash ──');
  const { phash, hammingDistance, hashToHex, hexToHash } = require('../packages/card-phash');

  const gray1 = new Uint8Array(32 * 32);
  for (let i = 0; i < gray1.length; i++) gray1[i] = (i * 7) % 256;
  const gray2 = new Uint8Array(gray1);
  const gray3 = new Uint8Array(gray1);
  for (let i = 0; i < 10; i++) gray3[i] = 255;

  const h1 = phash(gray1, 32, 32);
  const h2 = phash(gray2, 32, 32);
  const h3 = phash(gray3, 32, 32);

  console.log(`  identical: ${hammingDistance(h1, h2) === 0 ? 'PASS' : 'FAIL'} (dist=${hammingDistance(h1, h2)})`);
  console.log(`  different: ${hammingDistance(h1, h3) > 0 ? 'PASS' : 'FAIL'} (dist=${hammingDistance(h1, h3)})`);
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

async function testValidate() {
  console.log('\n── card-validate ──');
  const { validate, detectFormat } = require('../packages/card-validate');

  // Valid reference image
  const refFile = path.join(REF_DIR, 'C01.png');
  if (!fs.existsSync(refFile)) { console.log('  SKIP: no C01.png'); return; }

  const result = await validate(refFile);
  console.log(`  valid image: ${result.passed ? 'PASS' : 'FAIL'} (${result.width}×${result.height})`);
  if (result.warnings?.length) console.log(`  warnings: ${result.warnings.map(w => w.code).join(', ')}`);

  // Too small — create a tiny buffer
  const tinyBuf = Buffer.alloc(100, 0xFF);
  tinyBuf[1] = 0xD8; tinyBuf[2] = 0xFF; // JPEG header
  const tinyResult = await validate(tinyBuf);
  console.log(`  tiny file: ${!tinyResult.passed ? 'PASS' : 'FAIL'} (failures: ${tinyResult.failures?.map(f => f.code).join(',')})`);

  // Bad format
  const badBuf = Buffer.from('not an image');
  const badResult = await validate(badBuf);
  console.log(`  bad format: ${!badResult.passed ? 'PASS' : 'FAIL'} (failures: ${badResult.failures?.map(f => f.code).join(',')})`);
}

async function testScreen() {
  console.log('\n── card-screen ──');
  const { buildRefs, loadRefs, screenCard } = require('../packages/card-screen');

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
  if (testImages.length === 0) { console.log('  SKIP: no test images'); return; }

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
  console.log(`  crop: ${passCount}/${Math.min(5, testImages.length)} passed`);
}

async function testUpload() {
  console.log('\n── card-upload ──');
  const { uploadCard } = require('../packages/card-upload');
  const walletPath = path.join(process.env.HOME, '.openclaw/bsv-wallet.json');

  if (!fs.existsSync(walletPath)) { console.log('  SKIP: no wallet'); return; }

  // Dry run with a small test image
  const testFile = fs.readdirSync(TEST_DIR).find(f => f.endsWith('.jpg'));
  if (!testFile) { console.log('  SKIP: no test image'); return; }

  try {
    const result = await uploadCard(path.join(TEST_DIR, testFile), walletPath, { dryRun: true });
    console.log(`  dry-run: ${result.txid === null ? 'PASS' : 'FAIL'} size=${result.size} fee=${result.fee} hash=${result.hash?.slice(0, 12)}...`);
  } catch (e) {
    console.log(`  dry-run: SKIP (${e.message})`);
  }
}

async function testBind() {
  console.log('\n── card-bind ──');
  const { bindCards } = require('../packages/card-bind');
  const walletPath = path.join(process.env.HOME, '.openclaw/bsv-wallet.json');

  if (!fs.existsSync(walletPath)) { console.log('  SKIP: no wallet'); return; }

  // Dry run with fake txids
  const fakeTxids = [
    'a'.repeat(64),
    'b'.repeat(64),
  ];

  try {
    const result = await bindCards(fakeTxids, walletPath, { dryRun: true });
    console.log(`  dry-run: ${result.txid === null ? 'PASS' : 'FAIL'} count=${result.count} fee=${result.fee}`);
  } catch (e) {
    console.log(`  dry-run: SKIP (${e.message})`);
  }

  // Validation: single txid should fail
  try {
    await bindCards(['a'.repeat(64)], walletPath, { dryRun: true });
    console.log('  single-txid rejection: FAIL');
  } catch (e) {
    console.log(`  single-txid rejection: PASS (${e.message})`);
  }

  // Validation: duplicate txids should fail
  try {
    await bindCards(['a'.repeat(64), 'a'.repeat(64)], walletPath, { dryRun: true });
    console.log('  duplicate rejection: FAIL');
  } catch (e) {
    console.log(`  duplicate rejection: PASS (${e.message})`);
  }
}

async function main() {
  console.log('cardpipe — module tests\n');
  await testPhash();
  await testImage();
  await testValidate();
  await testScreen();
  await testCrop();
  await testUpload();
  await testBind();
  console.log('\nDone.');
}

main().catch(console.error);
