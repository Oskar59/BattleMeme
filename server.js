const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const UP = path.join(__dirname, 'uploads');
fs.mkdirSync(UP, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'video/mp4': '.mp4' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (req, f, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + EXT[f.mimetype]),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, f, cb) => cb(null, !!EXT[f.mimetype]),
});

const CREATE_MS = 90_000, VOTE_MS = 20_000, REVEAL_MS = 4_000, MAX_REROLL = 10, MAX_PLAYERS = 10;
const rooms = {};

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UP));

// Fonds par défaut (SVG générés) pour que la banque ne soit jamais vide
const GRAD = [['#ff6b6b', '#feca57'], ['#54a0ff', '#5f27cd'], ['#1dd1a1', '#10ac84'], ['#f368e0', '#ff9f43']];
app.get('/default/:n', (req, res) => {
  const [a, b] = GRAD[Number(req.params.n) % GRAD.length];
  res.type('svg').send(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/></svg>`);
});

app.post('/upload/:code', upload.single('file'), (req, res) => {
  const r = rooms[req.params.code.toUpperCase()];
  if (!r || !req.file) return res.status(400).json({ error: 'Fichier refusé ou salon introuvable' });
  const m = { id: req.file.filename, url: '/uploads/' + req.file.filename, type: req.file.mimetype.startsWith('video') ? 'video' : 'image', file: req.file.path };
  r.bank.push(m);
  broadcast(r);
  res.json({ ok: true });
});
app.use((err, req, res, next) => res.status(400).json({ error: 'Fichier refusé (type invalide ou > 15 Mo)' }));

const pub = (m) => ({ id: m.id, url: m.url, type: m.type });
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rand = (a) => a[Math.floor(Math.random() * a.length)];

function newCode() {
  let c; do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms[c]); return c;
}
function broadcast(r) {
  io.to(r.code).emit('room', {
    code: r.code, host: r.host, phase: r.phase, round: r.round, rounds: r.rounds, bankCount: r.bank.length,
    players: Object.entries(r.players).map(([id, p]) => ({ id, name: p.name, score: p.score })),
  });
}
function scores(r) {
  return Object.entries(r.players).map(([id, p]) => ({ id, name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
}

function startRound(r) {
  r.round++; r.phase = 'create'; r.subs = [];
  for (const [id, p] of Object.entries(r.players)) {
    p.rerolls = 0; p.submitted = false; p.media = rand(r.bank);
    io.to(id).emit('media', { media: pub(p.media), left: MAX_REROLL });
  }
  io.to(r.code).emit('phase', { phase: 'create', round: r.round, rounds: r.rounds, ms: CREATE_MS });
  broadcast(r);
  clearTimeout(r.timer);
  r.timer = setTimeout(() => endCreate(r), CREATE_MS + 500);
}
function endCreate(r) {
  clearTimeout(r.timer);
  if (r.phase !== 'create') return;
  if (!r.subs.length) return endRound(r);
  shuffle(r.subs); r.idx = -1; nextSub(r);
}
function nextSub(r) {
  r.idx++;
  if (r.idx >= r.subs.length) return endRound(r);
  r.phase = 'vote'; r.votes = {};
  const s = r.subs[r.idx];
  for (const id of Object.keys(r.players)) {
    io.to(id).emit('vote', { media: pub(s.media), texts: s.texts, index: r.idx + 1, total: r.subs.length, own: id === s.author, ms: VOTE_MS });
  }
  broadcast(r);
  clearTimeout(r.timer);
  r.timer = setTimeout(() => reveal(r), VOTE_MS + 500);
  checkAllVoted(r);
}
function checkAllVoted(r) {
  if (r.phase !== 'vote') return;
  const s = r.subs[r.idx];
  const eligible = Object.keys(r.players).filter((id) => id !== s.author);
  if (eligible.every((id) => r.votes[id])) reveal(r);
}
function reveal(r) {
  if (r.phase !== 'vote') return;
  clearTimeout(r.timer); r.phase = 'reveal';
  const s = r.subs[r.idx], pts = { top: 2, meh: 0, flop: -1 };
  const counts = { top: 0, meh: 0, flop: 0 };
  let delta = 0;
  for (const v of Object.values(r.votes)) { counts[v]++; delta += pts[v]; }
  if (r.players[s.author]) r.players[s.author].score += delta;
  io.to(r.code).emit('reveal', { author: s.name, delta, counts, scores: scores(r) });
  broadcast(r);
  r.timer = setTimeout(() => nextSub(r), REVEAL_MS);
}
function endRound(r) {
  clearTimeout(r.timer);
  if (r.round >= r.rounds) {
    r.phase = 'end';
    io.to(r.code).emit('end', { scores: scores(r) });
    return broadcast(r);
  }
  r.phase = 'scores';
  io.to(r.code).emit('roundScores', { scores: scores(r), round: r.round });
  broadcast(r);
  r.timer = setTimeout(() => startRound(r), 5000);
}
function deleteRoom(r) {
  clearTimeout(r.timer);
  r.bank.forEach((m) => m.file && fs.unlink(m.file, () => {}));
  delete rooms[r.code];
}

io.on('connection', (socket) => {
  let room = null;
  const join = (r, name) => {
    room = r; socket.join(r.code);
    r.players[socket.id] = { name: String(name || 'Anonyme').slice(0, 16), score: 0 };
    if (!r.host) r.host = socket.id;
    socket.emit('joined', { code: r.code, me: socket.id });
    broadcast(r);
  };

  socket.on('create', (name) => {
    const code = newCode();
    rooms[code] = { code, host: null, players: {}, phase: 'lobby', round: 0, rounds: 3, subs: [], votes: {}, timer: null,
      bank: [0, 1, 2, 3].map((n) => ({ id: 'd' + n, url: '/default/' + n, type: 'image' })) };
    join(rooms[code], name);
  });
  socket.on('join', ({ code, name }) => {
    const r = rooms[String(code || '').toUpperCase()];
    if (!r) return socket.emit('err', 'Salon introuvable');
    if (r.phase !== 'lobby') return socket.emit('err', 'Partie déjà commencée');
    if (Object.keys(r.players).length >= MAX_PLAYERS) return socket.emit('err', 'Salon complet (10 max)');
    join(r, name);
  });
  socket.on('setRounds', (n) => {
    if (room && room.host === socket.id && room.phase === 'lobby') { room.rounds = Math.min(10, Math.max(1, Number(n) || 3)); broadcast(room); }
  });
  socket.on('start', () => {
    if (room && room.host === socket.id && room.phase === 'lobby') startRound(room);
  });
  socket.on('reroll', () => {
    const r = room, p = r && r.players[socket.id];
    if (!p || r.phase !== 'create' || p.submitted || p.rerolls >= MAX_REROLL) return;
    p.rerolls++;
    const others = r.bank.filter((m) => m.id !== p.media.id);
    p.media = rand(others.length ? others : r.bank);
    socket.emit('media', { media: pub(p.media), left: MAX_REROLL - p.rerolls });
  });
  socket.on('submit', (texts) => {
    const r = room, p = r && r.players[socket.id];
    if (!p || r.phase !== 'create' || p.submitted || !Array.isArray(texts)) return;
    p.submitted = true;
    const clean = texts.slice(0, 30).map((t) => ({
      t: String(t.t || '').slice(0, 2000), x: +t.x || 50, y: +t.y || 50,
      s: Math.min(40, Math.max(1, +t.s || 8)), c: /^#[0-9a-f]{6}$/i.test(t.c) ? t.c : '#ffffff',
    }));
    r.subs.push({ author: socket.id, name: p.name, media: p.media, texts: clean });
    socket.emit('submitted');
    if (Object.values(r.players).every((x) => x.submitted)) endCreate(r);
  });
  socket.on('vote', (v) => {
    const r = room;
    if (!r || r.phase !== 'vote' || !['top', 'meh', 'flop'].includes(v)) return;
    if (r.subs[r.idx].author === socket.id || r.votes[socket.id]) return;
    r.votes[socket.id] = v;
    checkAllVoted(r);
  });
  socket.on('disconnect', () => {
    const r = room; if (!r) return;
    delete r.players[socket.id];
    const ids = Object.keys(r.players);
    if (!ids.length) return deleteRoom(r);
    if (r.host === socket.id) r.host = ids[0];
    broadcast(r);
    if (r.phase === 'vote') checkAllVoted(r);
    if (r.phase === 'create' && Object.values(r.players).every((x) => x.submitted)) endCreate(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Meme Battle sur http://localhost:' + PORT));