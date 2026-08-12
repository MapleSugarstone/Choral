// Choral matchmaking and relay. No dependencies.
//
// Pairs players, tracks whose turn it is, owns the two clocks. It does not know
// the rules. Both clients run the engine and check each other's moves.
//
// node server.js   listens on 8790. Cloud Run sets PORT.

const http = require('http');
const crypto = require('crypto');

const num = (name, dflt) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const POOL_SECONDS = num('POOL_SECONDS', 600);   // each side's clock
const INCREMENT = num('INCREMENT', 2);           // added for every piece placed
const POLL_HOLD_MS = num('POLL_HOLD_MS', 25000); // how long a waiting request is held open
const ROOM_IDLE_MS = num('ROOM_IDLE_MS', 45 * 60 * 1000);
const SEEK_IDLE_MS = num('SEEK_IDLE_MS', 5 * 60 * 1000);

const MAX_PLAYERS = num('MAX_PLAYERS', 10);      // past this, arrivals are told it is full
// A household shares one public address, so this is really seats per household.
const MAX_SEATS_PER_IP = num('MAX_SEATS_PER_IP', 3);
// Sits above MAX_PLAYERS so a full lobby can still hold every poll open. At the
// ceiling, polls are answered at once and clients fall into fast re-asking.
const MAX_WAITING = num('MAX_WAITING', MAX_PLAYERS + 10);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

const BOARDS = new Set([7, 9, 11]);
const NAME_OK = /^[A-Za-z0-9 _-]{1,16}$/;
const CODE_OK = /^[A-Z0-9]{8}$/;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const rooms = new Map();        // code -> room
const seats = new Map();        // token -> {code, seat, ip}
const buckets = new Map();      // ip -> {tokens, last}
let queue = [];                 // {token, at} waiting for a random game
let waiting = 0;                // requests currently held open
let globalBucket = { tokens: 600, last: Date.now() };

const now = () => Date.now();
const fresh = () => crypto.randomBytes(24).toString('base64url');

function freshCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 8; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}

// Token bucket. Waiting costs less than asking, so polling is not punished.
function allow(ip, cost, cap = 40, refill = 8) {
  const t = now();
  const b = buckets.get(ip) || { tokens: cap, last: t };
  b.tokens = Math.min(cap, b.tokens + ((t - b.last) / 1000) * refill);
  b.last = t;
  buckets.set(ip, b);
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}

// Backstop across everyone, since an address can be faked in a header.
function allowGlobal(cost) {
  const t = now();
  globalBucket.tokens = Math.min(600, globalBucket.tokens + ((t - globalBucket.last) / 1000) * 100);
  globalBucket.last = t;
  if (globalBucket.tokens < cost) return false;
  globalBucket.tokens -= cost;
  return true;
}

const players = () => seats.size;
const seatsFrom = ip => { let n = 0; for (const s of seats.values()) if (s.ip === ip) n++; return n; };

function newRoom(code, priv, board) {
  return {
    code, private: priv, board, version: 1,
    names: [null, null],          // by seat, 0 is red and moves first
    present: [false, false],
    moves: [],                    // {c: cell, d: 0 or 1}
    clock: [POOL_SECONDS, POOL_SECONDS],
    turn: 0,
    started: null,
    stamp: null,                  // when the clock last started running
    over: null,                   // {why, winner}
    touched: now(),
  };
}

// Deduct time from the mover. Runs before every turn change and every read, so a
// player who walks away runs down in real time.
function charge(room) {
  if (room.over || room.stamp === null) return;
  const t = now();
  const spent = (t - room.stamp) / 1000;
  room.stamp = t;
  const seat = room.turn;
  room.clock[seat] = Math.max(0, room.clock[seat] - spent);
  if (room.clock[seat] <= 0) {
    room.over = { why: 'time', winner: 1 - seat };
    room.version++;
  }
}

function view(room, seat) {
  charge(room);
  return {
    code: room.code, board: room.board, version: room.version, seat,
    names: room.names, present: room.present,
    moves: room.moves, turn: room.turn,
    clock: [Math.round(room.clock[0] * 100) / 100, Math.round(room.clock[1] * 100) / 100],
    started: room.started !== null,
    over: room.over,
    increment: INCREMENT, pool: POOL_SECONDS,
  };
}

function startIfReady(room) {
  if (room.started === null && room.present[0] && room.present[1]) {
    room.started = now();
    room.stamp = now();
    room.version++;
  }
}

function dropRoom(code) {
  rooms.delete(code);
  for (const [tok, at] of seats) if (at.code === code) seats.delete(tok);
  queue = queue.filter(q => seats.has(q.token));
}

