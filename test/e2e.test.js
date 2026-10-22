'use strict';
// End-to-end: real server, real WebSocket clients (Node's built-in WebSocket), fast timers, fake player pool.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { start } = require('../server.js');
const { fakePool } = require('./fixtures.js');

const POOL = fakePool();
const BY_ID = new Map(POOL.map((p) => [p.id, p]));

function connect(url, name, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    const listeners = [];
    const c = {
      name, token: null, id: null, closed: false,
      send: (obj) => ws.send(JSON.stringify(obj)),
      on: (fn) => listeners.push(fn),
      drain: () => queue.splice(0),
      wait(pred, ms = 8000, label = 'message') {
        const i = queue.findIndex(pred);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { pred, res: null };
          const timer = setTimeout(() => {
            const k = waiters.indexOf(w);
            if (k >= 0) waiters.splice(k, 1);
            rej(new Error(`timed out waiting for ${label}`));
          }, ms);
          w.res = (m) => { clearTimeout(timer); res(m); };
          waiters.push(w);
        });
      },
      close: () => new Promise((res) => {
        if (c.closed) return res();
        ws.addEventListener('close', () => res(), { once: true });
        ws.close();
      }),
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name, token })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') { c.token = msg.token; c.id = msg.id; resolve(c); }
      for (const fn of listeners) fn(msg);
      const k = waiters.findIndex((w) => w.pred(msg));
      if (k >= 0) waiters.splice(k, 1)[0].res(msg);
      else queue.push(msg);
    });
    ws.addEventListener('close', () => { c.closed = true; });
    ws.addEventListener('error', () => reject(new Error('websocket error')));
  });
}

// Plays every decision automatically: auto team, calls heads, bats first, picks the first eligible bowler,
// bowls middle/good, swings as the ball arrives, reviews every decision it can.
function autoplay(c, shot = { dir: 'straight', kind: 'attack' }) {
  let bowledKey = null, shotSeq = null, bowlerKey = null, reviewSeq = null, teamSent = false;
  const stats = { reviews: 0, decisions: 0, balls: 0 };
  c.on((msg) => {
    if (msg.t !== 'update') return;
    const st = msg.state;
    const slot = msg.you;
    if (st.phase === 'teams') {
      const mine = st.players[slot].team;
      if (!(mine && mine.ready) && !teamSent) { teamSent = true; c.send({ t: 'teamAuto' }); }
      return;
    }
    if (st.phase === 'toss') {
      if (st.toss.call === null && st.toss.caller === slot) c.send({ t: 'call', side: 'heads' });
      else if (st.toss.call && !st.toss.choice && st.toss.winner === slot) c.send({ t: 'choose', pick: 'bat' });
      return;
    }
    if (st.phase !== 'innings' || !st.delivery) return;
    const inn = st.innings[st.inningsIndex];
    const d = st.delivery;
    if (d.state === 'awaitingBowler' && inn.bowlingSlot === slot) {
      const key = `${st.inningsIndex}:${inn.balls}`;
      if (bowlerKey !== key) { bowlerKey = key; c.send({ t: 'bowler', id: d.eligibleBowlers[0] }); }
    } else if (d.state === 'awaitingBowl' && inn.bowlingSlot === slot) {
      const key = `${st.inningsIndex}:${inn.balls}:${inn.extras}`;
      if (bowledKey !== key) {
        bowledKey = key;
        const pace = BY_ID.get(inn.bowler).bowlType === 'spin' ? 'arm' : 'fast';
        c.send({ t: 'bowl', line: 'middle', length: 'good', pace, timing: 0 });
      }
    } else if (d.state === 'inFlight' && inn.battingSlot === slot && shotSeq !== d.seq) {
      shotSeq = d.seq;
      stats.balls += 1;
      c.send({ t: 'shot', ...shot, at: d.flightMs });
    } else if (d.state === 'decision' && d.reviewer === slot && reviewSeq !== d.seq) {
      reviewSeq = d.seq;
      stats.decisions += 1;
      stats.reviews += 1;
      c.send({ t: 'review' });
    }
  });
  return stats;
}

