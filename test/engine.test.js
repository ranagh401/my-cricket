'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Match, resolveDelivery, EngineError, validateSquad, autoPick, playerPrice, bowlersNeeded, maxOversPerBowler, LINES, LENGTHS, DIRS, KINDS } = require('../engine.js');
const { seeded, fakePool } = require('./fixtures.js');

const POOL = fakePool();
const BY_ID = new Map(POOL.map((p) => [p.id, p]));

function joined(opts = {}) {
  const m = new Match({ id: 'm', code: 'TEST', overs: 2, wickets: 3, pool: POOL, rng: seeded(7), ...opts });
  m.addPlayer({ id: 'a', name: 'Asha' });
  m.addPlayer({ id: 'b', name: 'Bilal' });
  return m;
}
function inInnings(opts = {}) {
  const m = joined(opts);
  m.perform('autoTeams');
  m.callToss('b', 'heads');
  m.chooseToss(m.players[m.toss.winner].id, 'bat');
  return m;
}
const batter = (m) => m.players[m.current().battingSlot].id;
const bowlerP = (m) => m.players[m.current().bowlingSlot].id;
function startOver(m) {
  if (m.delivery.state === 'awaitingBowler') m.perform('autoBowler');
}
function bowlOne(m, params) {
  startOver(m);
  const type = m.cricketer(m.current().bowler).bowlType;
  const pace = type === 'spin' ? 'arm' : 'fast';
  return m.bowl(bowlerP(m), { line: 'off', length: 'good', pace, timing: 0, ...params });
}
const outcome = (o) => ({ type: 'runs', runs: 0, wicketKind: null, contact: true, wide: false, shot: null, fielderZone: null, appeal: null, umpire: null, commentary: 'x', ...o });
const runsOutcome = (n) => outcome({ runs: n });
const wicketOutcome = (kind = 'bowled') => outcome({ type: 'wicket', wicketKind: kind, umpire: 'out' });
// Scripts the next ball's outcome, then advances past the result.
function play(m, o) {
  if (m.delivery && m.delivery.state === 'result') m.nextBall();
  if (m.delivery && m.delivery.state === 'awaitingBowler') m.perform('autoBowler');
  m.resolver = () => o;
  bowlOne(m);
  return m.noShot()[0];
}

test('team building: validation, prices and auto pick', () => {
  const settings = { teamSize: 11, budget: 300, overs: 5 };
  assert.equal(playerPrice({ role: 'bat', bat: 88, bowl: 20 }), 33);
  assert.equal(playerPrice({ role: 'bowl', bat: 20, bowl: 50 }), 4);
  let realPool = null;
  try { realPool = require('../public/players.js'); } catch { /* optional */ }
  if (realPool) {
    const realById = new Map(realPool.map((p) => [p.id, p]));
    const dearest = [...realPool].sort((a, b) => playerPrice(b) - playerPrice(a)).slice(0, 11).map((p) => p.id);
    assert.throws(() => validateSquad(dearest, realById, { teamSize: 11, budget: 300, overs: 2 }), /budget/, 'eleven stars must not fit the budget');
    const cheapest = [...realPool].sort((a, b) => playerPrice(a) - playerPrice(b)).slice(0, 11);
    assert.ok(cheapest.reduce((s, p) => s + playerPrice(p), 0) < 150, 'eleven fillers leave plenty of room for stars');
    for (let seed = 1; seed <= 10; seed++) {
      const ids = autoPick(realPool, { teamSize: 11, budget: 300, overs: 5 }, seeded(seed));
      assert.doesNotThrow(() => validateSquad(ids, realById, { teamSize: 11, budget: 300, overs: 5 }));
      const stars = ids.filter((id) => playerPrice(realById.get(id)) >= 30).length;
      assert.ok(stars >= 3, `seed ${seed}: an auto-picked XI should include some stars, got ${stars}`);
    }
  }
  assert.equal(bowlersNeeded(2), 2);
  assert.equal(bowlersNeeded(5), 5);
  assert.equal(bowlersNeeded(20), 5);
  assert.equal(maxOversPerBowler(20), 4);
  assert.throws(() => validateSquad(['p0'], BY_ID, settings), /exactly 11/);
  assert.throws(() => validateSquad(Array(11).fill('p0'), BY_ID, settings), /only be picked once/);
  assert.throws(() => validateSquad([...Array(10).keys()].map((i) => `p${i}`).concat(['zzz']), BY_ID, settings), /Unknown player/);
  const batsOnly = ['p0', 'p2', 'p4', 'p6', 'p8', 'p10', 'p12', 'p14', 'p16', 'p18', 'p20'];
  assert.throws(() => validateSquad(batsOnly, BY_ID, settings), /at least 5 bowlers/);
  const pricey = ['p20', 'p21', 'p1', 'p3', 'p5', 'p7', 'p9', 'p2', 'p4', 'p6', 'p8'];
  const cost = pricey.reduce((s, id) => s + playerPrice(BY_ID.get(id)), 0);
  if (cost > 300) assert.throws(() => validateSquad(pricey, BY_ID, settings), /budget/);
  for (let seed = 1; seed <= 25; seed++) {
    for (const overs of [1, 2, 5, 10]) {
      const ids = autoPick(POOL, { teamSize: 11, budget: 300, overs }, seeded(seed));
      assert.equal(ids.length, 11);
      assert.doesNotThrow(() => validateSquad(ids, BY_ID, { teamSize: 11, budget: 300, overs }), `seed ${seed} overs ${overs}`);
    }
  }
});