function sweep() {
  const t = now();
  for (const [code, room] of rooms) if (t - room.touched > ROOM_IDLE_MS) dropRoom(code);
  queue = queue.filter(q => {
    if (!seats.has(q.token)) return false;
    if (t - q.at <= SEEK_IDLE_MS) return true;
    const at = seats.get(q.token);
    seats.delete(q.token);
    if (at) { const r = rooms.get(at.code); if (r && r.started === null) rooms.delete(at.code); }
    return false;
  });
  if (buckets.size > 5000) {
    for (const [ip, b] of buckets) if (t - b.last > 10 * 60 * 1000) buckets.delete(ip);
  }
}

function send(res, code, body) {
  if (res.writableEnded) return;
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': raw.length,
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(raw);
}

// Replying to a POST while the client is still sending resets its NEXT request.
// Rejections drain the body and wait for the end of it first.
function bail(req, res, code, body) {
  if (req.method === 'POST' && !req.readableEnded) {
    req.resume();
    req.once('end', () => send(res, code, body));
    req.once('error', () => {});
    return;
  }
  send(res, code, body);
}

const KILLED = Symbol('killed');   // body past the cap, socket already cut

function readBody(req) {
  return new Promise(resolve => {
    let n = 0; const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > 2048) { parts.length = 0; req.destroy(); resolve(KILLED); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString() || '{}')); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function seatOf(token) {
  const at = seats.get(token);
  if (!at) return {};
  const room = rooms.get(at.code);
  if (!room) return {};
  return { room, seat: at.seat, code: at.code };
}

// Cloud Run's frontend appends the caller's real address to whatever the caller
// already put in the header, so only the last entry can be believed. Anything
// earlier is client supplied, and trusting it would let one caller pose as a
// fresh address on every request.
function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  const raw = fwd ? String(fwd).split(',').pop().trim() : req.socket.remoteAddress;
  return (raw || 'unknown').slice(0, 45);
}

function boardOf(body) {
  const b = parseInt(body.board, 10);
  return BOARDS.has(b) ? b : 9;
}

// ---- joining ---------------------------------------------------------------
function doSeek(res, body, priv, ip) {
  const name = String(body.name || '').trim();
  if (!NAME_OK.test(name))
    return send(res, 400, { error: 'names are 1 to 16 letters, digits, space, dash or underscore' });
  const board = boardOf(body);
  sweep();
  if (seatsFrom(ip) >= MAX_SEATS_PER_IP)
    return send(res, 429, { error: 'you already have a game open' });
  if (players() >= MAX_PLAYERS)
    return send(res, 503, { error: 'the lobbies are full for now', full: true });

  if (priv) {
    const code = freshCode();
    const room = newRoom(code, true, board);
    rooms.set(code, room);
    const token = fresh();
    seats.set(token, { code, seat: 0, ip });
    room.names[0] = name; room.present[0] = true;
    return send(res, 200, { token, code, seat: 0, state: view(room, 0) });
  }

  // pair with the oldest seeker waiting on the same board
  for (let i = 0; i < queue.length; i++) {
    const at = seats.get(queue[i].token);
    if (!at) { queue.splice(i--, 1); continue; }
    const room = rooms.get(at.code);
    if (!room || room.present[1] || room.board !== board) continue;
    queue.splice(i, 1);
    const token = fresh();
    seats.set(token, { code: at.code, seat: 1, ip });
    room.names[1] = name; room.present[1] = true;
    room.touched = now();
    startIfReady(room);
    return send(res, 200, { token, code: at.code, seat: 1, state: view(room, 1) });
  }

  const code = freshCode();
  const room = newRoom(code, false, board);
  rooms.set(code, room);
  const token = fresh();
  seats.set(token, { code, seat: 0, ip });
  room.names[0] = name; room.present[0] = true;
  queue.push({ token, at: now() });
  return send(res, 200, { token, code, seat: 0, state: view(room, 0) });
}

function doJoin(res, body, ip) {
  const name = String(body.name || '').trim();
  const code = String(body.code || '').trim().toUpperCase();
  if (!NAME_OK.test(name))
    return send(res, 400, { error: 'names are 1 to 16 letters, digits, space, dash or underscore' });
  if (!CODE_OK.test(code)) return send(res, 400, { error: 'a code is eight letters or digits' });
  sweep();
  if (seatsFrom(ip) >= MAX_SEATS_PER_IP)
    return send(res, 429, { error: 'you already have a game open' });
  const room = rooms.get(code);
  if (!room) return send(res, 404, { error: 'no game with that code' });
  if (room.present[1]) return send(res, 409, { error: 'that game is already full' });
  if (players() >= MAX_PLAYERS)
    return send(res, 503, { error: 'the lobbies are full for now', full: true });
  const token = fresh();
  seats.set(token, { code, seat: 1, ip });
  room.names[1] = name; room.present[1] = true;
  room.touched = now();
  queue = queue.filter(q => (seats.get(q.token) || {}).code !== code);
  startIfReady(room);
  return send(res, 200, { token, code, seat: 1, state: view(room, 1) });
}

