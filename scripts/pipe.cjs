// scripts/pipe.cjs — CLI orchestrator
//
// Usage:
//   node scripts/pipe.cjs <image>                          # crop + screen only
//   node scripts/pipe.cjs <image> --no-crop                # screen only (clean input)
//   node scripts/pipe.cjs <image> --wallet ./wallet.json   # full pipeline: crop + screen + upload
//   node scripts/pipe.cjs <image> --wallet ./wallet.json --dry-run  # build tx, no broadcast
//   node scripts/pipe.cjs <img1> <img2> --wallet ./wallet.json      # batch
//   node scripts/pipe.cjs <image> --debug

const path = require('path');
const { process: pipe, processBatch } = require('../orchestrator');

async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    debug: argv.includes('--debug'),
    skipCrop: argv.includes('--no-crop'),
    topResults: 5,
    refsPath: path.join(__dirname, '..', 'refs', 'first-stage.json'),
  };

  // Parse wallet option
  const walletIdx = argv.indexOf('--wallet');
  if (walletIdx !== -1 && argv[walletIdx + 1]) {
    opts.walletPath = argv[walletIdx + 1];
  }

  // Parse dry-run
  if (argv.includes('--dry-run')) {
    opts.dryRun = true;
  }

  // If no wallet, skip upload
  if (!opts.walletPath) {
    opts.skipUpload = true;
  }

  const walletPathVal = (walletIdx !== -1 && argv[walletIdx + 1]) ? argv[walletIdx + 1] : null;
  const skipFlags = new Set(['--debug', '--no-crop', '--dry-run', '--wallet']);
  const inputs = argv.filter(a => !a.startsWith('--') && a !== walletPathVal);
  if (inputs.length === 0) {
    console.error('Usage: node scripts/pipe.cjs <image> [image...] [--no-crop] [--wallet path] [--dry-run] [--debug]');
    process.exit(1);
  }

  if (inputs.length === 1) {
    console.log(`Processing: ${inputs[0]}\n`);
    const result = await pipe(inputs[0], opts);

    if (result.steps) {
      for (const s of result.steps) {
        const parts = [];
        if (s.ms !== undefined) parts.push(`${s.ms}ms`);
        if (s.size) parts.push(s.size);
        if (s.method) parts.push(s.method);
        if (s.verdict) parts.push(`${s.verdict} ${s.code || ''} ${Math.round((s.confidence || 0) * 100)}%`);
        if (s.txid) parts.push(`txid=${s.txid.slice(0,12)}...`);
        if (s.size && s.step === 'upload') parts.push(`${(s.size / 1024).toFixed(0)}KB`);
        if (s.fee) parts.push(`${s.fee}sats`);

        const skip = s.skipped ? ' (skipped' + (s.reason ? `: ${s.reason}` : '') + ')' : '';
        const fail = s.ok === false ? ' ✗' : '';
        console.log(`  ${s.step}${skip}: ${parts.join(' | ') || 'ok'}${fail}`);
      }
    }

    console.log('');
    if (result.accepted) {
      const conf = Math.round(result.confidence * 100);
      let line = `✓ ACCEPTED: ${result.code} (${conf}% confidence)`;
      if (result.txid) line += ` → txid: ${result.txid}`;
      if (result.hash) line += ` hash: ${result.hash.slice(0, 16)}...`;
      console.log(line);
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
    console.log(`Batch: ${inputs.length} images\n`);
    const results = await processBatch(inputs, opts);
    let accepted = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.accepted) {
        accepted++;
        const txid = r.txid ? ` → ${r.txid.slice(0, 12)}...` : '';
        console.log(`  ✓ ${inputs[i]}: ${r.code} (${Math.round(r.confidence * 100)}%)${txid}`);
      } else {
        console.log(`  ✗ ${inputs[i]}: ${r.reason}`);
      }
    }
    console.log(`\n${accepted}/${results.length} accepted`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
