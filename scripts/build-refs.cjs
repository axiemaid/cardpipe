// scripts/build-refs.cjs — Build the reference database from card images
//
// Usage:
//   node scripts/build-refs.cjs                          # from references/ → refs/first-stage.json
//   node scripts/build-refs.cjs --dir /path/to/cards    # custom input dir
//   node scripts/build-refs.cjs --out /path/to/refs.json # custom output

const path = require('path');
const fs = require('fs');
const { buildRefs } = require('../packages/card-screen');

async function main() {
  const args = process.argv.slice(2);
  const refDir = args[args.indexOf('--dir') + 1] || path.join(__dirname, '..', 'references');
  const outFile = args[args.indexOf('--out') + 1] || path.join(__dirname, '..', 'refs', 'first-stage.json');

  console.log(`Building refs from: ${refDir}`);
  const refs = await buildRefs(refDir);
  console.log(`Built ${refs.length} references`);

  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const output = { version: 1, count: refs.length, cards: refs };
  fs.writeFileSync(outFile, JSON.stringify(output));
  console.log(`Written to: ${outFile} (${fs.statSync(outFile).size} bytes)`);
}

main().catch(console.error);
