const express = require('express'), http = require('http'), fs = require('fs');
const { Server } = require('socket.io');
const WORDS = [...new Set(require('./words'))];
const TARGET = 'TEAM', MIN = +process.env.MIN_PLAYERS || 3, MAX = 5, LB = 'leaderboard.json';
const app = express(); app.use(express.static('public'));
const server = http.createServer(app), io = new Server(server);

// --- word graph: BFS from TEAM gives the optimal move count for every word ---
const set = new Set(WORDS);
const nb = w => { const r = []; for (let i = 0; i < 4; i++) for (let c = 65; c < 91; c++) { const n = w.slice(0, i) + String.fromCharCode(c) + w.slice(i + 1); if (n !== w && set.has(n)) r.push(n); } return r; };
const dist = { [TARGET]: 0 }, q = [TARGET];
while (q.length) { const w = q.shift(); for (const n of nb(w)) if (!(n in dist)) { dist[n] = dist[w] + 1; q.push(n); } }
const starts = Object.keys(dist).filter(w => dist[w] >= 3 && dist[w] <= 6);

// --- helpers ---
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = a => a[Math.random() * a.length | 0];
const clean = n => String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 12);
function deal(ids) { // vowels dealt first so everyone gets some, then consonants
  const owner = {}; let i = 0;
  for (const l of [...shuffle('AEIOU'.split('')), ...shuffle('BCDFGHJKLMNPQRSTVWXYZ'.split(''))]) owner[l] = ids[i++ % ids.length];
  return owner;
}
let board = fs.existsSync(LB) ? JSON.parse(fs.readFileSync(LB)) : [];
const top = () => board.slice(0, 10);
const rooms = {};
const pub = r => ({ code: r.code, players: r.players, phase: r.phase, word: r.word, moves: r.moves, optimal: r.optimal, owner: r.owner, pending: r.pending, path: r.path, t0: r.t0, result: r.result, min: MIN, max: MAX });

io.on('connection', s => {
  s.emit('board', top());
  const push = r => io.to(r.code).emit('state', pub(r));
  const join = (c, n) => { const r = rooms[c]; s.code = c; s.join(c); r.players.push({ id: s.id, name: clean(n) || 'Player' }); push(r); };

  s.on('create', n => {
    let c; do c = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.random() * 26 | 0)).join(''); while (rooms[c]);
    rooms[c] = { code: c, players: [], phase: 'lobby', pending: null, path: [] }; join(c, n);
  });
  s.on('join', (c, n) => {
    c = String(c).toUpperCase(); const r = rooms[c];
    if (!r) return s.emit('err', 'Room not found. Check the code.');
    if (r.phase !== 'lobby') return s.emit('err', 'That game already started.');
    if (r.players.length >= MAX) return s.emit('err', `Room is full (max ${MAX}).`);
    join(c, n);
  });
  s.on('start', () => {
    const r = rooms[s.code]; if (!r || r.phase !== 'lobby' || r.players[0].id !== s.id) return;
    if (r.players.length < MIN) return s.emit('err', `Need at least ${MIN} players to start.`);
    r.word = pick(starts); r.optimal = dist[r.word]; r.moves = 0; r.path = [r.word]; r.pending = null; r.result = null;
    r.owner = deal(r.players.map(p => p.id)); r.t0 = Date.now(); r.phase = 'play'; push(r);
  });
  const apply = r => {
    const p = r.pending; r.pending = null; r.word = p.word; r.moves++; r.path.push(p.word);
    if (r.word === TARGET) {
      const e = { players: r.players.map(p => p.name).join(', '), moves: r.moves, optimal: r.optimal, extra: r.moves - r.optimal, secs: Math.round((Date.now() - r.t0) / 1000) };
      board.push(e); board.sort((a, b) => a.extra - b.extra || a.secs - b.secs); board = board.slice(0, 50);
      fs.writeFileSync(LB, JSON.stringify(board)); r.result = e; r.phase = 'done'; io.emit('board', top());
    }
    push(r);
  };
  s.on('propose', ({ pos, letter }) => {
    const r = rooms[s.code]; if (!r || r.phase !== 'play' || r.pending) return;
    if (!(pos >= 0 && pos < 4) || !r.owner[letter] || letter === r.word[pos]) return;
    const word = r.word.slice(0, pos) + letter + r.word.slice(pos + 1);
    if (!set.has(word)) return s.emit('err', `${word} isn't in the word list.`);
    r.pending = { word, pos, letter, by: s.id, owner: r.owner[letter] };
    r.pending.by === r.pending.owner ? apply(r) : push(r); // owners can play their own letters directly
  });
  s.on('respond', ok => {
    const r = rooms[s.code]; if (!r || !r.pending || r.pending.owner !== s.id) return;
    if (ok) return apply(r);
    io.to(r.pending.by).emit('err', `${r.pending.word} was declined.`); r.pending = null; push(r);
  });
  s.on('cancel', () => { const r = rooms[s.code]; if (r && r.pending && r.pending.by === s.id) { r.pending = null; push(r); } });
  s.on('again', () => { const r = rooms[s.code]; if (r && r.phase === 'done') { r.phase = 'lobby'; r.pending = null; push(r); } });
  s.on('disconnect', () => {
    const r = rooms[s.code]; if (!r) return;
    r.players = r.players.filter(p => p.id !== s.id);
    if (!r.players.length) return delete rooms[r.code];
    if (r.phase === 'play') { // hand the leaver's letters to the remaining players
      const ids = r.players.map(p => p.id); let i = 0;
      for (const l in r.owner) if (r.owner[l] === s.id) r.owner[l] = ids[i++ % ids.length];
      if (r.pending && (r.pending.by === s.id || r.pending.owner === s.id)) r.pending = null;
    }
    push(r);
  });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TEAM Ladder on http://localhost:${PORT} | ${WORDS.length} words, ${starts.length} valid starts, min players ${MIN}`));
