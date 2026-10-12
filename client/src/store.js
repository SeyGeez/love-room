'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { generateCode, generateSecret, isSecret, normalizeCode } = require('./protocol');

const DEFAULT_SERVER = process.env.LOVEROOM_SERVER || 'ws://localhost:8787';
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

const DEFAULTS = {
  code: null,
  secret: null,
  partner: null,
  serverUrl: DEFAULT_SERVER,
  corner: 'bottom-right',
  durationSec: 8,
  dnd: false,
  openAtLogin: false,
};

function isServerUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'ws:' || u.protocol === 'wss:';
  } catch {
    return false;
  }
}

// Ne garde que des valeurs valides : le fichier peut avoir été édité à la main.
function sanitize(raw) {
  const c = { ...DEFAULTS, ...raw };
  c.code = normalizeCode(c.code);
  if (!c.code || !isSecret(c.secret)) {
    c.code = generateCode();
    c.secret = generateSecret();
  }
  c.partner = normalizeCode(c.partner);
  if (c.partner === c.code) c.partner = null;
  if (!isServerUrl(c.serverUrl)) c.serverUrl = DEFAULT_SERVER;
  if (!CORNERS.includes(c.corner)) c.corner = DEFAULTS.corner;
  c.durationSec = Math.min(30, Math.max(2, Math.round(Number(c.durationSec)) || DEFAULTS.durationSec));
  c.dnd = c.dnd === true;
  c.openAtLogin = c.openAtLogin === true;
  return c;
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* premier lancement ou fichier corrompu */
    }
    this.data = sanitize(raw);
    this.save();
  }

  get() {
    return this.data;
  }

  update(patch) {
    this.data = sanitize({ ...this.data, ...patch });
    this.save();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, CORNERS, isServerUrl };
