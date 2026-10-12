const $ = (id) => document.getElementById(id);
const api = window.loveRoom;
let state = null;

function say(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function render(s) {
  state = s;
  $('myCode').textContent = s.code;

  const conn = $('conn');
  conn.textContent = { online: 'Connecté', connecting: 'Connexion…', offline: 'Hors ligne' }[s.connection];
  conn.className = 'pill ' + (s.connection === 'online' ? 'ok' : 'warn');

  const paired = !!s.partner;
  $('pairForm').classList.toggle('hidden', paired);
  $('pairInfo').classList.toggle('hidden', !paired);
  if (paired) {
    $('partnerCode').textContent = s.partner;
    const st = $('pairState');
    const live = s.connection === 'online';
    st.textContent = !live ? 'Hors ligne' : s.pair === 'paired' ? 'Lié ✓' : 'En attente de l\'autre personne…';
    st.className = 'pill ' + (live && s.pair === 'paired' ? 'ok' : 'warn');
  }
  if (s.error === 'code_in_use') say($('pairMsg'), 'Ce code est déjà utilisé sur un autre appareil avec un autre identifiant.', 'err');

  if (document.activeElement !== $('serverInput')) $('serverInput').value = s.serverUrl;
  $('corner').value = s.corner;
  $('duration').value = s.durationSec;
  $('durLabel').textContent = s.durationSec;
  $('dnd').checked = s.dnd;
  $('login').checked = s.openAtLogin;
  $('loginRow').classList.toggle('hidden', !s.canAutoStart);
}

async function pair() {
  const r = await api.setPartner($('partnerInput').value);
  say($('pairMsg'), r.ok ? '' : r.error, r.ok ? '' : 'err');
  if (r.ok) $('partnerInput').value = '';
}

async function sendUrl() {
  const value = $('urlInput').value.trim();
  if (!value) return;
  $('sendUrl').disabled = true;
  say($('sendMsg'), 'Envoi…');
  const r = await api.sendUrl(value);
  $('sendUrl').disabled = false;
  say($('sendMsg'), r.ok ? 'Envoyé 💌' : r.error, r.ok ? 'ok' : 'err');
  if (r.ok) $('urlInput').value = '';
}

function toBase64(buffer) {
  let bin = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function sendFile(file) {
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) return say($('sendMsg'), 'Fichier trop gros (max 3 Mo).', 'err');
  say($('sendMsg'), 'Envoi…');
  const r = await api.sendFile({ data: toBase64(await file.arrayBuffer()) });
  say($('sendMsg'), r.ok ? 'Envoyé 💌' : r.error, r.ok ? 'ok' : 'err');
}

$('pairBtn').onclick = pair;
$('partnerInput').onkeydown = (e) => e.key === 'Enter' && pair();
$('unpairBtn').onclick = () => (say($('pairMsg'), ''), api.clearPartner());
$('copy').onclick = async () => {
  await navigator.clipboard.writeText(state.code);
  $('copy').textContent = 'Copié ✓';
  setTimeout(() => ($('copy').textContent = 'Copier'), 1500);
};
$('sendUrl').onclick = sendUrl;
$('urlInput').onkeydown = (e) => e.key === 'Enter' && sendUrl();
$('pick').onclick = () => $('file').click();
$('file').onchange = (e) => (sendFile(e.target.files[0]), (e.target.value = ''));
for (const ev of ['dragenter', 'dragover']) $('drop').addEventListener(ev, (e) => (e.preventDefault(), $('drop').classList.add('over')));
for (const ev of ['dragleave', 'drop']) $('drop').addEventListener(ev, () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => (e.preventDefault(), sendFile(e.dataTransfer.files[0])));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

$('serverSave').onclick = async () => {
  const before = state.serverUrl;
  const s = await api.setSettings({ serverUrl: $('serverInput').value });
  say($('settingsMsg'), s.serverUrl === before && $('serverInput').value.trim() !== before ? "Adresse invalide (ws:// ou wss://)." : '', 'err');
  render(s);
};
$('corner').onchange = (e) => api.setSettings({ corner: e.target.value });
$('duration').oninput = (e) => ($('durLabel').textContent = e.target.value);
$('duration').onchange = (e) => api.setSettings({ durationSec: Number(e.target.value) });
$('dnd').onchange = (e) => api.setSettings({ dnd: e.target.checked });
$('login').onchange = (e) => api.setSettings({ openAtLogin: e.target.checked });
$('test').onclick = async () => {
  const r = await api.testOverlay();
  say($('settingsMsg'), r.ok ? '' : r.error, 'err');
};

api.onState(render);
api.getState().then(render);