test('phases: waiting -> teams -> toss -> innings', () => {
  const m = new Match({ code: 'AAAA', pool: POOL, rng: seeded(1) });
  assert.equal(m.phase, 'waiting');
  m.addPlayer({ id: 'a', name: 'Asha' });
  assert.throws(() => m.setTeam('a', { squad: autoPick(POOL, m.settings) }), /not being picked/);
  const { events } = m.addPlayer({ id: 'b', name: 'Bilal' });
  assert.equal(m.phase, 'teams');
  assert.ok(events.some((e) => e.t === 'teamsStart'));
  assert.equal(m.pendingAction().action, 'autoTeams');
  assert.throws(() => m.callToss('b', 'heads'), /not waiting/);
  const squad = autoPick(POOL, m.settings, seeded(3));
  const ev = m.setTeam('a', { name: '  Super <Kings>  ', squad });
  assert.equal(ev[0].t, 'teamReady');
  assert.equal(m.players[0].team.name, 'Super Kings');
  assert.equal(m.phase, 'teams');
  assert.throws(() => m.setTeam('a', { squad }), /already locked/);
  const ev2 = m.autoTeam('b');
  assert.ok(ev2.some((e) => e.t === 'tossStart'));
  assert.equal(m.phase, 'toss');
  assert.equal(m.players[1].team.squad.length, 11);
  const shared = m.players[1].team.squad.filter((id) => squad.includes(id));
  assert.deepEqual(shared, [], 'auto-pick avoids the opponent\'s locked players when the pool allows');
  m.perform('autoToss');
  m.perform('autoChoose');
  assert.equal(m.phase, 'innings');
  assert.equal(m.delivery.state, 'awaitingBowler');
  const inn = m.current();
  assert.equal(inn.striker, m.players[inn.battingSlot].team.squad[0]);
  assert.equal(inn.nonStriker, m.players[inn.battingSlot].team.squad[1]);
  assert.deepEqual(inn.reviewsLeft, [1, 1], 'two-over games get one review per side');
});

test('bowler selection obeys eligibility and the overs cap', () => {
  const m = inInnings({ overs: 2 });
  const inn = m.current();
  const snap = m.snapshot();
  assert.ok(snap.delivery.eligibleBowlers.length >= 2);
  assert.throws(() => m.chooseBowler(batter(m), snap.delivery.eligibleBowlers[0]), /not bowling/);
  assert.throws(() => m.chooseBowler(bowlerP(m), inn.striker), /cannot bowl this over/);
  const first = snap.delivery.eligibleBowlers[0];
  const [ev] = m.chooseBowler(bowlerP(m), first);
  assert.equal(ev.t, 'overStart');
  assert.equal(m.delivery.state, 'awaitingBowl');
  assert.throws(() => m.bowl(bowlerP(m), { line: 'off', length: 'good', pace: m.cricketer(first).bowlType === 'spin' ? 'fast' : 'spin', timing: 0 }), /Pick a line/);
  for (let b = 0; b < 6; b++) play(m, runsOutcome(0));
  m.nextBall();
  assert.equal(m.delivery.state, 'awaitingBowler', 'a new over asks for a bowler');
  assert.ok(!m.eligibleBowlers(m.current()).includes(first), 'no two overs in a row, and one over max each in a 2-over game');
});

