'use strict';
// Ce fichier est IDENTIQUE dans server/src et client/src (un test le vérifie).
// Il contient tout ce que le client ET le serveur doivent valider.

const crypto = require('node:crypto');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I, L, O, 0, 1
const CODE_LENGTH = 10;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;

const ALLOWED_HOST_PATTERNS = [
  /^media\d*\.tenor\.com$/,
  /^c\.tenor\.com$/,
  /^media\d*\.giphy\.com$/,
  /^i\.giphy\.com$/,
  /^i\.imgur\.com$/,
];

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function isSecret(value) {
  return typeof value === 'string' && /^[0-9a-f]{32,128}$/.test(value);
}

// Accepte "abcde-fghjk", "ABCDE FGHJK"... et renvoie le code canonique ou null.
function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

function formatCode(code) {
  return code.slice(0, 5) + '-' + code.slice(5);
}

// Renvoie l'URL normalisée si c'est un lien https direct vers un hébergeur autorisé.
// On limite les hôtes : afficher une image distante révèle l'IP du destinataire à l'hôte.
function validateUrl(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  if (!ALLOWED_HOST_PATTERNS.some((re) => re.test(url.hostname))) return null;
  return url.href;
}

function detectMime(buf) {
  if (buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

// Valide un message "gif" venu du réseau ou de l'interface.
// Renvoie { ok: true, gif: {kind:'url', url} | {kind:'data', mime, data} } ou { ok: false, reason }.
function validateGif(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'bad_gif' };
  if (msg.kind === 'url') {
    const url = validateUrl(msg.url);
    return url ? { ok: true, gif: { kind: 'url', url } } : { ok: false, reason: 'bad_url' };
  }
  if (msg.kind === 'data') {
    const b64 = msg.data;
    if (typeof b64 !== 'string' || b64.length === 0) return { ok: false, reason: 'bad_gif' };
    if (b64.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4) return { ok: false, reason: 'too_big' };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, reason: 'bad_gif' };
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_FILE_BYTES) return { ok: false, reason: 'too_big' };
    const mime = detectMime(buf);
    if (!mime) return { ok: false, reason: 'bad_gif' };
    return { ok: true, gif: { kind: 'data', mime, data: b64 } };
  }
  return { ok: false, reason: 'bad_gif' };
}

module.exports = {
  CODE_LENGTH,
  MAX_FILE_BYTES,
  generateCode,
  generateSecret,
  isSecret,
  normalizeCode,
  formatCode,
  validateUrl,
  validateGif,
  detectMime,
};