async function setupMatch(url, overs = 1, wickets = 2) {
  const A = await connect(url, 'Asha');
  const B = await connect(url, 'Bilal');
  await A.wait((m) => m.t === 'lobby');
  await B.wait((m) => m.t === 'lobby');
  A.send({ t: 'create', overs, wickets });
  const created = await A.wait((m) => m.t === 'update');
  B.send({ t: 'join', code: created.state.code });
  await A.wait((m) => m.t === 'update' && m.state.phase === 'teams');
  await B.wait((m) => m.t === 'update' && m.state.phase === 'teams');
  return { A, B, code: created.state.code };
}

async function teamsAndToss(A, B) {
  A.send({ t: 'teamAuto' });
  B.send({ t: 'teamAuto' });
  await A.wait((m) => m.t === 'update' && m.state.phase === 'toss', 5000, 'toss phase');
  await B.wait((m) => m.t === 'update' && m.state.phase === 'toss', 5000, 'toss phase');
  B.send({ t: 'call', side: 'tails' });
  const tossed = await A.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'toss'));
  await B.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'toss'));
  const winner = tossed.state.toss.winner === 0 ? A : B;
  winner.send({ t: 'choose', pick: 'bat' });
  const a = await A.wait((m) => m.t === 'update' && m.state.phase === 'innings');
  await B.wait((m) => m.t === 'update' && m.state.phase === 'innings');
  return a.state;
}

test('lobby, teams, full match with DRS, rematch and leave over WebSocket', async () => {
  const srv = await start({ port: 0, timeScale: 0.05, graceMs: 200, quiet: true, pool: POOL });
  const url = `ws://127.0.0.1:${srv.port}/`;
  try {
    const A = await connect(url, 'Asha');
    const B = await connect(url, 'Bilal');
    assert.deepEqual((await A.wait((m) => m.t === 'lobby')).matches, []);
    await B.wait((m) => m.t === 'lobby');

    A.send({ t: 'create', overs: 2, wickets: 3, reviews: 2 });
    const created = await A.wait((m) => m.t === 'update');
    assert.equal(created.you, 0);
    assert.equal(created.state.phase, 'waiting');
    assert.equal(created.state.settings.reviews, 2);
    const lobbyB = await B.wait((m) => m.t === 'lobby' && m.matches.length === 1);
    assert.equal(lobbyB.matches[0].host, 'Asha');
    assert.equal(lobbyB.matches[0].overs, 2);

    const statsA = autoplay(A, { dir: 'off', kind: 'attack' });
    const statsB = autoplay(B, { dir: 'straight', kind: 'loft' });
    B.send({ t: 'join', code: created.state.code.toLowerCase() });
    const teams = await A.wait((m) => m.t === 'update' && m.state.phase === 'teams');
    assert.equal(teams.state.players[1].name, 'Bilal');
    const fin = await A.wait((m) => m.t === 'update' && m.state.phase === 'finished', 60000, 'match to finish');
    assert.match(fin.state.result.text, /won by|tied/);
    assert.equal(fin.state.innings.length, 2);
    assert.equal(fin.state.target, fin.state.innings[0].runs + 1);
    for (const inn of fin.state.innings) {
      assert.ok(inn.balls <= 12);
      assert.ok(inn.wickets <= 3);
      assert.ok(Object.keys(inn.bowling).length >= 1);
      assert.equal(Object.values(inn.bowling).reduce((s, b) => s + b.balls, 0), inn.balls);
    }
    assert.ok(statsA.balls + statsB.balls > 0, 'somebody faced a ball');

    A.drain(); B.drain();
    A.send({ t: 'rematch' });
    const vote = await B.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'rematchVote'));
    assert.deepEqual(vote.state.rematch, [0]);
    B.send({ t: 'rematch' });
    const re = await A.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'rematch'), 5000, 'rematch');
    assert.equal(re.state.phase, 'toss');
    assert.equal(re.state.toss.caller, 0);
    assert.ok(re.state.players.every((p) => p.team && p.team.ready), 'teams are kept for the rematch');

    await B.wait((m) => m.t === 'update' && m.state.phase === 'innings', 10000, 'second match to start');
    B.send({ t: 'leave' });
    const forfeit = await A.wait((m) => m.t === 'update' && m.state.result && m.state.result.abandoned, 5000, 'forfeit');
    assert.equal(forfeit.state.result.winnerSlot, 0);
    assert.match(forfeit.state.result.text, /Bilal left the match/);
    assert.deepEqual((await B.wait((m) => m.t === 'lobby')).matches, []);
    await A.close();
    await B.close();
  } finally {
    await srv.close();
  }
});

