// Морской бой — клиент (чистый JS, поля на div-сетках)
const socket = io();
const $ = s => document.querySelector(s);
const SIZE = 10;
const FLEET = { 4: 1, 3: 2, 2: 3, 1: 4 };

let S = null;                 // последнее состояние от сервера
let session = JSON.parse(sessionStorage.getItem('bs') || 'null'); // {code, playerId} — для переподключения
let timeOffset = 0;           // разница часов клиента и сервера
let lastShot = null;          // последний выстрел — для анимации
let prevPhase = null;
let draft = [];               // локальная расстановка капитана
let selLen = 4, horiz = true;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rand = n => Math.floor(Math.random() * n);
const cellsOf = s => Array.from({ length: s.len }, (_, i) => [s.r + (s.h ? 0 : i), s.c + (s.h ? i : 0)]);

// ---------- Звук (Web Audio API) ----------
let actx, muted = false;
function tone(f1, f2, dur, type = 'sine', vol = 0.15, delay = 0) {
  if (muted) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime + delay, o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur);
  } catch (e) { /* звук не критичен */ }
}
const sounds = {
  miss: () => tone(520, 160, 0.25),
  hit: () => tone(180, 40, 0.4, 'sawtooth', 0.2),
  sunk: () => { tone(180, 40, 0.4, 'sawtooth', 0.2); tone(90, 30, 0.7, 'square', 0.15, 0.15); },
};
$('#mute').onclick = () => { muted = !muted; $('#mute').textContent = 'Звук: ' + (muted ? 'выкл' : 'вкл'); };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2800);
}

function show(name) {
  document.querySelectorAll('.screen').forEach(e => { e.hidden = e.id !== name; });
  $('#chat').hidden = name === 'menu';
}

// ---------- Отрисовка поля ----------
// o: { ships, shots, sunk, click, anim } — ships рисуются заливкой, sunk — красной обводкой
function drawGrid(el, o) {
  const mk = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(-1));
  const shipId = mk(), sunkId = mk();
  (o.ships || []).forEach((s, i) => cellsOf(s).forEach(([r, c]) => { shipId[r][c] = i; }));
  (o.sunk || []).forEach((s, i) => cellsOf(s).forEach(([r, c]) => { sunkId[r][c] = i; }));
  let h = '';
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const sh = o.shots ? o.shots[r][c] : 0, cl = ['c'];
    let style = '';
    if (shipId[r][c] >= 0) cl.push('ship');
    if (sh === 1) cl.push('miss');
    if (sh === 2) cl.push('hit');
    if (sunkId[r][c] >= 0) {
      cl.push('sunk');
      const k = sunkId[r][c], edge = (dr, dc) => (sunkId[r + dr] && sunkId[r + dr][c + dc] === k ? 0 : 1);
      const sh3 = [];
      if (edge(-1, 0)) sh3.push('inset 0 3px 0 0 var(--hit)');
      if (edge(0, 1)) sh3.push('inset -3px 0 0 0 var(--hit)');
      if (edge(1, 0)) sh3.push('inset 0 -3px 0 0 var(--hit)');
      if (edge(0, -1)) sh3.push('inset 3px 0 0 0 var(--hit)');
      style = `box-shadow:${sh3.join(',')}`;
    }
    if (o.anim && o.anim.r === r && o.anim.c === c) cl.push('a-' + o.anim.result);
    if (o.click && !sh) cl.push('tgt');
    h += `<div class="${cl.join(' ')}" data-r="${r}" data-c="${c}" style="${style}"></div>`;
  }
  el.innerHTML = h;
  el.onclick = o.click ? e => { const t = e.target.closest('.c'); if (t) o.click(+t.dataset.r, +t.dataset.c); } : null;
}

// ---------- Меню ----------
$('#name').value = localStorage.getItem('bsname') || '';
const myName = () => { const n = $('#name').value.trim(); localStorage.setItem('bsname', n); return n || 'Игрок'; };
function entered(res) {
  if (!res.ok) return toast(res.error || 'Ошибка');
  session = { code: res.code, playerId: res.playerId };
  sessionStorage.setItem('bs', JSON.stringify(session));
}
$('#createBtn').onclick = () => socket.emit('create_room', { name: myName(), mode: $('input[name=mode]:checked').value }, entered);
$('#joinBtn').onclick = () => socket.emit('join_room', { name: myName(), code: $('#codeInput').value }, entered);
$('#codeInput').onkeydown = e => { if (e.key === 'Enter') $('#joinBtn').click(); };

function toMenu() {
  session = null; S = null; prevPhase = null; sessionStorage.removeItem('bs');
  $('#msgs').innerHTML = ''; show('menu');
}
document.querySelectorAll('.leave').forEach(b => {
  b.onclick = () => {
    if (S && (S.phase === 'placing' || S.phase === 'battle') && !confirm('Выйти из игры? Вашей команде засчитают поражение.')) return;
    socket.emit('leave_room', {}, toMenu);
  };
});

