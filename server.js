// Морской бой — сервер (Node.js + Express + Socket.io)
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const SIZE = 10;
const FLEET = { 4: 1, 3: 2, 2: 3, 1: 4 }; // длина -> количество
const TURN_MS = 60000;                      // время на ход
const RECONNECT_MS = 60000;                 // время на переподключение

// rooms: code -> { id, mode, players[], turnTeam, phase, boards[2], ready[2], ... }
// phase: lobby -> placing -> battle -> over
const rooms = new Map();

// ---------- Вспомогательные функции ----------
const need = room => (room.mode === '1v1' ? 2 : 4);
// 1v1: у каждого своя команда; 2v2: игроки 0,1 — команда 0, игроки 2,3 — команда 1
const teamOf = (room, i) => (room.mode === '1v1' ? i : i >> 1);
// Капитан команды — первый игрок этой команды (он расставляет корабли и стреляет)
const captainOf = (room, t) => room.players.find(p => p.team === t);
const cellsOf = s => Array.from({ length: s.len }, (_, i) => [s.r + (s.h ? 0 : i), s.c + (s.h ? i : 0)]);
const inField = (r, c) => r >= 0 && c >= 0 && r < SIZE && c < SIZE;

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(code));
  return code;
}

// Проверка расстановки: 10 кораблей нужной длины, в поле, не касаются (даже по диагонали)
function buildBoard(ships) {
  if (!Array.isArray(ships) || ships.length !== 10) return null;
  const count = {}, list = [];
  for (const raw of ships) {
    if (!raw || typeof raw !== 'object') return null;
    const s = { r: raw.r | 0, c: raw.c | 0, len: raw.len | 0, h: !!raw.h, hits: 0 };
    if (!FLEET[s.len]) return null;
    count[s.len] = (count[s.len] || 0) + 1;
    list.push(s);
  }
  for (const l in FLEET) if (count[l] !== FLEET[l]) return null;
  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(-1));
  for (let i = 0; i < list.length; i++) {
    for (const [r, c] of cellsOf(list[i])) {
      if (!inField(r, c)) return null;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const y = r + dr, x = c + dc;
        if (inField(y, x) && grid[y][x] !== -1 && grid[y][x] !== i) return null;
      }
      grid[r][c] = i;
    }
  }
  // shots: 0 — не стреляли, 1 — промах, 2 — попадание
  return { grid, ships: list, shots: Array.from({ length: SIZE }, () => Array(SIZE).fill(0)) };
}

// Состояние, видимое конкретному игроку (чужие корабли не раскрываются до конца игры)
function publicState(room, p) {
  const my = room.boards[p.team], en = room.boards[1 - p.team];
  const view = s => ({ r: s.r, c: s.c, len: s.len, h: s.h, sunk: s.hits === s.len });
  return {
    code: room.id, mode: room.mode, need: need(room), phase: room.phase,
    me: { name: p.name, team: p.team, captain: captainOf(room, p.team) === p },
    players: room.players.map(q => ({
      name: q.name, team: q.team, connected: q.connected,
      captain: captainOf(room, q.team) === q, host: q === room.players[0],
    })),
    ready: room.ready, turn: room.turnTeam, deadline: room.deadline, now: Date.now(),
    winner: room.winner, reason: room.reason,
    my: my && { ships: my.ships.map(view), shots: my.shots },
    enemy: en && {
      shots: en.shots,
      sunk: en.ships.filter(s => s.hits === s.len).map(view),
      ships: room.phase === 'over' ? en.ships.map(view) : null,
    },
  };
}

function broadcast(room) {
  for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('state', publicState(room, p));
}

function sys(room, text) {
  const m = { system: true, text, ts: Date.now() };
  room.chat.push(m); if (room.chat.length > 50) room.chat.shift();
  io.to(room.id).emit('chat', m);
}

// Таймер хода: по истечении ход переходит другой команде
function startTurn(room) {
  clearTimeout(room.turnTimer);
  room.deadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    if (room.phase !== 'battle') return;
    sys(room, 'Время хода вышло, ход переходит сопернику.');
    room.turnTeam = 1 - room.turnTeam;
    startTurn(room); broadcast(room);
  }, TURN_MS);
}

