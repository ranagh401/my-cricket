'use strict';
// MY CRICKET server: serves the browser client and runs matches over WebSocket.
// Zero dependencies: a small RFC 6455 WebSocket implementation lives in this file.
//
//   node server.js            (PORT=5055 by default; the next free port is used if it is taken)
//
// Protocol (JSON text frames). Client -> server:
//   { t:'hello', name, token? }  { t:'name', name }  { t:'create', overs, wickets, reviews }  { t:'join', code }  { t:'leave' }
//   { t:'team', name, squad:[ids] }  { t:'teamAuto' }  { t:'call', side }  { t:'choose', pick }  { t:'bowler', id }
//   { t:'bowl', line, length, pace, timing }  { t:'shot', dir, kind, at }  (at = ms after release when the bat was swung)
//   { t:'review' }  { t:'accept' }  { t:'rematch' }  { t:'lobby' }  { t:'ping' }
// Server -> client:
//   { t:'welcome', id, token, name }   { t:'lobby', matches:[{code, host, overs, wickets, reviews}] }
//   { t:'update', you, state, events }  (state = engine snapshot, events = what just happened)
//   { t:'error', message }   { t:'pong' }

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Match, EngineError } = require('./engine.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
};
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cleanName = (raw) => String(raw || '').replace(/[^\w .'-]/g, '').trim().slice(0, 16) || 'Player';

function loadPool() {
  try { return require('./public/players.js'); } catch (e) { return []; }
}

// ------------------------------------------------------------------ minimal WebSocket (server side)
class WebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragments = null;
    this.fragOp = 0;
    this.alive = true;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.finish());
    socket.on('end', () => this.finish());
    socket.on('error', () => this.finish());
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.parseFrame();
      if (frame === null) return;
      if (frame === 'bad') { this.close(1002); return; }
      this.handleFrame(frame);
      if (this.closed) return;
    }
  }

  parseFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return null;
      if (b.readUInt32BE(2) !== 0) return 'bad';
      len = b.readUInt32BE(6); off = 10;
    }
    if (!masked || len > MAX_MESSAGE) return 'bad';
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
    this.buffer = b.subarray(off + 4 + len);
    return { fin, op, payload };
  }

  handleFrame({ fin, op, payload }) {
    if (op === 0x8) { this.sendFrame(0x8, payload.subarray(0, 2)); this.finish(); return; }
    if (op === 0x9) { this.sendFrame(0xA, payload); return; }
    if (op === 0xA) { this.alive = true; return; }
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      if (op !== 0x0) {
        if (this.fragments) { this.close(1002); return; }
        this.fragOp = op; this.fragments = [payload];
      } else {
        if (!this.fragments) { this.close(1002); return; }
        this.fragments.push(payload);
      }
      if (!fin) return;
      const data = Buffer.concat(this.fragments);
      const isText = this.fragOp === 0x1;
      this.fragments = null;
      if (isText) this.emit('message', data.toString('utf8'));
      return;
    }
    this.close(1002);
  }

  sendFrame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { this.finish(); }
  }

  send(text) { this.sendFrame(0x1, Buffer.from(String(text), 'utf8')); }
  ping() { this.alive = false; this.sendFrame(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.closed) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code, 0);
    this.sendFrame(0x8, b);
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(); } catch { /* ignore */ }
    setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, 1000).unref();
    this.emit('close');
  }
}

function acceptUpgrade(req, socket, head, onConnection) {
  const key = req.headers['sec-websocket-key'];
  const origin = req.headers.origin;
  let originOk = true;
  if (origin) {
    try { originOk = new URL(origin).host === req.headers.host; } catch { originOk = false; }
  }
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !originOk) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const ws = new WebSocket(socket);
  onConnection(ws);
  if (head && head.length) ws.onData(head);
}

// ------------------------------------------------------------------ static files
function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch { urlPath = '/'; }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// Addresses other devices on the network can use. Wi-Fi style adapters first, virtual ones last.
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const n = name.toLowerCase();
      const rank = /wi-?fi|wlan|wireless/.test(n) ? 0 : /vethernet|hyper-v|wsl|virtual|vmware|docker|local area connection\*/.test(n) ? 2 : 1;
      out.push({ name, address: a.address, rank });
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map(({ name, address }) => ({ name, address }));
}