// ---------- Лобби ----------
function renderLobby() {
  show('lobby');
  $('#lCode').textContent = S.code;
  $('#lMode').textContent = S.mode === '1v1' ? '1 на 1' : '2 на 2';
  let h = '';
  for (let i = 0; i < S.need; i++) {
    const p = S.players[i];
    h += p
      ? `<li class="t${p.team}"><span>${esc(p.name)}${p.host ? ' (создатель)' : ''}</span><small>${S.mode === '2v2' ? 'команда ' + (p.team ? 'B' : 'A') : ''}${p.connected ? '' : ' нет связи'}</small></li>`
      : '<li class="empty">Ожидание игрока…</li>';
  }
  $('#lPlayers').innerHTML = h;
}
$('#copyBtn').onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText(S.code).then(() => toast('Код скопирован')); };

// ---------- Расстановка ----------
const left = () => { const o = {}; for (const l of [4, 3, 2, 1]) o[l] = FLEET[l] - draft.filter(s => s.len === l).length; return o; };

// Корабли не должны касаться даже углами
function canPlace(ships, r, c, len, h) {
  const occ = new Set();
  ships.forEach(s => cellsOf(s).forEach(([y, x]) => occ.add(y * SIZE + x)));
  for (const [y, x] of cellsOf({ r, c, len, h })) {
    if (y < 0 || x < 0 || y >= SIZE || x >= SIZE) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && xx >= 0 && yy < SIZE && xx < SIZE && occ.has(yy * SIZE + xx)) return false;
    }
  }
  return true;
}