// ---- playing ---------------------------------------------------------------
// POSTed now, so the token stays out of the URL: Cloud Run writes every request
// line to its logs, and a query string would leave live seat tokens in them.
// The GET form still answers, for pages loaded before a redeploy.
function doState(res, query, body) {
  const token = String(body.token || query.get('token') || '');
  const since = parseInt(body.since || query.get('since') || '0', 10) || 0;
  if (waiting >= MAX_WAITING) {
    const { room, seat } = seatOf(token);
    if (!room) return send(res, 404, { error: 'that game is gone' });
    return send(res, 200, view(room, seat));          // answer at once rather than hold
  }
  const deadline = now() + POLL_HOLD_MS;
  let counted = true;
  waiting++;
  const done = (code, body) => { if (counted) { waiting--; counted = false; } send(res, code, body); };
  res.on('close', () => { if (counted) { waiting--; counted = false; } });
  const look = () => {
    if (!counted) return;                              // caller hung up
    const { room, seat } = seatOf(token);
    if (!room) return done(404, { error: 'that game is gone' });
    room.touched = now();
    charge(room);
    if (room.version > since || now() >= deadline) return done(200, view(room, seat));
    setTimeout(look, 250);
  };
  look();
}

function doMove(res, body) {
  const token = String(body.token || '');
  const cell = body.cell;
  const deus = !!body.deus;
  if (!Number.isInteger(cell) || cell < -1 || cell > 120)
    return send(res, 400, { error: 'that is not a square' });
  const { room, seat } = seatOf(token);
  if (!room) return send(res, 404, { error: 'that game is gone' });
  charge(room);
  if (room.over) return send(res, 409, { error: 'that game is finished', state: view(room, seat) });
  if (room.started === null) return send(res, 409, { error: 'still waiting for the other player' });
  if (room.turn !== seat) return send(res, 409, { error: 'not your turn', state: view(room, seat) });
  if (cell >= room.board * room.board) return send(res, 400, { error: 'that square is off the board' });
  if (room.moves.length > 2 * room.board * room.board)
    return send(res, 409, { error: 'that game has gone on long enough' });
  room.moves.push({ c: cell, d: deus ? 1 : 0 });
  room.clock[seat] += INCREMENT;
  room.turn = 1 - seat;
  room.stamp = now();
  room.version++;
  room.touched = now();
  return send(res, 200, view(room, seat));
}

function doResign(res, body) {
  const { room, seat } = seatOf(String(body.token || ''));
  if (!room) return send(res, 404, { error: 'that game is gone' });
  if (!room.over) { room.over = { why: 'resign', winner: 1 - seat }; room.version++; }
  return send(res, 200, view(room, seat));
}

function doCancel(res, body) {
  const token = String(body.token || '');
  const { room, code } = seatOf(token);
  queue = queue.filter(q => q.token !== token);
  seats.delete(token);
  if (room && room.started === null) rooms.delete(code);
  return send(res, 200, { ok: true });
}

// ---- routing ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return bail(req, res, 400, { error: 'bad request' }); }
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    req.resume();
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'POST')
    return bail(req, res, 405, { error: 'method not allowed' });

  if (path === '/api/health')
    return bail(req, res, 200, {
      ok: true, players: players(), capacity: MAX_PLAYERS,
      rooms: rooms.size, queued: queue.length, waiting,
    });

  const cost = path === '/api/state' ? 0.25 : 2;
  if (!allowGlobal(cost)) return bail(req, res, 429, { error: 'the server is busy, try again shortly' });
  if (!allow(ipOf(req), cost)) return bail(req, res, 429, { error: 'slow down' });

  let body = {};
  if (req.method === 'POST') {
    body = await readBody(req);
    if (body === KILLED) return;                 // the socket is already gone
    if (body === null) return send(res, 400, { error: 'bad request' });
  }
  const ip = ipOf(req);
  switch (path) {
    case '/api/seek':   return doSeek(res, body, false, ip);
    case '/api/host':   return doSeek(res, body, true, ip);
    case '/api/join':   return doJoin(res, body, ip);
    case '/api/state':  return doState(res, url.searchParams, body);
    case '/api/move':   return doMove(res, body);
    case '/api/resign': return doResign(res, body);
    case '/api/cancel': return doCancel(res, body);
    default:            return send(res, 404, { error: 'no such thing' });
  }
});

// Bound stalled connections. Deliberately no maxConnections: Node answers past it
// by destroying the socket with no reply, and its count includes sockets that are
// still closing, so short bursts trip it well under real load.
server.headersTimeout = 10000;
server.requestTimeout = 20000;
server.keepAliveTimeout = 30000;
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

setInterval(sweep, 60000).unref();

const port = num('PORT', 8790);
server.listen(port, () => console.log(
  `Choral server on ${port}, room for ${MAX_PLAYERS} players, origin ${ALLOW_ORIGIN}`));