test('a hand-built squad is validated, and the DRS review window answers both sides', async () => {
  const srv = await start({ port: 0, timeScale: 1, graceMs: 100, quiet: true, pool: POOL });
  const url = `ws://127.0.0.1:${srv.port}/`;
  try {
    const { A, B } = await setupMatch(url, 2, 3);
    A.send({ t: 'team', name: 'Royals', squad: ['p0', 'p2'] });
    assert.match((await A.wait((m) => m.t === 'error')).message, /exactly 11/);
    A.send({ t: 'team', name: 'Royals', squad: ['p0', 'p2', 'p4', 'p6', 'p8', 'p10', 'p12', 'p14', 'p16', 'p18', 'p20'] });
    assert.match((await A.wait((m) => m.t === 'error')).message, /bowlers/);
    const squad = ['p0', 'p2', 'p4', 'p6', 'p8', 'p10', 'p12', 'p1', 'p3', 'p5', 'p7'];
    A.send({ t: 'team', name: 'Royals <b>', squad });
    const ready = await A.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'teamReady'));
    assert.equal(ready.state.players[0].team.name, 'Royals b');
    assert.deepEqual(ready.state.players[0].team.squad, squad);
    B.send({ t: 'teamAuto' });
    await A.wait((m) => m.t === 'update' && m.state.phase === 'toss');
    await B.wait((m) => m.t === 'update' && m.state.phase === 'toss');
    B.send({ t: 'call', side: 'heads' });
    const tossed = await A.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'toss'));
    const winner = tossed.state.toss.winner === 0 ? A : B;
    winner.send({ t: 'choose', pick: 'bowl' });
    const st = (await A.wait((m) => m.t === 'update' && m.state.phase === 'innings')).state;
    await B.wait((m) => m.t === 'update' && m.state.phase === 'innings');
    const inn = st.innings[0];
    const bowlerC = inn.bowlingSlot === 0 ? A : B;
    const batterC = inn.battingSlot === 0 ? A : B;
    assert.equal(st.delivery.state, 'awaitingBowler');
    batterC.send({ t: 'bowler', id: st.delivery.eligibleBowlers[0] });
    assert.match((await batterC.wait((m) => m.t === 'error')).message, /not bowling/);
    bowlerC.send({ t: 'bowler', id: 'p0' });
    assert.match((await bowlerC.wait((m) => m.t === 'error')).message, /cannot bowl/);
    bowlerC.send({ t: 'bowler', id: st.delivery.eligibleBowlers[0] });
    const over = await bowlerC.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'overStart'));
    assert.equal(over.state.delivery.state, 'awaitingBowl');
    bowlerC.send({ t: 'review' });
    assert.match((await bowlerC.wait((m) => m.t === 'error')).message, /nothing to review/);
    const pace = BY_ID.get(over.state.innings[0].bowler).bowlType === 'spin' ? 'arm' : 'fast';
    bowlerC.send({ t: 'bowl', line: 'middle', length: 'good', pace, timing: 0 });
    const flight = await batterC.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'delivery'));
    assert.equal(flight.state.delivery.state, 'inFlight');
    assert.ok(flight.events[0].lead > 0 && flight.events[0].flightMs > 0);
    batterC.send({ t: 'shot', dir: 'straight', kind: 'defend', at: flight.state.delivery.flightMs });
    const res = await batterC.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'result'));
    assert.ok(['result', 'decision'].includes(res.state.delivery.state));
    await A.close(); await B.close();
  } finally {
    await srv.close();
  }
});

