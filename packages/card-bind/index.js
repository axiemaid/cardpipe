// card-bind — CARDSET protocol binder
//
// Links 2+ CARDIMG txids together on BSV via the CARDSET protocol.
// Protocol: OP_FALSE OP_RETURN "CARDSET" <txid1> <txid2> [...<txidN>]
//
// Positional ordering (convention):
//   0 = front (required)
//   1 = back (required)
//   2+ = supplementary (angles, surface, holo, edge)
//
// Usage:
//   const { bindCards } = require('card-bind');
//   const result = await bindCards([frontTxid, backTxid], './wallet.json');
//   // → { txid, count, fee }

const fs = require('fs');
const bsv = require('bsv');

const PROTOCOL_PREFIX = Buffer.from('CARDSET');
const SATS_PER_BYTE = 0.1;
const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main';
const MIN_TXIDS = 2;
const TXID_SIZE = 32;

// ── Helpers ─────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, opts = {}) {
  const maxRetries = 5;
  for (let i = 0; i <= maxRetries; i++) {
    const res = await fetch(url, opts);
    if (res.ok) return res;
    if (res.status !== 429 || i === maxRetries) return res;
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
    const waitMs = retryAfter ? retryAfter * 1000 : Math.pow(2, i + 1) * 1000;
    await sleep(waitMs);
  }
  return fetch(url, opts);
}

// ── Wallet ──────────────────────────────────────────────────

function loadWallet(walletPath) {
  const data = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  return {
    priv: bsv.PrivateKey.fromWIF(data.wif),
    addr: bsv.Address.fromString(data.address),
  };
}

// ── UTXOs ───────────────────────────────────────────────────

async function getUtxos(addrStr, spentOutpoints = new Set()) {
  const res = await fetchWithRetry(`${WoC_API}/address/${addrStr}/unspent`);
  if (!res.ok) throw new Error(`WoC UTXO error: ${res.status}`);
  const data = await res.json();

  return data
    .filter(u => u.value > 1000)
    .filter(u => !spentOutpoints.has(u.tx_hash + ':' + u.tx_pos))
    .sort((a, b) => b.value - a.value)
    .map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value }));
}

// ── Validation ──────────────────────────────────────────────

function isValidTxid(txid) {
  return typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid);
}

function txidToBuffer(txid) {
  return Buffer.from(txid, 'hex');
}

// ── Transaction ─────────────────────────────────────────────

function buildTx(txids, wallet, utxos) {
  if (txids.length < MIN_TXIDS) {
    throw new Error(`Need at least ${MIN_TXIDS} txids, got ${txids.length}`);
  }

  for (const t of txids) {
    if (!isValidTxid(t)) {
      throw new Error(`Invalid txid: ${t}. Expected 64-char hex string.`);
    }
  }

  const unique = new Set(txids);
  if (unique.size !== txids.length) {
    const dupes = txids.filter((t, i) => txids.indexOf(t) !== i);
    throw new Error(`Duplicate txids: ${dupes.join(', ')}`);
  }

  const tx = new bsv.Transaction();

  // OP_FALSE OP_RETURN "CARDSET" <txid1> <txid2> ... <txidN>
  const parts = [PROTOCOL_PREFIX, ...txids.map(txidToBuffer)];
  const script = bsv.Script.buildSafeDataOut(parts);
  tx.addOutput(new bsv.Transaction.Output({ script, satoshis: 0 }));

  // UTXO selection
  const INPUT_SIZE = 147;
  const OUTPUT_SIZE = 34;
  const OP_RETURN_OVERHEAD = 8 + 7 + txids.length * TXID_SIZE;
  const baseSize = 4 + 1 + OP_RETURN_OVERHEAD + 4;

  let inputSats = 0;
  const usedUtxos = [];
  let estimatedSize = baseSize + INPUT_SIZE + OUTPUT_SIZE;
  let estimatedFee = Math.ceil(estimatedSize * SATS_PER_BYTE);

  for (const u of utxos) {
    usedUtxos.push(u);
    inputSats += u.satoshis;
    if (inputSats >= estimatedFee + 546) break;
    estimatedSize = baseSize + usedUtxos.length * INPUT_SIZE + OUTPUT_SIZE;
    estimatedFee = Math.ceil(estimatedSize * SATS_PER_BYTE);
  }

  if (inputSats < estimatedFee) {
    throw new Error(`Insufficient funds: need ${estimatedFee} sats, have ${inputSats} sats`);
  }

  for (const u of usedUtxos) {
    tx.from({
      txId: u.txid,
      outputIndex: u.vout,
      script: bsv.Script.buildPublicKeyHashOut(wallet.addr).toHex(),
      satoshis: u.satoshis,
    });
  }

  tx.change(wallet.addr);
  tx.sign(wallet.priv);

  const txSize = tx.serialize().length / 2;
  const fee = Math.ceil(txSize * SATS_PER_BYTE);
  const change = inputSats - fee;

  if (change > 546) {
    tx.outputs[tx.outputs.length - 1].satoshis = change;
    tx.sign(wallet.priv);
  } else {
    tx.outputs.pop();
    tx.sign(wallet.priv);
  }

  const finalSize = tx.serialize().length / 2;
  const finalFee = Math.ceil(finalSize * SATS_PER_BYTE);

  return { tx, fee: finalFee, count: txids.length };
}

