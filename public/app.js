const socket = io();
const $ = (id) => document.getElementById(id);
let me = null, room = null, cur = null, texts = [], timerInt = null;

const show = (v) => { document.querySelectorAll('.view').forEach((s) => s.classList.remove('on')); $('v-' + v).classList.add('on'); };
const toast = (m) => { const t = $('toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 3000); };
function countdown(el, ms) {
  clearInterval(timerInt); const end = Date.now() + ms;
  const tick = () => { const s = Math.max(0, Math.ceil((end - Date.now()) / 1000)); el.textContent = s + 's'; el.classList.toggle('pulse', s <= 5); };
  tick(); timerInt = setInterval(tick, 250);
}

/* ---------- Rendu d'un mème (identique en édition, vote) ---------- */
function applyText(el, o) {
  el.style.left = o.x + '%'; el.style.top = o.y + '%'; el.style.fontSize = o.s + 'cqw'; el.style.color = o.c;
}
function renderMeme(box, media, list) {
  box.innerHTML = '';
  const m = document.createElement(media.type === 'video' ? 'video' : 'img');
  m.src = media.url; m.draggable = false;
  if (media.type === 'video') Object.assign(m, { autoplay: true, muted: true, loop: true, playsInline: true });
  box.appendChild(m);
  (list || []).forEach((o) => { const d = document.createElement('div'); d.className = 't'; d.textContent = o.t; applyText(d, o); box.appendChild(d); });
}

/* ---------- Accueil ---------- */
const nm = () => $('name').value.trim() || 'Joueur' + Math.floor(Math.random() * 99);
$('btn-create').onclick = () => socket.emit('create', nm());
$('btn-join').onclick = () => socket.emit('join', { code: $('code').value, name: nm() });
socket.on('err', toast);
socket.on('joined', (d) => { me = d.me; show('lobby'); });

/* ---------- Lobby ---------- */
socket.on('room', (r) => {
  room = r;
  $('l-code').textContent = r.code;
  $('l-bank').textContent = r.bankCount;
  $('l-players').innerHTML = r.players.map((p) => `<span class="px-3 py-1 rounded-full bg-white/10">${r.host === p.id ? '👑 ' : ''}${esc(p.name)}</span>`).join('');
  const host = r.host === me;
  $('l-host').classList.toggle('hidden', !host);
  $('l-wait').classList.toggle('hidden', host);
  if (host) $('rounds').value = r.rounds;
});
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('rounds').onchange = (e) => socket.emit('setRounds', e.target.value);
$('btn-start').onclick = () => socket.emit('start');

$('file').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 15 * 1024 * 1024) return toast('Fichier trop lourd (15 Mo max)');
  if (f.type === 'video/mp4') {
    const ok = await new Promise((res) => {
      const v = document.createElement('video'); v.preload = 'metadata';
      v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); res(v.duration <= 10.5); };
      v.onerror = () => res(false); v.src = URL.createObjectURL(f);
    });
    if (!ok) return toast('Vidéo trop longue (10 s max)');
  }
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/upload/' + room.code, { method: 'POST', body: fd });
  const j = await r.json();
  toast(r.ok ? '✅ Média ajouté !' : j.error);
};

/* ---------- Création ---------- */
socket.on('phase', (d) => {
  if (d.phase !== 'create') return;
  show('create'); $('c-round').textContent = `Manche ${d.round}/${d.rounds}`;
  countdown($('c-timer'), d.ms);
  texts = []; cur = null; $('c-tools').classList.add('hidden');
  $('btn-submit').disabled = false; $('btn-reroll').disabled = false;
});
socket.on('media', (d) => {
  renderMeme($('c-box'), d.media, []);
  texts.forEach((o) => $('c-box').appendChild(o.el));
  $('c-left').textContent = d.left + '/10';
  $('btn-reroll').disabled = d.left <= 0;
});
$('btn-reroll').onclick = () => socket.emit('reroll');