// ------------------------------------------------------------------ game server
function start(options = {}) {
  const basePort = Number(options.port ?? process.env.PORT ?? 5055);
  const host = options.host ?? '0.0.0.0';
  const timeScale = Number(options.timeScale ?? process.env.CRICKET_TIME_SCALE ?? 1) || 1;
  const graceMs = Number(options.graceMs ?? process.env.CRICKET_GRACE_MS ?? 60000);
  const pool = options.pool || loadPool();
  const quiet = !!options.quiet;
  const log = (...a) => { if (!quiet) console.log(...a); };

  const players = new Map();     // token -> player { id, token, name, ws, matchCode, graceTimer }
  const byId = new Map();        // id -> the same player objects
  const matches = new Map();     // code -> { match, timer }
  const sockets = new Set();
  const forget = (player) => { players.delete(player.token); byId.delete(player.id); };

  const send = (ws, msg) => { if (ws && !ws.closed) ws.send(JSON.stringify(msg)); };
  const lobbyList = () => [...matches.values()].filter((e) => e.match.phase === 'waiting')
    .map((e) => ({ code: e.match.code, host: e.match.name(0), overs: e.match.settings.overs, wickets: e.match.settings.wickets, reviews: e.match.settings.reviews }));
  const broadcastLobby = () => {
    const msg = { t: 'lobby', matches: lobbyList() };
    for (const p of players.values()) if (!p.matchCode) send(p.ws, msg);
  };

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!matches.has(code)) return code;
    }
  }

  function broadcast(entry, events) {
    const state = entry.match.snapshot();
    entry.match.players.forEach((p, slot) => {
      if (!p) return;
      const player = byId.get(p.id);
      if (player) send(player.ws, { t: 'update', you: slot, state, events });
    });
  }

  function schedule(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    if (!matches.has(entry.match.code)) return;
    const pending = entry.match.pendingAction();
    if (!pending) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      let events = [];
      try { events = entry.match.perform(pending.action); } catch (e) { log('engine error', e); }
      if (events.length) broadcast(entry, events);
      schedule(entry);
    }, pending.delayMs);
  }

  // Removes a player from their match (they left, or their reconnection grace ran out).
  function leaveMatch(player, reason) {
    const entry = player.matchCode ? matches.get(player.matchCode) : null;
    player.matchCode = null;
    if (!entry) return;
    let events = [];
    try { events = entry.match.removePlayer(player.id); } catch (e) { log('engine error', e); }
    if (events.length) broadcast(entry, events);
    if (!entry.match.players.some(Boolean)) { clearTimeout(entry.timer); matches.delete(entry.match.code); }
    else schedule(entry);
    log(`- ${player.name} left ${entry.match.code} (${reason})`);
    broadcastLobby();
  }

  function act(player, fn) {
    const entry = player.matchCode ? matches.get(player.matchCode) : null;
    if (!entry) { send(player.ws, { t: 'error', message: 'You are not in a match.' }); return; }
    let events;
    try { events = fn(entry.match); }
    catch (e) {
      if (e instanceof EngineError) { send(player.ws, { t: 'error', message: e.message }); return; }
      log('engine error', e);
      send(player.ws, { t: 'error', message: 'Something went wrong on the server.' });
      return;
    }
    if (events && events.length) broadcast(entry, events);
    schedule(entry);
  }

  function handle(ws, player, msg) {
    switch (msg.t) {
      case 'lobby': send(ws, { t: 'lobby', matches: lobbyList() }); return;
      case 'ping': send(ws, { t: 'pong' }); return;
      case 'name':
        if (player.matchCode) { send(ws, { t: 'error', message: 'You can change your name between matches.' }); return; }
        player.name = cleanName(msg.name);
        return;
      case 'create': {
        if (player.matchCode) { send(ws, { t: 'error', message: 'Leave your current match first.' }); return; }
        const code = newCode();
        const match = new Match({ id: code, code, overs: msg.overs, wickets: msg.wickets, reviews: msg.reviews, pool, timeScale });
        const entry = { match, timer: null };
        matches.set(code, entry);
        const { events } = match.addPlayer({ id: player.id, name: player.name });
        player.matchCode = code;
        broadcast(entry, events);
        broadcastLobby();
        log(`+ ${player.name} created ${code} (${match.settings.overs} ov, ${match.settings.wickets} wkts, ${match.settings.reviews} reviews)`);
        return;
      }
      case 'join': {
        if (player.matchCode) { send(ws, { t: 'error', message: 'Leave your current match first.' }); return; }
        const code = String(msg.code || '').trim().toUpperCase();
        const entry = matches.get(code);
        if (!entry) { send(ws, { t: 'error', message: `No match with code ${code || '(blank)'}.` }); return; }
        let events;
        try { ({ events } = entry.match.addPlayer({ id: player.id, name: player.name })); }
        catch (e) { send(ws, { t: 'error', message: e instanceof EngineError ? e.message : 'Could not join.' }); return; }
        player.matchCode = code;
        broadcast(entry, events);
        schedule(entry);
        broadcastLobby();
        log(`+ ${player.name} joined ${code}`);
        return;
      }
      case 'leave':
        leaveMatch(player, 'left');
        send(ws, { t: 'lobby', matches: lobbyList() });
        return;
      case 'team': act(player, (m) => m.setTeam(player.id, { name: msg.name, squad: msg.squad })); return;
      case 'teamAuto': act(player, (m) => m.autoTeam(player.id)); return;
      case 'call': act(player, (m) => m.callToss(player.id, msg.side)); return;
      case 'choose': act(player, (m) => m.chooseToss(player.id, msg.pick)); return;
      case 'bowler': act(player, (m) => m.chooseBowler(player.id, String(msg.id || ''))); return;
      case 'bowl': act(player, (m) => m.bowl(player.id, { line: msg.line, length: msg.length, pace: msg.pace, timing: msg.timing })); return;
      case 'shot': act(player, (m) => m.shot(player.id, { dir: msg.dir, kind: msg.kind, t: msg.at })); return;
      case 'review': act(player, (m) => m.review(player.id)); return;
      case 'accept': act(player, (m) => m.accept(player.id)); return;
      case 'rematch': act(player, (m) => m.requestRematch(player.id)); return;
      default: send(ws, { t: 'error', message: `Unknown message ${String(msg.t)}` });
    }
  }

  function onConnection(ws) {
    sockets.add(ws);
    let player = null;
    ws.on('message', (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { send(ws, { t: 'error', message: 'Bad JSON.' }); return; }
      if (!msg || typeof msg !== 'object') return;
      if (!player) {
        if (msg.t !== 'hello') { send(ws, { t: 'error', message: 'Say hello first.' }); return; }
        const name = cleanName(msg.name);
        const existing = msg.token && players.get(String(msg.token));
        if (existing) {
          player = existing;
          clearTimeout(player.graceTimer);
          player.graceTimer = null;
          if (player.ws && player.ws !== ws) player.ws.close(1000);
          player.ws = ws;
          if (!player.matchCode) player.name = name;
        } else {
          player = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name, ws, matchCode: null, graceTimer: null };
          players.set(player.token, player);
          byId.set(player.id, player);
        }
        send(ws, { t: 'welcome', id: player.id, token: player.token, name: player.name });
        const entry = player.matchCode ? matches.get(player.matchCode) : null;
        if (entry) {
          const events = entry.match.setConnected(player.id, true);
          broadcast(entry, events);
          schedule(entry);
        } else {
          player.matchCode = null;
          send(ws, { t: 'lobby', matches: lobbyList() });
        }
        return;
      }
      handle(ws, player, msg);
    });
    ws.on('close', () => {
      sockets.delete(ws);
      if (!player || player.ws !== ws) return;
      player.ws = null;
      const entry = player.matchCode ? matches.get(player.matchCode) : null;
      if (!entry) { forget(player); return; }
      if (entry.match.phase === 'waiting' || entry.match.phase === 'finished') {
        leaveMatch(player, 'disconnected');
        forget(player);
        return;
      }
      broadcast(entry, entry.match.setConnected(player.id, false));
      player.graceTimer = setTimeout(() => {
        player.graceTimer = null;
        if (player.ws) return;
        leaveMatch(player, 'connection lost');
        forget(player);
      }, graceMs);
    });
  }

  const server = http.createServer((req, res) => {
    if (req.url && req.url.split('?')[0] === '/urls') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ port: server.address().port, addresses: lanAddresses() }));
      return;
    }
    serveStatic(req, res);
  });
  server.on('upgrade', (req, socket, head) => acceptUpgrade(req, socket, head, onConnection));

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (ws.closed) { sockets.delete(ws); continue; }
      if (!ws.alive) { ws.finish(); continue; }
      ws.ping();
    }
  }, 20000);
  heartbeat.unref();

  return new Promise((resolve, reject) => {
    let port = basePort;
    let attempts = 0;
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && basePort !== 0 && attempts++ < 20) { port += 1; tryListen(); return; }
        reject(err);
      });
      server.listen(port, host, () => {
        server.removeAllListeners('error');
        const actual = server.address().port;
        const close = () => new Promise((done) => {
          clearInterval(heartbeat);
          for (const e of matches.values()) clearTimeout(e.timer);
          for (const p of players.values()) clearTimeout(p.graceTimer);
          for (const ws of sockets) ws.finish();
          server.close(() => done());
        });
        resolve({ server, port: actual, close, addresses: lanAddresses(), poolSize: pool.length });
      });
    };
    tryListen();
  });
}

if (require.main === module) {
  start().then(({ port, addresses, poolSize }) => {
    console.log('');
    console.log('  MY CRICKET is running.');
    console.log('');
    console.log(`  On this computer:   http://localhost:${port}`);
    if (addresses.length) {
      console.log('  Friends on your wifi open one of these:');
      for (const a of addresses) console.log(`    http://${a.address}:${port}    (${a.name})`);
    } else {
      console.log('  No network address found. Connect to a wifi network and restart.');
    }
    console.log('');
    if (!poolSize) console.log('  WARNING: public/players.js is missing, team building will not work.');
    console.log('  If Windows asks, click "Allow access" so other devices can connect.');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  }).catch((err) => {
    console.error('Could not start the server:', err.message);
    process.exit(1);
  });
}

module.exports = { start, lanAddresses, loadPool };