// ── Broadcast ───────────────────────────────────────────────

async function broadcast(txHex) {
  const res = await fetchWithRetry(`${WoC_API}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: txHex }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Broadcast failed: ${res.status} - ${text}`);
  }
  const raw = await res.text();
  return raw.trim().replace(/^["']+|["']+$/g, '');
}

// ── Main entry point ────────────────────────────────────────

/**
 * Bind 2+ CARDIMG txids together via CARDSET protocol.
 *
 * @param {string[]} txids - array of 64-char hex txids
 * @param {string} walletPath - path to wallet JSON
 * @param {object} [opts] - { dryRun, spentOutpoints, extraUtxos }
 * @returns {Promise<{ txid, count, fee }>}
 */
async function bindCards(txids, walletPath, opts = {}) {
  const { dryRun = false, spentOutpoints = new Set(), extraUtxos = [] } = opts;

  if (!Array.isArray(txids) || txids.length < MIN_TXIDS) {
    throw new Error(`Need at least ${MIN_TXIDS} txids, got ${Array.isArray(txids) ? txids.length : 0}`);
  }

  for (const t of txids) {
    if (!isValidTxid(t)) {
      throw new Error(`Invalid txid: ${t}. Expected 64-char hex string.`);
    }
  }

  const unique = new Set(txids);
  if (unique.size !== txids.length) {
    const dupes = txids.filter((t, i) => txids.indexOf(t) !== i);
    throw new Error(`Duplicate txids: ${dupes.join(', ')}`);
  }

  const wallet = loadWallet(walletPath);
  const addrStr = wallet.addr.toString();

  const wocUtxos = await getUtxos(addrStr, spentOutpoints);
  const utxos = [
    ...extraUtxos.filter(u => !spentOutpoints.has(u.txid + ':' + u.vout)),
    ...wocUtxos,
  ];

  if (utxos.length === 0) {
    throw new Error(`No UTXOs for ${addrStr}. Fund the wallet first.`);
  }

  if (dryRun) {
    const { tx, fee, count } = buildTx(txids, wallet, utxos);
    return { txid: null, count, fee, txHex: tx.serialize() };
  }

  const NON_RETRYABLE = ['Invalid txid', 'Duplicate txids', 'Need at least'];

  let txid = null;
  let lastError = null;

  for (const u of utxos) {
    const outpoint = u.txid + ':' + u.vout;
    if (spentOutpoints.has(outpoint)) continue;

    try {
      const built = buildTx(txids, wallet, [u]);
      txid = await broadcast(built.tx.serialize());
      spentOutpoints.add(outpoint);
      lastError = null;
      break;
    } catch (e) {
      if (NON_RETRYABLE.some(msg => e.message.includes(msg))) throw e;
      spentOutpoints.add(outpoint);
      lastError = e;
      continue;
    }
  }

  if (!txid) {
    throw lastError || new Error('All UTXOs failed to broadcast');
  }

  return { txid, count: txids.length, fee };
}

module.exports = {
  bindCards,
  buildTx,
  broadcast,
  loadWallet,
  getUtxos,
  isValidTxid,
  PROTOCOL_PREFIX,
  SATS_PER_BYTE,
  MIN_TXIDS,
};