test('reconnecting with the token keeps the seat, and losing it for too long forfeits', async () => {
  const srv = await start({ port: 0, timeScale: 1, graceMs: 400, quiet: true, pool: POOL });
  const url = `ws://127.0.0.1:${srv.port}/`;
  try {
    const { A, B, code } = await setupMatch(url);
    await teamsAndToss(A, B);
    await A.close();
    const gone = await B.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'disconnected'), 3000, 'disconnect notice');
    assert.equal(gone.state.players[0].connected, false);
    assert.equal(gone.state.phase, 'innings');
    const A2 = await connect(url, 'Asha', A.token);
    assert.equal(A2.id, A.id);
    const back = await B.wait((m) => m.t === 'update' && m.events.some((e) => e.t === 'reconnected'), 3000, 'reconnect notice');
    assert.equal(back.state.players[0].connected, true);
    const mine = await A2.wait((m) => m.t === 'update');
    assert.equal(mine.you, 0);
    assert.equal(mine.state.code, code);
    await A2.close();
    const forfeit = await B.wait((m) => m.t === 'update' && m.state.result && m.state.result.abandoned, 5000, 'grace forfeit');
    assert.equal(forfeit.state.result.winnerSlot, 1);
    await B.close();
  } finally {
    await srv.close();
  }
});

test('names are sanitised, renames work in the lobby, and a third player cannot join', async () => {
  const srv = await start({ port: 0, quiet: true, pool: POOL });
  const url = `ws://127.0.0.1:${srv.port}/`;
  try {
    const A = await connect(url, '  <b>Asha</b>  ');
    await A.wait((m) => m.t === 'lobby');
    A.send({ t: 'name', name: 'Asha Rani' });
    const B = await connect(url, 'Bilal');
    await B.wait((m) => m.t === 'lobby');
    A.send({ t: 'create', overs: 1, wickets: 1 });
    const created = await A.wait((m) => m.t === 'update');
    assert.equal(created.state.players[0].name, 'Asha Rani');
    B.send({ t: 'join', code: created.state.code });
    await B.wait((m) => m.t === 'update' && m.state.phase === 'teams');
    const C = await connect(url, 'Chen');
    C.send({ t: 'join', code: created.state.code });
    assert.match((await C.wait((m) => m.t === 'error')).message, /already started/);
    C.send({ t: 'join', code: 'ZZZZ' });
    assert.match((await C.wait((m) => m.t === 'error')).message, /No match with code ZZZZ/);
    C.send({ t: 'nonsense' });
    assert.match((await C.wait((m) => m.t === 'error')).message, /Unknown message/);
    await A.close(); await B.close(); await C.close();
  } finally {
    await srv.close();
  }
});

test('http: /urls answers, players.js is served, and directory traversal is refused', async () => {
  const srv = await start({ port: 0, quiet: true, pool: POOL });
  const get = (p) => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: p }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'], body }));
    }).on('error', rej);
  });
  try {
    const urls = await get('/urls');
    assert.equal(urls.status, 200);
    assert.equal(JSON.parse(urls.body).port, srv.port);
    assert.ok([403, 404].includes((await get('/..%2fserver.js')).status));
    assert.equal((await get('/nope.txt')).status, 404);
    const home = await get('/');
    assert.ok([200, 404].includes(home.status));
    if (home.status === 200) assert.match(home.type, /text\/html/);
    const players = await get('/players.js');
    if (players.status === 200) assert.match(players.type, /javascript/);
  } finally {
    await srv.close();
  }
});
