// card-upload — CARDIMG protocol uploader
//
// Takes image bytes + BSV wallet, broadcasts to BSV on-chain.
// Protocol: OP_FALSE OP_RETURN "CARDIMG" <image_data>
// No metadata. No version byte. No server. No state.
//
// Usage:
//   const { uploadCard } = require('card-upload');
//   const result = await uploadCard('./scan.png', './wallet.json');
//   // → { txid, hash, size, fee }
//
//   const result = await uploadCard(imageBuffer, './wallet.json', { dryRun: true });
//   // → { txid: null, hash, size, fee, txHex }  (no broadcast)

const fs = require('fs');
const crypto = require('crypto');
const bsv = require('bsv');

const PROTOCOL_PREFIX = Buffer.from('CARDIMG');
const SATS_PER_BYTE = 0.1;
const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main';

// ── Helpers ─────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch with 429 retry/backoff. WoC rate-limits aggressive callers.
 */
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

/**
 * Load a BSV wallet from a JSON file containing { wif, address }.
 * @param {string} walletPath
 * @returns {{ priv: bsv.PrivateKey, addr: bsv.Address }}
 */
function loadWallet(walletPath) {
  const data = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  return {
    priv: bsv.PrivateKey.fromWIF(data.wif),
    addr: bsv.Address.fromString(data.address),
  };
}

// ── UTXOs ───────────────────────────────────────────────────

/**
 * Fetch confirmed UTXOs for an address from WhatsOnChain.
 * @param {string} addrStr
 * @param {Set<string>} [spentOutpoints] - locally tracked spent "txid:vout"
 * @returns {Promise<Array<{txid, vout, satoshis}>>}
 */
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

// ── Transaction ─────────────────────────────────────────────

/**
 * Build a CARDIMG transaction.
 * @param {Buffer} imageBuf
 * @param {{ priv, addr }} wallet
 * @param {Array<{txid, vout, satoshis}>} utxos
 * @returns {{ tx, fee, hash }}
 */
function buildTx(imageBuf, wallet, utxos) {
  const hash = crypto.createHash('sha256').update(imageBuf).digest('hex');
  const tx = new bsv.Transaction();

  const INPUT_SIZE = 147;
  const OUTPUT_SIZE = 34;
  const OP_RETURN_SIZE = 8 + 7 + imageBuf.length;
  const baseSize = 4 + 1 + OP_RETURN_SIZE + OUTPUT_SIZE + 4;

  // Select enough UTXOs to cover fee + dust change
  let inputSats = 0;
  const usedUtxos = [];
  for (const u of utxos) {
    usedUtxos.push(u);
    inputSats += u.satoshis;
    const estimatedSize = baseSize + usedUtxos.length * INPUT_SIZE;
    const estimatedFee = Math.ceil(estimatedSize * SATS_PER_BYTE);
    if (inputSats >= estimatedFee + 546) break;
  }

  if (inputSats < Math.ceil((baseSize + usedUtxos.length * INPUT_SIZE) * SATS_PER_BYTE)) {
    throw new Error(`Insufficient funds: have ${inputSats} sats`);
  }

  for (const u of usedUtxos) {
    tx.from({
      txId: u.txid,
      outputIndex: u.vout,
      script: bsv.Script.buildPublicKeyHashOut(wallet.addr).toHex(),
      satoshis: u.satoshis,
    });
  }

  // OP_FALSE OP_RETURN "CARDIMG" <image_data>
  const script = bsv.Script.buildSafeDataOut([PROTOCOL_PREFIX, imageBuf]);
  tx.addOutput(new bsv.Transaction.Output({ script, satoshis: 0 }));

  // Calculate fee from actual serialized size
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

  return { tx, fee: finalFee, hash };
}

// ── Broadcast ───────────────────────────────────────────────

/**
 * Broadcast raw tx hex to BSV via WhatsOnChain.
 * @param {string} txHex
 * @returns {Promise<string>} txid
 */
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
  // WoC returns txid as quoted string with trailing newline
  const raw = await res.text();
  return raw.trim().replace(/^["']+|["']+$/g, '');
}

// ── Main entry point ────────────────────────────────────────

/**
 * Upload a card image to BSV under the CARDIMG protocol.
 *
 * @param {string|Buffer} image - file path or raw image buffer
 * @param {string} walletPath - path to wallet JSON ({ wif, address })
 * @param {object} [opts] - { dryRun: false, spentOutpoints: Set }
 * @returns {Promise<{ txid, hash, size, fee, changeUtxo? }>}
 */
async function uploadCard(image, walletPath, opts = {}) {
  const { dryRun = false, spentOutpoints = new Set() } = opts;

  const imageBuf = typeof image === 'string' ? fs.readFileSync(image) : image;
  const size = imageBuf.length;

  const wallet = loadWallet(walletPath);
  const addrStr = wallet.addr.toString();

  const utxos = await getUtxos(addrStr, spentOutpoints);
  if (utxos.length === 0) {
    throw new Error(`No UTXOs for ${addrStr}. Fund the wallet first.`);
  }

  if (dryRun) {
    const { tx, fee, hash } = buildTx(imageBuf, wallet, utxos);
    return { txid: null, hash, size, fee, txHex: tx.serialize() };
  }

  // Try UTXOs until one broadcasts successfully
  let txid = null;
  let lastError = null;
  let broadcastTx = null;

  for (const u of utxos) {
    const outpoint = u.txid + ':' + u.vout;
    if (spentOutpoints.has(outpoint)) continue;

    try {
      const built = buildTx(imageBuf, wallet, [u]);
      txid = await broadcast(built.tx.serialize());
      broadcastTx = built.tx;
      spentOutpoints.add(outpoint);
      lastError = null;
      break;
    } catch (e) {
      if (e.message.includes('txn-mempool-conflict') || e.message.includes('258') ||
          e.message.includes('Missing inputs') || e.message.includes('already in the mempool')) {
        spentOutpoints.add(outpoint);
        lastError = e;
        continue;
      }
      throw e;
    }
  }

  if (!txid) {
    throw lastError || new Error('All UTXOs failed to broadcast');
  }

  // Extract change UTXO for caller to track
  let changeUtxo = null;
  if (broadcastTx && broadcastTx.outputs.length > 1) {
    const changeOut = broadcastTx.outputs[broadcastTx.outputs.length - 1];
    if (changeOut.satoshis > 546) {
      changeUtxo = { txid, vout: broadcastTx.outputs.length - 1, satoshis: changeOut.satoshis };
    }
  }

  return { txid, hash, size, fee, changeUtxo };
}

module.exports = {
  uploadCard,
  buildTx,
  broadcast,
  loadWallet,
  getUtxos,
  PROTOCOL_PREFIX,
  SATS_PER_BYTE,
};