function endGame(room, winner, reason) {
  if (room.phase === 'over') return;
  clearTimeout(room.turnTimer);
  Object.assign(room, { phase: 'over', winner, reason, deadline: null });
  broadcast(room);
}

// Игрок окончательно покидает комнату (вышел сам или не вернулся за 60 секунд)
function dropPlayer(room, p, reason) {
  clearTimeout(p.dcTimer);
  if (room.phase === 'placing' || room.phase === 'battle') endGame(room, 1 - p.team, reason); // поражение команде
  room.players = room.players.filter(q => q !== p);
  if (room.phase === 'lobby') room.players.forEach((q, i) => { q.team = teamOf(room, i); });
  if (!room.players.length) { clearTimeout(room.turnTimer); rooms.delete(room.id); return; }
  broadcast(room);
}

function onDisconnect(room, p) {
  p.connected = false; p.socketId = null;
  sys(room, `${p.name} отключился. У него 60 секунд на возвращение.`);
  broadcast(room);
  p.dcTimer = setTimeout(() => {
    sys(room, `${p.name} не вернулся.`);
    dropPlayer(room, p, 'disconnect');
  }, RECONNECT_MS);
}

function addPlayer(room, socket, name) {
  const p = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name || '').trim().slice(0, 16) || 'Игрок',
    socketId: socket.id, connected: true, dcTimer: null,
    team: teamOf(room, room.players.length),
  };
  room.players.push(p);
  socket.join(room.id);
  socket.data = { code: room.id, pid: p.id };
  return p;
}

function ctx(socket) {
  const room = rooms.get(socket.data.code);
  return { room, p: room && room.players.find(x => x.id === socket.data.pid) };
}

