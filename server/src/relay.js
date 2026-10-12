'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { normalizeCode, isSecret, validateGif } = require('./protocol');

const MAX_PAYLOAD = 5 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const GIF_BURST = 8; // gifs consécutifs autorisés
const GIF_REFILL_MS = 3_000; // un jeton rendu toutes les 3 s
const MSG_PER_MINUTE = 120;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// Le serveur ne garde RIEN sur disque : uniquement les connexions en cours.
// Un client s'identifie avec (code, secret). Le premier à se connecter avec un code
// en devient le propriétaire tant qu'il est en ligne ; un autre secret est refusé.
// Un GIF n'est relayé que si les deux personnes se sont désignées mutuellement.
function createRelay() {
  const clients = new Map(); // code -> conn

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('love-room relay ok\n');
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

  const send = (conn, obj) => {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(obj));
  };

  function statusOf(conn) {
    if (!conn.partner) return 'unpaired';
    const other = clients.get(conn.partner);
    return other && other.partner === conn.code ? 'paired' : 'waiting';
  }

  function refresh(conn) {
    const state = statusOf(conn);
    const key = `${state}:${conn.partner || ''}`;
    if (key === conn.lastStatus) return;
    conn.lastStatus = key;
    send(conn, { t: 'status', state, partner: conn.partner });
  }

  // Tous ceux qui sont concernés par un changement sur `code`.
  function refreshRelated(code, ...extra) {
    const conn = clients.get(code);
    if (conn) refresh(conn);
    for (const c of clients.values()) {
      if (c.partner === code || extra.includes(c.code)) refresh(c);
    }
  }

  function takeGifToken(conn) {
    const now = Date.now();
    conn.tokens = Math.min(GIF_BURST, conn.tokens + (now - conn.tokensAt) / GIF_REFILL_MS);
    conn.tokensAt = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  function setPartner(conn, raw) {
    const partner = normalizeCode(raw);
    if (!partner || partner === conn.code) return false;
    const previous = conn.partner;
    conn.partner = partner;
    refreshRelated(conn.code, previous || undefined);
    return true;
  }

  wss.on('connection', (ws) => {
    const conn = {
      ws,
      code: null,
      partner: null,
      lastStatus: null,
      alive: true,
      tokens: GIF_BURST,
      tokensAt: Date.now(),
      msgCount: 0,
      msgWindowAt: Date.now(),
    };

    ws.on('pong', () => (conn.alive = true));

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.close(1003, 'text only');
      const now = Date.now();
      if (now - conn.msgWindowAt > 60_000) {
        conn.msgWindowAt = now;
        conn.msgCount = 0;
      }
      if (++conn.msgCount > MSG_PER_MINUTE) return ws.close(1008, 'rate limit');

      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return ws.close(1003, 'bad json');
      }
      if (!msg || typeof msg !== 'object') return ws.close(1003, 'bad message');

      if (msg.t === 'hello') {
        if (conn.code) return;
        const code = normalizeCode(msg.code);
        if (!code || !isSecret(msg.secret)) {
          send(conn, { t: 'error', code: 'bad_hello' });
          return ws.close(1008, 'bad hello');
        }
        const hash = sha256(msg.secret);
        const existing = clients.get(code);
        if (existing) {
          if (!crypto.timingSafeEqual(existing.secretHash, hash)) {
            send(conn, { t: 'error', code: 'code_in_use' });
            return ws.close(1008, 'code in use');
          }
          existing.code = null; // évite que sa fermeture ne nous déréférence
          existing.ws.close(4000, 'replaced');
        }
        conn.code = code;
        conn.secretHash = hash;
        clients.set(code, conn);
        send(conn, { t: 'ready' });
        if (msg.partner) setPartner(conn, msg.partner);
        refreshRelated(code);
        return;
      }

      if (!conn.code) return ws.close(1008, 'hello first');

      switch (msg.t) {
        case 'pair':
          if (!setPartner(conn, msg.partner)) send(conn, { t: 'error', code: 'bad_partner' });
          break;

        case 'unpair': {
          const previous = conn.partner;
          conn.partner = null;
          conn.lastStatus = null;
          refreshRelated(conn.code, previous || undefined);
          break;
        }

        case 'gif': {
          const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : undefined;
          const fail = (code) => send(conn, { t: 'error', code, id });
          if (!takeGifToken(conn)) return fail('rate_limited');
          const checked = validateGif(msg);
          if (!checked.ok) return fail(checked.reason);
          const other = conn.partner && clients.get(conn.partner);
          if (!other || other.partner !== conn.code) return fail('not_paired');
          send(other, { t: 'gif', ...checked.gif });
          send(conn, { t: 'ack', id });
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', () => {
      if (!conn.code || clients.get(conn.code) !== conn) return;
      clients.delete(conn.code);
      refreshRelated(conn.code, conn.partner || undefined);
    });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = [...clients.values()].find((c) => c.ws === ws);
      if (conn && !conn.alive) {
        ws.terminate();
        continue;
      }
      if (conn) conn.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    httpServer,
    listen: (port, host) =>
      new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address().port))),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

module.exports = { createRelay };