test('strike rotation, new batters and the scorecard', () => {
  const m = inInnings({ overs: 2, wickets: 5 });
  const inn = m.current();
  const [s0, n0] = [inn.striker, inn.nonStriker];
  play(m, runsOutcome(1));
  assert.equal(inn.striker, n0, 'a single swaps the strike');
  assert.equal(inn.nonStriker, s0);
  play(m, runsOutcome(2));
  assert.equal(inn.striker, n0, 'two runs keep the strike');
  play(m, runsOutcome(4));
  play(m, runsOutcome(0));
  play(m, runsOutcome(3));
  assert.equal(inn.striker, s0, 'three runs swap again');
  const r = play(m, runsOutcome(0));
  assert.equal(r.overEnd, true);
  assert.equal(inn.striker, n0, 'the end of the over swaps the batters');
  assert.equal(inn.runs, 10);
  assert.equal(inn.batting[s0].runs + inn.batting[n0].runs, 10);
  m.nextBall();
  const w = play(m, wicketOutcome('bowled'));
  assert.equal(w.wicket.batter, n0);
  assert.equal(inn.batting[n0].out.kind, 'bowled');
  assert.equal(inn.fow.length, 1);
  assert.equal(inn.fow[0].runs, 10);
  m.nextBall();
  assert.equal(inn.striker, inn.order[2], 'the next batter comes in on strike');
  assert.equal(inn.nonStriker, s0);
  const bowlingBalls = Object.values(inn.bowling).reduce((s, b) => s + b.balls, 0);
  assert.equal(bowlingBalls, inn.balls);
  assert.equal(Object.values(inn.bowling).reduce((s, b) => s + b.wickets, 0), 1);
});

test('innings ends when the batting side is all out', () => {
  const m = inInnings({ overs: 5, wickets: 10, teamSize: 3 });
  play(m, wicketOutcome());
  m.nextBall();
  const r = play(m, wicketOutcome());
  assert.equal(r.inningsEnd, true, 'three batters, two out, nobody left to bat');
  assert.equal(m.current().wickets, 2);
});

test('DRS: the batting side overturns a wrong out decision and keeps its review', () => {
  const m = inInnings({ overs: 5, wickets: 5 });
  const inn = m.current();
  const strikerBefore = inn.striker;
  const appeal = { kind: 'lbw', truth: 'notout', decision: 'out', verdict: 'notout', review: { pitching: 'outside-leg', impact: 'inline', wickets: 'hitting', ultraEdge: null } };
  m.resolver = () => outcome({ type: 'wicket', wicketKind: 'lbw', contact: false, appeal, umpire: 'out' });
  startOver(m);
  bowlOne(m);
  const events = m.noShot();
  assert.equal(events[0].t, 'result');
  assert.equal(events[0].pending, true);
  assert.equal(events[1].t, 'decision');
  assert.equal(events[1].decision, 'out');
  assert.equal(events[1].reviewer, inn.battingSlot);
  assert.equal(m.delivery.state, 'decision');
  assert.equal(m.pendingAction().action, 'decisionStands');
  assert.equal(inn.wickets, 0, 'nothing is scored until the decision is final');
  assert.throws(() => m.review(bowlerP(m)), /cannot review/);
  assert.throws(() => m.accept(bowlerP(m)), /not your call/);
  const [rev] = m.review(batter(m));
  assert.equal(rev.t, 'review');
  assert.equal(rev.overturned, true);
  assert.equal(rev.retained, true);
  assert.equal(m.delivery.state, 'reviewing');
  assert.equal(m.pendingAction().action, 'reviewDone');
  assert.throws(() => m.review(batter(m)), /nothing to review/);
  const [fin] = m.perform('reviewDone');
  assert.equal(fin.t, 'result');
  assert.equal(fin.type, 'runs');
  assert.equal(fin.review.overturned, true);
  assert.match(fin.commentary, /OVERTURNED/);
  assert.equal(inn.wickets, 0);
  assert.equal(inn.balls, 1);
  assert.equal(inn.striker, strikerBefore);
  assert.deepEqual(inn.reviewsLeft, [2, 2]);
});