// ---------- Socket.io ----------
io.on('connection', socket => {
  const fn = f => (typeof f === 'function' ? f : () => {});

  socket.on('create_room', (d, ack) => {
    ack = fn(ack); d = d || {};
    if (socket.data.code) return ack({ ok: false, error: 'Вы уже в комнате' });
    if (d.mode !== '1v1' && d.mode !== '2v2') return ack({ ok: false, error: 'Неверный режим' });
    const room = {
      id: makeCode(), mode: d.mode, players: [], phase: 'lobby', turnTeam: 0, deadline: null,
      boards: [null, null], ready: [false, false], winner: null, reason: null, chat: [], turnTimer: null,
    };
    rooms.set(room.id, room);
    const p = addPlayer(room, socket, d.name);
    ack({ ok: true, code: room.id, playerId: p.id });
    broadcast(room);
  });

  socket.on('join_room', (d, ack) => {
    ack = fn(ack); d = d || {};
    if (socket.data.code) return ack({ ok: false, error: 'Вы уже в комнате' });
    const room = rooms.get(String(d.code || '').trim().toUpperCase());
    if (!room) return ack({ ok: false, error: 'Комната не найдена' });
    if (room.phase !== 'lobby' || room.players.length >= need(room)) return ack({ ok: false, error: 'Комната заполнена или игра уже идёт' });
    const p = addPlayer(room, socket, d.name);
    socket.emit('chat_history', room.chat);
    sys(room, `${p.name} вошёл в комнату.`);
    ack({ ok: true, code: room.id, playerId: p.id });
    if (room.players.length === need(room)) { // набралось нужное число — начинаем расстановку
      room.phase = 'placing';
      sys(room, 'Все в сборе. Расставьте корабли и нажмите «Готов».');
    }
    broadcast(room);
  });

  // Возвращение после обрыва связи или обновления страницы
  socket.on('rejoin', (d, ack) => {
    ack = fn(ack); d = d || {};
    const room = rooms.get(String(d.code || '').toUpperCase());
    const p = room && room.players.find(x => x.id === d.playerId);
    if (!p) return ack({ ok: false });
    clearTimeout(p.dcTimer);
    const wasOff = !p.connected;
    p.socketId = socket.id; p.connected = true;
    socket.join(room.id);
    socket.data = { code: room.id, pid: p.id };
    ack({ ok: true });
    socket.emit('chat_history', room.chat);
    if (wasOff) sys(room, `${p.name} вернулся в игру.`);
    broadcast(room);
  });

  socket.on('leave_room', (_, ack) => {
    const { room, p } = ctx(socket);
    if (room && p) {
      socket.leave(room.id); socket.data = {};
      sys(room, `${p.name} покинул комнату.`);
      dropPlayer(room, p, 'left');
    }
    fn(ack)({ ok: true });
  });

  socket.on('place_ships', (d, ack) => {
    ack = fn(ack);
    const { room, p } = ctx(socket);
    if (!room || room.phase !== 'placing') return ack({ ok: false, error: 'Сейчас нельзя расставлять корабли' });
    if (captainOf(room, p.team) !== p) return ack({ ok: false, error: 'Корабли расставляет капитан команды' });
    if (room.ready[p.team]) return ack({ ok: false, error: 'Вы уже готовы' });
    const board = buildBoard(d && d.ships);
    if (!board) return ack({ ok: false, error: 'Неверная расстановка' });
    room.boards[p.team] = board;
    ack({ ok: true }); broadcast(room);
  });

  socket.on('ready', (_, ack) => {
    ack = fn(ack);
    const { room, p } = ctx(socket);
    if (!room || room.phase !== 'placing' || captainOf(room, p.team) !== p) return ack({ ok: false, error: 'Нельзя' });
    if (!room.boards[p.team]) return ack({ ok: false, error: 'Сначала расставьте корабли' });
    room.ready[p.team] = true;
    ack({ ok: true });
    if (room.ready[0] && room.ready[1]) {
      room.phase = 'battle';
      room.turnTeam = crypto.randomInt(2);
      sys(room, 'Бой начался!');
      startTurn(room);
    }
    broadcast(room);
  });

  socket.on('shoot', (d, ack) => {
    ack = fn(ack); d = d || {};
    const { room, p } = ctx(socket);
    if (!room || room.phase !== 'battle') return ack({ ok: false });
    if (room.turnTeam !== p.team) return ack({ ok: false, error: 'Сейчас не ваш ход' });
    if (captainOf(room, p.team) !== p) return ack({ ok: false, error: 'Стреляет капитан команды' });
    const { r, c } = d;
    if (!Number.isInteger(r) || !Number.isInteger(c) || !inField(r, c)) return ack({ ok: false, error: 'Неверная клетка' });
    const target = 1 - p.team, b = room.boards[target];
    if (b.shots[r][c]) return ack({ ok: false, error: 'Сюда уже стреляли' });

    let result = 'miss';
    const si = b.grid[r][c];
    if (si >= 0) {
      const s = b.ships[si];
      b.shots[r][c] = 2; s.hits++; result = 'hit';
      if (s.hits === s.len) { // корабль убит: клетки вокруг автоматически помечаются как промахи
        result = 'sunk';
        for (const [y, x] of cellsOf(s)) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          if (inField(y + dr, x + dc) && b.shots[y + dr][x + dc] === 0) b.shots[y + dr][x + dc] = 1;
        }
      }
    } else b.shots[r][c] = 1;

    ack({ ok: true });
    io.to(room.id).emit('shot_result', { shooter: p.team, target, r, c, result });
    if (result === 'sunk' && b.ships.every(s => s.hits === s.len)) return endGame(room, p.team, 'fleet');
    if (result === 'miss') room.turnTeam = target; // попал — стреляет ещё раз
    startTurn(room); broadcast(room);
  });

  socket.on('chat_message', d => {
    const { room, p } = ctx(socket);
    const text = String((d && d.text) || '').trim().slice(0, 200);
    if (!room || !p || !text) return;
    const m = { name: p.name, team: p.team, text, ts: Date.now() };
    room.chat.push(m); if (room.chat.length > 50) room.chat.shift();
    io.to(room.id).emit('chat', m);
  });

  socket.on('disconnect', () => {
    const { room, p } = ctx(socket);
    if (room && p && p.socketId === socket.id) onDisconnect(room, p); // игнорируем «старые» сокеты
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Морской бой: http://localhost:${PORT}`));
