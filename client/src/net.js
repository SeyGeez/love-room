'use strict';
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const SEND_TIMEOUT_MS = 10_000;

// Connexion au relais avec reconnexion automatique (backoff 1 s -> 30 s).
// Événements : 'connection' ('connecting'|'online'|'offline'), 'status' ({state, partner}),
// 'gif' (message brut du réseau, à valider par l'appelant), 'server-error' (code).
class RelayClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.creds = null;
    this.retry = 0;
    this.timer = null;
    this.pending = new Map();
    this.stopped = true;
  }

  start(creds) {
    this.stop();
    this.stopped = false;
    this.creds = creds; // { url, code, secret, partner }
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      this.ws.close();
      this.ws = null;
    }
    this.failPending('offline');
    this.emit('connection', 'offline');
  }

  open() {
    this.emit('connection', 'connecting');
    let ws;
    try {
      ws = new WebSocket(this.creds.url, { maxPayload: 5 * 1024 * 1024, handshakeTimeout: 10_000 });
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;

    ws.on('open', () => {
      const { code, secret, partner } = this.creds;
      ws.send(JSON.stringify({ t: 'hello', code, secret, partner: partner || undefined }));
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'ready':
          this.retry = 0;
          this.emit('connection', 'online');
          break;
        case 'status':
          this.emit('status', { state: msg.state, partner: msg.partner || null });
          break;
        case 'gif':
          this.emit('gif', msg);
          break;
        case 'ack': {
          const p = this.pending.get(msg.id);
          if (p) (this.pending.delete(msg.id), clearTimeout(p.timer), p.resolve());
          break;
        }
        case 'error': {
          const p = msg.id && this.pending.get(msg.id);
          if (p) (this.pending.delete(msg.id), clearTimeout(p.timer), p.reject(new Error(msg.code)));
          else this.emit('server-error', msg.code);
          break;
        }
      }
    });

    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending('offline');
      this.emit('connection', 'offline');
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.open(), delay);
  }

  failPending(reason) {
    for (const p of this.pending.values()) (clearTimeout(p.timer), p.reject(new Error(reason)));
    this.pending.clear();
  }

  isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  sendRaw(obj) {
    if (this.isOpen()) this.ws.send(JSON.stringify(obj));
  }

  pair(partner) {
    this.creds.partner = partner;
    this.sendRaw({ t: 'pair', partner });
  }

  unpair() {
    this.creds.partner = null;
    this.sendRaw({ t: 'unpair' });
  }

  // Envoie un gif validé ; résout quand le relais confirme, rejette avec le code d'erreur.
  sendGif(gif) {
    if (!this.isOpen()) return Promise.reject(new Error('offline'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (this.pending.delete(id), reject(new Error('timeout'))), SEND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.sendRaw({ t: 'gif', id, ...gif });
    });
  }
}

module.exports = { RelayClient };
