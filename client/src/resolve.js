'use strict';
const { validateUrl } = require('./protocol');

const TENOR_MEDIA_GIF = /https:\/\/media\d*\.tenor\.com\/[^"'\s<>\\]+\.gif/;

// Transforme ce que l'utilisateur colle en lien direct autorisé :
//  - lien direct (Giphy / Tenor / Imgur) -> tel quel
//  - page giphy.com/gifs/...-ID -> media.giphy.com/media/ID/giphy.gif
//  - page tenor.com/view/... -> on lit la page pour y trouver le .gif (au mieux)
async function resolveGifUrl(input, fetchImpl = globalThis.fetch) {
  if (typeof input !== 'string') return null;
  const direct = validateUrl(input);
  if (direct) return direct;

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'giphy.com' && url.pathname.startsWith('/gifs/')) {
    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    const id = last.split('-').pop();
    return /^[A-Za-z0-9]{5,30}$/.test(id) ? validateUrl(`https://media.giphy.com/media/${id}/giphy.gif`) : null;
  }

  if (host === 'tenor.com' && url.pathname.includes('/view/') && fetchImpl) {
    try {
      const res = await fetchImpl(url.href, { signal: AbortSignal.timeout(6000), redirect: 'follow' });
      if (!res.ok) return null;
      const html = (await res.text()).slice(0, 2_000_000);
      const m = html.match(TENOR_MEDIA_GIF);
      return m ? validateUrl(m[0]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = { resolveGifUrl };