test('DRS: an unsuccessful bowling-side review is lost, then no review is offered', () => {
  const m = inInnings({ overs: 5, wickets: 5, reviews: 1 });
  const inn = m.current();
  const appeal = { kind: 'caught', truth: 'notout', decision: 'notout', verdict: 'notout', review: { pitching: null, impact: null, wickets: null, ultraEdge: false } };
  m.resolver = () => outcome({ type: 'runs', wicketKind: 'caught', contact: false, appeal, umpire: 'notout', fielderZone: 'keeper' });
  startOver(m);
  bowlOne(m);
  const events = m.noShot();
  assert.equal(events[1].reviewer, inn.bowlingSlot);
  const [rev] = m.review(bowlerP(m));
  assert.equal(rev.overturned, false);
  assert.equal(rev.retained, false);
  assert.equal(inn.reviewsLeft[inn.bowlingSlot], 0);
  const [fin] = m.perform('reviewDone');
  assert.equal(fin.type, 'runs');
  assert.match(fin.commentary, /Review lost/);
  m.nextBall();
  bowlOne(m);
  const again = m.noShot();
  assert.equal(again[1].t, 'decision');
  assert.equal(again[1].reviewer, null, 'no reviews left');
  assert.equal(again[2].t, 'result', 'the decision is final immediately');
  assert.equal(m.delivery.state, 'result');
});

