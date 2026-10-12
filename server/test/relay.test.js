'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { createRelay } = require('../src/relay');
const { generateCode, generateSecret, normalizeCode, validateUrl, validateGif } = require('../src/protocol');

const GIF_B64 = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x00\x00\x00;', 'latin1').toString('base64');

async function start() {
  const relay = createRelay();
  const port = await relay.listen(0, '127.0.0.1');
  return { relay, url: `ws://127.0.0.1:${port}` };
}

// Petit client de test : file d'attente de messages + attente d'un type donné.
async function connect(url, { code = generateCode(), secret = generateSecret(), partner } = {}) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)));
  const next = (pred) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 2000);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  };
  const c = {
    ws, code, secret, closed,
    send: (o) => ws.send(JSON.stringify(o)),
    expect: (t, extra = () => true) => next((m) => m.t === t && extra(m)),
    close: () => ws.close(),
  };
  c.send({ t: 'hello', code, secret, partner });
  return c;
}

test('appairage mutuel puis relais d\'un GIF', async () => {
  const { relay, url } = await start();
  const a = await connect(url);
  const b = await connect(url);
  await a.expect('ready');
  await b.expect('ready');

  a.send({ t: 'pair', partner: b.code });
  assert.equal((await a.expect('status', (m) => m.state === 'waiting')).partner, b.code);
  b.send({ t: 'pair', partner: a.code });
  await a.expect('status', (m) => m.state === 'paired');
  await b.expect('status', (m) => m.state === 'paired');

  a.send({ t: 'gif', id: '1', kind: 'url', url: 'https://media.giphy.com/media/abc/giphy.gif' });
  const got = await b.expect('gif');
  assert.deepEqual(got, { t: 'gif', kind: 'url', url: 'https://media.giphy.com/media/abc/giphy.gif' });
  await a.expect('ack', (m) => m.id === '1');

  b.send({ t: 'gif', id: '2', kind: 'data', mime: 'image/png', data: GIF_B64 });
  const data = await a.expect('gif');
  assert.equal(data.mime, 'image/gif'); // le type vient des octets, pas du client

  a.close(); b.close();
  await relay.close();
});

test('rien n\'est relayé tant que l\'autre n\'a pas accepté', async () => {
  const { relay, url } = await start();
  const a = await connect(url);
  const b = await connect(url);
  await a.expect('ready'); await b.expect('ready');
  a.send({ t: 'pair', partner: b.code });
  a.send({ t: 'gif', id: 'x', kind: 'url', url: 'https://i.imgur.com/a.gif' });
  assert.equal((await a.expect('error')).code, 'not_paired');
  a.close(); b.close();
  await relay.close();
});

test('le partenaire passe offline / waiting à la déconnexion', async () => {
  const { relay, url } = await start();
  const a = await connect(url);
  const b = await connect(url);
  await a.expect('ready'); await b.expect('ready');
  a.send({ t: 'pair', partner: b.code });
  b.send({ t: 'pair', partner: a.code });
  await a.expect('status', (m) => m.state === 'paired');
  b.close();
  await a.expect('status', (m) => m.state === 'waiting');
  a.close();
  await relay.close();
});

test('un autre secret ne peut pas voler un code en ligne', async () => {
  const { relay, url } = await start();
  const a = await connect(url);
  await a.expect('ready');
  const thief = await connect(url, { code: a.code });
  assert.equal((await thief.expect('error')).code, 'code_in_use');
  await thief.closed;
  // le vrai propriétaire peut se reconnecter (remplace l'ancienne connexion)
  const a2 = await connect(url, { code: a.code, secret: a.secret });
  await a2.expect('ready');
  assert.equal(await a.closed, 4000);
  a2.close();
  await relay.close();
});

test('GIF invalides refusés', async () => {
  const { relay, url } = await start();
  const a = await connect(url);
  const b = await connect(url);
  await a.expect('ready'); await b.expect('ready');
  a.send({ t: 'pair', partner: b.code });
  b.send({ t: 'pair', partner: a.code });
  await a.expect('status', (m) => m.state === 'paired');

  a.send({ t: 'gif', id: '1', kind: 'url', url: 'https://evil.example/x.gif' });
  assert.equal((await a.expect('error')).code, 'bad_url');
  a.send({ t: 'gif', id: '2', kind: 'url', url: 'http://media.giphy.com/x.gif' });
  assert.equal((await a.expect('error')).code, 'bad_url');
  a.send({ t: 'gif', id: '3', kind: 'data', data: Buffer.from('<script>alert(1)</script>').toString('base64') });
  assert.equal((await a.expect('error')).code, 'bad_gif');
  a.close(); b.close();
  await relay.close();
});

test('limite de débit sur les GIF', async () => {
  const { relay, url } = await start();
  const a = await connect(url);
  const b = await connect(url);
  await a.expect('ready'); await b.expect('ready');
  a.send({ t: 'pair', partner: b.code });
  b.send({ t: 'pair', partner: a.code });
  await a.expect('status', (m) => m.state === 'paired');
  for (let i = 0; i < 12; i++) a.send({ t: 'gif', id: String(i), kind: 'url', url: 'https://i.imgur.com/a.gif' });
  assert.equal((await a.expect('error')).code, 'rate_limited');
  a.close(); b.close();
  await relay.close();
});

test('protocol.js : codes et URLs', () => {
  const code = generateCode();
  assert.equal(normalizeCode(code), code);
  assert.equal(normalizeCode(code.slice(0, 5).toLowerCase() + ' - ' + code.slice(5)), code);
  assert.equal(normalizeCode('ILOIL01234'), null);
  assert.ok(validateUrl('https://media.tenor.com/abc/x.gif'));
  assert.ok(validateUrl('https://media1.tenor.com/m/abc/x.gif'));
  assert.equal(validateUrl('https://media.tenor.com.evil.com/x.gif'), null);
  assert.equal(validateUrl('https://user:pw@media.tenor.com/x.gif'), null);
  assert.equal(validateUrl('https://media.tenor.com:8443/x.gif'), null);
  assert.equal(validateGif({ kind: 'data', data: GIF_B64 }).ok, true);
});

test('protocol.js est identique côté client et côté serveur', () => {
  const server = fs.readFileSync(path.join(__dirname, '../src/protocol.js'));
  const client = fs.readFileSync(path.join(__dirname, '../../client/src/protocol.js'));
  assert.ok(server.equals(client), 'copiez server/src/protocol.js vers client/src/protocol.js');
});