function randomFleet() {
  for (;;) {
    const ships = []; let ok = true;
    for (const len of [4, 3, 3, 2, 2, 2, 1, 1, 1, 1]) {
      let placed = false;
      for (let i = 0; i < 200 && !placed; i++) {
        const h = Math.random() < 0.5, r = rand(SIZE), c = rand(SIZE);
        if (canPlace(ships, r, c, len, h)) { ships.push({ r, c, len, h }); placed = true; }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return ships;
  }
}

function placeClick(r, c) {
  const i = draft.findIndex(s => cellsOf(s).some(([y, x]) => y === r && x === c));
  if (i >= 0) { selLen = draft.splice(i, 1)[0].len; return renderPlace(); } // снять корабль
  if (!left()[selLen]) return;
  if (!canPlace(draft, r, c, selLen, horiz)) return toast('Корабль не помещается или касается другого');
  draft.push({ r, c, len: selLen, h: horiz });
  if (!left()[selLen]) selLen = [4, 3, 2, 1].find(l => left()[l]) || selLen;
  renderPlace();
}

function renderPlace() {
  show('place');
  const cap = S.me.captain, ready = S.ready[S.me.team], editing = cap && !ready;
  $('#pStatus').textContent = ready ? 'Флот готов. Ждём соперника…' : cap ? 'Расставьте корабли' : 'Капитан расставляет корабли вашей команды';
  drawGrid($('#pgrid'), { ships: editing ? draft : (S.my ? S.my.ships : []), click: editing ? placeClick : null });
  $('#placeTools').hidden = !editing;
  const L = left();
  $('#dock').innerHTML = [4, 3, 2, 1].map(l =>
    `<button data-len="${l}" class="${l === selLen ? 'on' : ''}" ${L[l] ? '' : 'disabled'}>${'■'.repeat(l)} ×${L[l]}</button>`).join('');
  $('#rotBtn').textContent = 'Повернуть: ' + (horiz ? 'горизонтально' : 'вертикально');
  $('#readyBtn').disabled = draft.length !== 10;
}
$('#dock').onclick = e => { const b = e.target.closest('button'); if (b && !b.disabled) { selLen = +b.dataset.len; renderPlace(); } };
$('#rotBtn').onclick = () => { horiz = !horiz; renderPlace(); };
$('#rndBtn').onclick = () => { draft = randomFleet(); renderPlace(); };
$('#clrBtn').onclick = () => { draft = []; selLen = 4; renderPlace(); };
$('#readyBtn').onclick = () => socket.emit('place_ships', { ships: draft }, r => {
  if (!r.ok) return toast(r.error);
  socket.emit('ready', {}, r2 => { if (!r2.ok) toast(r2.error); });
});
// Предпросмотр корабля под курсором (на телефоне не нужен)
$('#pgrid').addEventListener('mouseover', e => {
  const clear = () => document.querySelectorAll('#pgrid .pv, #pgrid .bad').forEach(x => x.classList.remove('pv', 'bad'));
  clear();
  const t = e.target.closest('.c');
  if (!t || !S || !S.me.captain || S.ready[S.me.team] || !left()[selLen]) return;
  const r = +t.dataset.r, c = +t.dataset.c, ok = canPlace(draft, r, c, selLen, horiz);
  cellsOf({ r, c, len: selLen, h: horiz }).forEach(([y, x]) => {
    const el = $(`#pgrid [data-r="${y}"][data-c="${x}"]`);
    if (el) el.classList.add(ok ? 'pv' : 'bad');
  });
});

// ---------- Бой ----------
function shoot(r, c) {
  socket.emit('shoot', { r, c }, res => { if (!res.ok && res.error) toast(res.error); });
}

function renderBattle() {
  show('battle');
  const mine = S.turn === S.me.team;
  const cap = S.players.find(p => p.team === S.turn && p.captain);
  let msg;
  if (mine && S.me.captain) msg = 'Ваш ход: стреляйте по полю врага';
  else if (mine) msg = `Ход вашей команды: стреляет капитан ${cap ? cap.name : ''}`;
  else msg = S.mode === '1v1' ? `Ход соперника: ${cap ? cap.name : ''}` : `Ход команды противников: ${cap ? cap.name : ''}`;
  $('#turn').textContent = msg;
  $('#turn').className = mine ? 'mine' : '';
  $('#enemyTitle').textContent = S.mode === '1v1' ? 'Поле соперника' : 'Поле противников';
  $('#ownTitle').textContent = S.mode === '1v1' ? 'Ваше поле' : 'Поле вашей команды';
  const my = S.my || { ships: [], shots: null }, en = S.enemy || { shots: null, sunk: [] };
  const anim = on => (lastShot && lastShot.on === on ? lastShot : null);
  drawGrid($('#enemyGrid'), { shots: en.shots, sunk: en.sunk, click: mine && S.me.captain ? shoot : null, anim: anim('enemy') });
  drawGrid($('#ownGrid'), { ships: my.ships, shots: my.shots, sunk: my.ships.filter(s => s.sunk), anim: anim('own') });
  lastShot = null;
}

setInterval(() => { // таймер хода
  if (!S || S.phase !== 'battle' || !S.deadline) return;
  const t = Math.max(0, Math.ceil((S.deadline - (Date.now() + timeOffset)) / 1000));
  $('#timer').textContent = t; $('#timer').classList.toggle('low', t <= 10);
}, 250);

// ---------- Результат ----------
function renderResult() {
  show('result');
  const win = S.winner === S.me.team;
  $('#resTitle').textContent = win ? 'Победа' : 'Поражение';
  $('#resTitle').className = win ? 'win' : 'lose';
  $('#resWhy').textContent = {
    fleet: win ? 'Весь вражеский флот уничтожен.' : 'Ваш флот потоплен.',
    disconnect: win ? 'Игрок противника не вернулся за 60 секунд.' : 'Игрок вашей команды не вернулся за 60 секунд.',
    left: win ? 'Игрок противника покинул игру.' : 'Игрок вашей команды покинул игру.',
  }[S.reason] || '';
  const my = S.my || { ships: [], shots: null }, en = S.enemy || { shots: null, sunk: [], ships: [] };
  drawGrid($('#rOwn'), { ships: my.ships, shots: my.shots, sunk: my.ships.filter(s => s.sunk) });
  drawGrid($('#rEnemy'), { ships: en.ships || [], shots: en.shots, sunk: en.sunk });
}

// ---------- События сервера ----------
function route() {
  if (S.phase !== 'battle') lastShot = null;
  ({ lobby: renderLobby, placing: renderPlace, battle: renderBattle, over: renderResult })[S.phase]();
}
socket.on('state', st => {
  S = st; timeOffset = st.now - Date.now();
  if (st.phase !== prevPhase) {
    if (st.phase === 'placing') { draft = []; selLen = 4; horiz = true; }
    prevPhase = st.phase;
  }
  route();
});
socket.on('shot_result', d => {
  sounds[d.result]();
  lastShot = { r: d.r, c: d.c, result: d.result, on: S && d.target === S.me.team ? 'own' : 'enemy' };
});

// ---------- Чат ----------
function addMsg(m) {
  const d = document.createElement('div');
  d.className = 'msg' + (m.system ? ' sys' : '');
  if (m.system) d.textContent = m.text;
  else {
    const b = document.createElement('b'); b.className = 't' + m.team; b.textContent = m.name + ': ';
    d.append(b, document.createTextNode(m.text));
  }
  const box = $('#msgs'); box.append(d); box.scrollTop = box.scrollHeight;
}
socket.on('chat', addMsg);
socket.on('chat_history', h => { $('#msgs').innerHTML = ''; h.forEach(addMsg); });
$('#chatForm').onsubmit = e => {
  e.preventDefault();
  const v = $('#chatInput').value.trim();
  if (v) { socket.emit('chat_message', { text: v }); $('#chatInput').value = ''; }
};

// ---------- Соединение и переподключение ----------
socket.on('connect', () => {
  $('#conn').hidden = true;
  if (session) socket.emit('rejoin', session, res => { if (!res.ok) toMenu(); });
});
socket.on('disconnect', () => { $('#conn').hidden = false; });
show('menu');
