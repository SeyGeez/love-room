'use strict';
const { createRelay } = require('./relay');

const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '0.0.0.0';

createRelay()
  .listen(port, host)
  .then((p) => console.log(`love-room relay en écoute sur ${host}:${p}`));
