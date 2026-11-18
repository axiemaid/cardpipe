// scripts/pipe.cjs — CLI orchestrator test
//
// Usage:
//   node scripts/pipe.cjs /path/to/scan.png
//   node scripts/pipe.cjs /path/to/scan.png --no-crop
//   node scripts/pipe.cjs /path/to/scan.png --debug
//   node scripts/pipe.cjs /path/to/scan1.png /path/to/scan2.png --batch

const path = require('path');
const { process: pipe, processBatch } = require('../orchestrator');

async function main() {
  const args = process.argv.slice(2);
  const opts = {
    debug: args.includes('--debug'),
    skipCrop: args.includes('--no-crop'),
    topResults: 5,
    refsPath: path.join(__dirname, '..', 'refs', 'first-stage.json'),
  };

  const inputs = args.filter(a => !a.startsWith('--'));
  if (inputs.length === 0) {
    console.error('Usage: node scripts/pipe.cjs <image> [image...] [--no-crop] [--debug]');
    process.exit(1);
  }

  if (inputs.length === 1) {
    console.log(`Processing: ${inputs[0]}\n`);
    const result = await pipe(inputs[0], opts);

    if (result.steps) {
      for (const s of result.steps) {
        const extra = [];
        if (s.ms) extra.push(`${s.ms}ms`);
        if (s.size) extra.push(s.size);
        if (s.method) extra.push(s.method);
        if (s.verdict) extra.push(`${s.verdict} ${s.code || ''} ${(s.confidence * 100).toFixed(0)}%`);
        const skip = s.skipped ? ' (skipped)' : '';
        const ok = s.ok === false ? ' ✗' : '';
        console.log(`  ${s.step}${skip}: ${extra.join(' | ') || (ok ? 'failed' : 'ok')}${ok}`);
      }
    }

    console.log('');
    if (result.accepted) {
      console.log(`✓ ACCEPTED: ${result.code} (${(result.confidence * 100).toFixed(1)}% confidence)`);
    } else {
      console.log(`✗ REJECTED at ${result.rejectedAt}: ${result.reason}`);
    }

    if (result.results) {
      console.log('\n  Top matches:');
      for (const r of result.results) {
        console.log(`    ${r.code}  hamming=${r.hamming}  hist=${r.hist}  score=${r.score}`);
      }
    }
  } else {
    console.log(`Batch processing ${inputs.length} images\n`);
    const results = await processBatch(inputs, opts);
    let accepted = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.accepted) {
        accepted++;
        console.log(`  ✓ ${inputs[i]}: ${r.code} (${(r.confidence * 100).toFixed(0)}%)`);
      } else {
        console.log(`  ✗ ${inputs[i]}: ${r.reason}`);
      }
    }
    console.log(`\n${accepted}/${results.length} accepted`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