function select(o) {
  cur = o; texts.forEach((x) => x.el.classList.toggle('sel', x === o));
  $('c-tools').classList.remove('hidden'); $('t-size').value = o.s; $('t-color').value = o.c;
}
function addText() {
  const box = $('c-box'), o = { t: 'Ton texte', x: 50, y: 20 + (texts.length * 12) % 60, s: 8, c: '#ffffff' };
  const el = document.createElement('div'); el.className = 't edit'; el.textContent = o.t; o.el = el; applyText(el, o);
  el.onpointerdown = (e) => {
    if (el.isContentEditable) return;
    select(o); el.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      const r = box.getBoundingClientRect();
      o.x = Math.min(100, Math.max(0, (ev.clientX - r.left) / r.width * 100));
      o.y = Math.min(100, Math.max(0, (ev.clientY - r.top) / r.height * 100));
      applyText(el, o);
    };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  };
  el.ondblclick = () => { el.contentEditable = true; el.focus(); document.getSelection().selectAllChildren(el); };
  el.onblur = () => { el.contentEditable = false; o.t = el.innerText; };
  texts.push(o); box.appendChild(el); select(o);
}
$('btn-addtext').onclick = addText;
$('t-size').oninput = (e) => { if (cur) { cur.s = +e.target.value; applyText(cur.el, cur); } };
$('t-color').oninput = (e) => { if (cur) { cur.c = e.target.value; applyText(cur.el, cur); } };
$('t-del').onclick = () => { if (!cur) return; cur.el.remove(); texts = texts.filter((x) => x !== cur); cur = null; $('c-tools').classList.add('hidden'); };
$('btn-submit').onclick = () => {
  document.activeElement && document.activeElement.blur();
  const payload = texts.filter((o) => o.t.trim()).map(({ t, x, y, s, c }) => ({ t, x, y, s, c }));
  socket.emit('submit', payload);
};
socket.on('submitted', () => { $('btn-submit').disabled = true; $('btn-reroll').disabled = true; toast('Envoyé ! En attente des autres…'); });

/* ---------- Vote ---------- */
socket.on('vote', (d) => {
  show('vote'); renderMeme($('v-box'), d.media, d.texts);
  $('v-count').textContent = `Création ${d.index}/${d.total}`;
  countdown($('v-timer'), d.ms);
  $('v-btns').style.display = d.own ? 'none' : 'grid';
  $('v-btns').querySelectorAll('button').forEach((b) => (b.disabled = false));
  $('v-msg').textContent = d.own ? '😏 C’est ta création, tu ne votes pas !' : '';
});
$('v-btns').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  socket.emit('vote', b.dataset.v);
  $('v-btns').querySelectorAll('button').forEach((x) => (x.disabled = true));
  $('v-msg').textContent = 'Vote enregistré ✔️';
};
socket.on('reveal', (d) => {
  const sign = d.delta > 0 ? '+' : '';
  $('v-msg').innerHTML = `Par <b>${esc(d.author)}</b> · 🔥${d.counts.top} 😐${d.counts.meh} 💩${d.counts.flop} → <b>${sign}${d.delta} pts</b>`;
  $('v-btns').style.display = 'none';
});

/* ---------- Scores ---------- */
function board(list) {
  const medals = ['🥇', '🥈', '🥉'];
  $('s-list').innerHTML = list.map((p, i) =>
    `<li class="flex justify-between bg-white/10 rounded-xl px-4 py-2 ${p.id === me ? 'ring-2 ring-violet-400' : ''}"><span>${medals[i] || i + 1 + '.'} ${esc(p.name)}</span><b>${p.score} pts</b></li>`).join('');
  show('scores');
}
socket.on('roundScores', (d) => { $('s-title').textContent = `Classement – manche ${d.round}`; board(d.scores); });
socket.on('end', (d) => { clearInterval(timerInt); $('s-title').textContent = '🏆 Classement final'; board(d.scores); });