test('DRS: accepting, timing out and umpire\'s call', () => {
  const m = inInnings({ overs: 5, wickets: 5 });
  const inn = m.current();
  const stands = { kind: 'lbw', truth: 'out', decision: 'out', verdict: 'out', review: { pitching: 'inline', impact: 'inline', wickets: 'hitting', ultraEdge: null } };
  m.resolver = () => outcome({ type: 'wicket', wicketKind: 'lbw', contact: false, appeal: stands, umpire: 'out' });
  startOver(m);
  bowlOne(m);
  m.noShot();
  const [fin] = m.accept(batter(m));
  assert.equal(fin.type, 'wicket');
  assert.equal(inn.wickets, 1);
  m.nextBall();
  bowlOne(m);
  m.noShot();
  const [timedOut] = m.perform('decisionStands');
  assert.equal(timedOut.type, 'wicket');
  assert.equal(inn.wickets, 2);
  m.nextBall();
  const call = { kind: 'lbw', truth: 'call', decision: 'out', verdict: 'out', review: { pitching: 'inline', impact: 'inline', wickets: 'umpires-call', ultraEdge: null } };
  m.resolver = () => outcome({ type: 'wicket', wicketKind: 'lbw', contact: false, appeal: call, umpire: 'out' });
  bowlOne(m);
  m.noShot();
  const [rev] = m.review(batter(m));
  assert.equal(rev.retained, true, 'umpire\'s call keeps the review');
  assert.deepEqual(inn.reviewsLeft, [2, 2]);
  const [res] = m.perform('reviewDone');
  assert.equal(res.type, 'wicket');
  assert.match(res.commentary, /Umpire's call/);
  assert.equal(inn.wickets, 3);
});

test('resolveDelivery: skills, wrong-direction shots and appeals', () => {
  const d = { line: 'middle', length: 'full', pace: 'fast', flightMs: 950, wide: false, lineIndex: 1, turn: 0 };
  let good = 0, poor = 0;
  for (let i = 0; i < 300; i++) {
    const r = resolveDelivery(d, { dir: 'straight', kind: 'attack', t: 950 }, { batSkill: 90, bowlSkill: 60 }, seeded(i));
    if (r.type === 'runs' && r.runs >= 2) good += 1;
    const w = resolveDelivery(d, { dir: 'off', kind: 'attack', t: 950 + 120 }, { batSkill: 40, bowlSkill: 90 }, seeded(i));
    if (w.type === 'wicket' || w.appeal) poor += 1;
  }
  assert.ok(good > 220, `a star batter timing it perfectly should score, got ${good}/300`);
  assert.ok(poor > 60, `a weak batter playing across the line late should be in trouble, got ${poor}/300`);
  let appeals = 0, decisions = { out: 0, notout: 0 };
  for (let i = 0; i < 300; i++) {
    const r = resolveDelivery(d, null, {}, seeded(i));
    if (r.appeal) { appeals += 1; decisions[r.appeal.decision] += 1; assert.equal(r.appeal.kind, 'lbw'); assert.ok(['out', 'notout'].includes(r.appeal.verdict)); }
    else assert.equal(r.wicketKind, 'bowled');
  }
  assert.ok(appeals > 80 && appeals < 220, `no shot on the stumps: bowled or lbw appeal, got ${appeals} appeals`);
  assert.ok(decisions.out > decisions.notout, 'most plumb lbws are given');
  const wide = resolveDelivery({ ...d, wide: true, lineIndex: -1, line: 'wide' }, { dir: 'leg', kind: 'attack', t: 950 }, {}, seeded(1));
  assert.equal(wide.wide, true);
  assert.equal(wide.umpire, 'wide');
});

test('spin turns after pitching and wides come from the arrival line', () => {
  let m = inInnings({ overs: 5, wickets: 5 });
  m.perform('autoBowler');
  const inn = m.current();
  const spinner = m.players[inn.bowlingSlot].team.squad.find((id) => m.cricketer(id).bowlType === 'spin');
  if (spinner) {
    if (inn.bowler !== spinner) {
      m = inInnings({ overs: 5, wickets: 5 });
      m.chooseBowler(bowlerP(m), m.eligibleBowlers(m.current()).find((id) => m.cricketer(id).bowlType === 'spin') || m.eligibleBowlers(m.current())[0]);
    }
    let turned = 0;
    for (let i = 0; i < 40; i++) {
      if (m.cricketer(m.current().bowler).bowlType !== 'spin') break;
      const [ev] = m.bowl(bowlerP(m), { line: 'middle', length: 'good', pace: 'spin', timing: 0 });
      if (ev.turn !== 0) { turned += 1; assert.equal(m.delivery.line, ev.turn > 0 ? 'off' : 'leg'); }
      m.resolver = () => runsOutcome(0);
      m.noShot();
      m.nextBall();
      if (m.delivery.state === 'awaitingBowler') break;
    }
    assert.ok(turned > 0, 'a spinner turns some deliveries');
  }
});

test('results, rematch and forfeits', () => {
  const m = inInnings({ overs: 1, wickets: 5 });
  const first = m.current().battingSlot;
  for (let i = 0; i < 6; i++) play(m, runsOutcome(i === 0 ? 4 : 1));
  m.nextBall();
  assert.equal(m.phase, 'break');
  m.perform('startInnings');
  assert.equal(m.target, 10);
  assert.equal(m.current().battingSlot, 1 - first);
  for (let i = 0; i < 5; i++) play(m, runsOutcome(2));
  assert.equal(m.lastResult.inningsEnd, true);
  m.nextBall();
  assert.equal(m.phase, 'finished');
  assert.equal(m.result.winnerSlot, 1 - first);
  assert.match(m.result.text, /won by 5 wickets with 1 ball to spare/);
  m.requestRematch('a');
  const evs = m.requestRematch('b');
  assert.ok(evs.some((e) => e.t === 'rematch'));
  assert.equal(m.phase, 'toss', 'rematch keeps the teams and goes straight to the toss');
  assert.ok(m.players.every((p) => p.team && p.team.ready));
  const gone = m.removePlayer('b');
  assert.equal(gone[1].t, 'finished');
  assert.equal(m.result.abandoned, true);
  assert.equal(m.result.winnerSlot, 0);
});

test('snapshot is JSON-safe and reports decision details', () => {
  const m = inInnings({ overs: 5, wickets: 5 });
  const appeal = { kind: 'lbw', truth: 'out', decision: 'out', verdict: 'out', review: { pitching: 'inline', impact: 'inline', wickets: 'hitting', ultraEdge: null } };
  m.resolver = () => outcome({ type: 'wicket', wicketKind: 'lbw', contact: false, appeal, umpire: 'out' });
  startOver(m);
  bowlOne(m);
  m.noShot();
  const s = JSON.parse(JSON.stringify(m.snapshot()));
  assert.equal(s.delivery.state, 'decision');
  assert.equal(s.delivery.decision, 'out');
  assert.equal(s.delivery.appealKind, 'lbw');
  assert.equal(s.delivery.reviewer, m.current().battingSlot);
  assert.equal(s.delivery.intended, undefined);
  assert.equal(s.delivery.outcome, undefined);
  assert.equal(s.players[0].team.squad.length, 11);
  assert.equal(typeof s.innings[0].batting[s.innings[0].striker].runs, 'number');
});

test('fuzz: random matches finish with consistent scorecards', () => {
  let pool = POOL;
  try { pool = require('../public/players.js'); } catch { /* fake pool */ }
  for (let seed = 1; seed <= 120; seed++) {
    const rng = seeded(seed);
    const overs = [1, 2, 3, 5, 10][seed % 5];
    const wickets = 1 + Math.floor(rng() * 10);
    const m = new Match({ code: 'F', overs, wickets, pool, rng });
    m.addPlayer({ id: 'a', name: 'A' });
    m.addPlayer({ id: 'b', name: 'B' });
    let steps = 0;
    while (m.phase !== 'finished' && steps++ < 6000) {
      const d = m.delivery;
      if (m.phase === 'innings' && d && d.state === 'inFlight' && rng() < 0.9) {
        m.shot(batter(m), { dir: DIRS[Math.floor(rng() * 3)], kind: KINDS[Math.floor(rng() * 3)], t: d.flightMs + (rng() - 0.5) * 600 });
        continue;
      }
      if (m.phase === 'innings' && d && d.state === 'awaitingBowl' && rng() < 0.5) {
        const allowed = m.cricketer(m.current().bowler).bowlType === 'spin' ? ['spin', 'arm'] : ['fast', 'slower'];
        m.bowl(bowlerP(m), { line: LINES[Math.floor(rng() * 3)], length: LENGTHS[Math.floor(rng() * 3)], pace: allowed[Math.floor(rng() * 2)], timing: (rng() - 0.5) * 800 });
        continue;
      }
      if (m.phase === 'innings' && d && d.state === 'decision' && d.reviewer !== null && rng() < 0.6) { m.review(m.players[d.reviewer].id); continue; }
      const p = m.pendingAction();
      assert.ok(p, `seed ${seed}: stuck in ${m.phase}/${d && d.state}`);
      m.perform(p.action);
    }
    assert.equal(m.phase, 'finished', `seed ${seed} did not finish`);
    assert.equal(m.innings.length, 2);
    for (const inn of m.innings) {
      assert.ok(inn.balls <= overs * 6, 'never more balls than the overs allow');
      assert.ok(inn.wickets <= Math.min(wickets, inn.order.length - 1), 'never more wickets than allowed');
      const batRuns = Object.values(inn.batting).reduce((s, b) => s + b.runs, 0);
      assert.equal(batRuns + inn.extras, inn.runs, 'batters + extras = total');
      assert.equal(Object.values(inn.batting).filter((b) => b.out).length, inn.wickets, 'dismissals match wickets');
      assert.equal(Object.values(inn.batting).reduce((s, b) => s + b.balls, 0), inn.balls, 'balls faced match balls bowled');
      assert.equal(Object.values(inn.bowling).reduce((s, b) => s + b.balls, 0), inn.balls, 'bowlers balls match');
      assert.equal(Object.values(inn.bowling).reduce((s, b) => s + b.runs, 0), inn.runs, 'bowlers runs match the total');
      assert.equal(Object.values(inn.bowling).reduce((s, b) => s + b.wickets, 0), inn.wickets, 'bowlers wickets match');
      const max = maxOversPerBowler(overs);
      for (const b of Object.values(inn.bowling)) assert.ok(Math.ceil(b.balls / 6) <= max, `seed ${seed}: a bowler bowled too many overs`);
      const tally = [...inn.oversLog.flat(), ...inn.thisOver];
      assert.equal(tally.filter((x) => x !== 'wd').length, inn.balls, 'over log matches the ball count');
      assert.equal(tally.reduce((s, x) => s + (x === 'wd' ? 1 : x === 'W' ? 0 : Number(x)), 0), inn.runs, 'over log matches the runs');
      for (const r of inn.reviewsLeft) assert.ok(r >= 0 && r <= m.settings.reviews);
    }
    const [a, b] = m.innings;
    assert.equal(m.target, a.runs + 1);
    if (b.runs >= m.target) assert.equal(m.result.winnerSlot, b.battingSlot);
    else if (b.runs === a.runs) assert.equal(m.result.winnerSlot, null);
    else assert.equal(m.result.winnerSlot, a.battingSlot);
  }
});

test('engine errors are EngineError instances', () => {
  const m = joined();
  try { m.callToss('a', 'heads'); assert.fail('should throw'); } catch (e) { assert.ok(e instanceof EngineError); }
});
