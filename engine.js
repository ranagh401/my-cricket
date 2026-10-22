'use strict';
// MY CRICKET match engine. Pure game logic: no networking, no timers. The server owns the clock and calls
// pendingAction()/perform() for time-driven transitions, so the engine is deterministic and testable
// with an injected random number generator.
//
// A match: two players join -> both build an XI from the player pool within a budget -> toss -> two innings.
// Each innings has a batting order, a striker and non-striker who rotate the strike, and a bowling side
// that picks a bowler for every over (with a cap on overs per bowler). Every ball: the bowler picks line,
// length and pace and times the release; the batter picks a shot type and direction and times the swing.
// Close calls (lbw, caught behind) go to the on-field umpire, who sometimes gets them wrong; the side that
// disagrees may use a DRS review, which replays the truth (ball tracking / UltraEdge) and can overturn it.

const LINES = ['leg', 'middle', 'off'];          // from the batter's view, whichever hand they bat with
const LENGTHS = ['short', 'good', 'full'];
const PACES = ['fast', 'slower', 'spin', 'arm'];
const PACES_FOR = { fast: ['fast', 'slower'], medium: ['fast', 'slower'], spin: ['spin', 'arm'] };
const DIRS = ['leg', 'straight', 'off'];
const KINDS = ['defend', 'attack', 'loft'];
const SIDES = ['heads', 'tails'];
const TEAM_SIZE = 11;
const BUDGET = 300;

// Delays in ms (multiplied by the match's timeScale).
const DELAYS = {
  leadFast: 1400,      // pace bowler's run-up before release
  leadSpin: 950,       // spinner's walk-in
  flightFast: 950, flightMedium: 1050, flightSlower: 1250, flightSpin: 1400, flightArm: 1200,
  shotGrace: 450,      // after the ball reaches the bat, before "no shot" is called
  result: 2800,        // show the outcome before the next ball
  wicketExtra: 1600,   // replay time
  overExtra: 1200,
  inningsEndExtra: 800,
  decision: 12000,     // DRS window for the side that may review
  review: 9000,        // the review graphic
  inningsBreak: 9000,  // scorecard
  teams: 240000,       // team building time before auto-pick
  autoBowler: 20000,   // bowling captain idle at the start of an over
  autoBowl: 30000,     // bowler idle
  autoToss: 20000,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
};
const pick = (rng, arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];

class EngineError extends Error {}
const fail = (msg) => { throw new EngineError(msg); };

// ------------------------------------------------------------------ player pool helpers
function overallRating(p) {
  if (p.role === 'bowl') return p.bowl;
  if (p.role === 'ar') return Math.min(99, Math.round((p.bat + p.bowl) / 2 + 5));
  if (p.role === 'wk') return Math.min(99, p.bat + 3);
  return p.bat;
}
// Prices make the 300 budget bite: a 95-rated star costs 40, a 70-rated regular 15, so an XI holds about
// five or six stars plus solid fillers, never eleven stars.
const playerPrice = (p) => Math.max(4, overallRating(p) - 55);
const canBowl = (p) => !!p.bowlType && p.bowl >= 40;
const maxOversPerBowler = (overs) => Math.max(1, Math.ceil(overs / 5));
const bowlersNeeded = (overs) => Math.min(5, Math.ceil(overs / maxOversPerBowler(overs)));
const squadCost = (ids, poolById) => ids.reduce((s, id) => s + (poolById.get(id) ? playerPrice(poolById.get(id)) : 0), 0);

// Throws an EngineError describing the first problem with a squad, or returns the cost.
function validateSquad(ids, poolById, settings) {
  const size = settings.teamSize;
  if (!Array.isArray(ids) || ids.length !== size) fail(`Pick exactly ${size} players.`);
  if (new Set(ids).size !== ids.length) fail('A player can only be picked once.');
  for (const id of ids) if (!poolById.has(id)) fail(`Unknown player ${String(id)}.`);
  const cost = squadCost(ids, poolById);
  if (cost > settings.budget) fail(`That XI costs ${cost}, the budget is ${settings.budget}.`);
  const bowlers = ids.filter((id) => canBowl(poolById.get(id))).length;
  const need = Math.min(bowlersNeeded(settings.overs), size);
  if (bowlers < need) fail(`You need at least ${need} bowlers for ${settings.overs} over${settings.overs === 1 ? '' : 's'} (picked ${bowlers}).`);
  return cost;
}

// A sensible XI within the budget: enough bowlers, a keeper, then the best batters. Some randomness so
// two auto-picked teams differ. Returns ids in batting order.
function autoPick(pool, settings, rng = Math.random) {
  const size = Math.min(settings.teamSize, pool.length);
  const prices = new Map(pool.map((p) => [p.id, playerPrice(p)]));
  const minPrice = pool.length ? Math.min(...prices.values()) : 0;
  const chosen = [];
  let spent = 0;
  const affordable = (p) => spent + prices.get(p.id) + minPrice * (size - chosen.length - 1) <= settings.budget;
  const add = (p) => {
    if (chosen.includes(p) || chosen.length >= size || !affordable(p)) return false;
    chosen.push(p); spent += prices.get(p.id); return true;
  };
  const need = Math.min(bowlersNeeded(settings.overs), size);
  const byBowl = pool.filter(canBowl).sort((a, b) => b.bowl - a.bowl);
  // Two star bowlers, then the rest of the attack from good-value bowlers so the budget also buys batters.
  let got = 0;
  for (const p of byBowl) { if (got >= Math.min(2, need)) break; if (rng() < 0.25) continue; if (add(p)) got += 1; }
  const value = byBowl.filter((p) => p.bowl >= 62 && !chosen.includes(p)).sort((a, b) => (b.bowl - prices.get(b.id) * 1.5) - (a.bowl - prices.get(a.id) * 1.5));
  for (const p of value) { if (got >= need) break; if (rng() < 0.2) continue; if (add(p)) got += 1; }
  for (const p of byBowl) { if (got >= need) break; if (add(p)) got += 1; }
  const keepers = pool.filter((p) => p.role === 'wk').sort((a, b) => b.bat - a.bat);
  for (const p of keepers) { if (rng() < 0.25) continue; if (add(p)) break; }
  for (const p of keepers) if (chosen.some((c) => c.role === 'wk') || add(p)) break;
  const byBat = [...pool].sort((a, b) => b.bat - a.bat);
  for (const p of byBat) { if (chosen.length >= size) break; if (rng() < 0.2) continue; add(p); }
  const cheapest = [...pool].sort((a, b) => prices.get(a.id) - prices.get(b.id));
  for (const p of cheapest) { if (chosen.length >= size) break; add(p); }
  // Safety net for odd pools: trade the dearest non-bowler for the cheapest unpicked player until the XI is full.
  let guard = 0;
  while (chosen.length < size && guard++ < 60) {
    const nonBowlers = chosen.filter((p) => !canBowl(p));
    const dearest = (nonBowlers.length ? nonBowlers : chosen).slice().sort((a, b) => prices.get(b.id) - prices.get(a.id))[0];
    const cheap = cheapest.find((p) => !chosen.includes(p));
    if (!dearest || !cheap) break;
    chosen.splice(chosen.indexOf(dearest), 1); spent -= prices.get(dearest.id);
    chosen.push(cheap); spent += prices.get(cheap.id);
    for (const p of cheapest) { if (chosen.length >= size) break; add(p); }
  }
  chosen.sort((a, b) => b.bat - a.bat);
  return chosen.map((p) => p.id);
}

// ------------------------------------------------------------------ what a ball produced
const FIELD = {
  leg: ['square leg', 'midwicket', 'fine leg', 'deep midwicket', 'deep square leg'],
  straight: ['long-on', 'mid-on', 'mid-off', 'long-off', 'the sightscreen'],
  off: ['cover', 'point', 'third man', 'extra cover', 'deep cover'],
};
const timingLabel = (err) => (err < 55 ? 'perfect' : err < 120 ? 'good' : err < 210 ? 'ok' : 'poor');

function lbwAppeal(rng, truth) {
  // truth: 'out' | 'notout' | 'call' (umpire's call: the on-field decision stands either way)
  let review;
  if (truth === 'call') review = { pitching: 'inline', impact: 'inline', wickets: 'umpires-call', ultraEdge: null };
  else if (truth === 'out') review = { pitching: rng() < 0.7 ? 'inline' : 'outside-off', impact: 'inline', wickets: 'hitting', ultraEdge: null };
  else {
    const r = rng();
    review = r < 0.4 ? { pitching: 'outside-leg', impact: 'inline', wickets: 'hitting', ultraEdge: null }
      : r < 0.7 ? { pitching: 'inline', impact: 'outside', wickets: 'hitting', ultraEdge: null }
        : { pitching: 'inline', impact: 'inline', wickets: 'missing', ultraEdge: null };
  }
  const decision = truth === 'call' ? (rng() < 0.5 ? 'out' : 'notout') : rng() < 0.88 ? truth : (truth === 'out' ? 'notout' : 'out');
  return { kind: 'lbw', truth, decision, review, verdict: truth === 'call' ? decision : truth };
}

function caughtAppeal(rng, truth) {
  const decision = rng() < 0.88 ? truth : (truth === 'out' ? 'notout' : 'out');
  return { kind: 'caught', truth, decision, review: { pitching: null, impact: null, wickets: null, ultraEdge: truth === 'out' }, verdict: truth };
}

// `d` is the in-flight delivery (line = arrival line after any turn), `shot` is { dir, kind, t } or null,
// ctx = { batSkill, bowlSkill } (0-99). Returns an outcome; when outcome.appeal is set the umpire has given
// a provisional decision (outcome.type reflects it) which the DRS may overturn.
function resolveDelivery(d, shot, ctx = {}, rng = Math.random) {
  const batSkill = clamp(Number(ctx.batSkill ?? 65), 0, 99);
  const bowlSkill = clamp(Number(ctx.bowlSkill ?? 65), 0, 99);
  const threat = 0.85 + 0.35 * clamp((bowlSkill - 30) / 70, 0, 1);
  const base = (o) => ({ type: 'runs', runs: 0, wicketKind: null, contact: true, wide: false, shot: null, fielderZone: null, appeal: null, umpire: null, commentary: '', ...o });
  const runs = (n, text, extra) => base({ runs: n, commentary: text, umpire: n === 4 ? 'four' : n === 6 ? 'six' : null, ...extra });
  const wicket = (kind, text, extra) => base({ type: 'wicket', wicketKind: kind, commentary: text, umpire: 'out', ...extra });
  const appealed = (appeal, text, extra) => base({
    type: appeal.decision === 'out' ? 'wicket' : 'runs', wicketKind: appeal.kind, appeal, commentary: text, contact: false,
    umpire: appeal.decision === 'out' ? 'out' : 'notout', fielderZone: appeal.kind === 'caught' ? 'keeper' : null, ...extra,
  });

  if (d.wide) {
    return runs(1, `Wide! Sprayed ${d.lineIndex < 0 ? 'down the leg side' : 'outside off'}, one extra.`, { wide: true, contact: false, umpire: 'wide', fielderZone: 'keeper' });
  }
  const full = d.length !== 'short';
  const onStumps = d.line === 'middle' && full;
  const nearOff = d.line === 'off' && full;
  const legLine = d.line === 'leg' && full;

  // The bat has missed (or no shot was offered): where does the ball go?
  const miss = (text, info) => {
    const r = rng();
    if (onStumps) {
      if (r < 0.5 * threat) return wicket('bowled', 'BOWLED! Straight through, the stumps are shattered!', { contact: false, ...info });
      return appealed(lbwAppeal(rng, rng() < 0.85 ? 'out' : 'call'), 'Hits the pad right in front! Huge appeal for lbw...', info);
    }
    if (nearOff) {
      if (r < 0.25 * threat) {
        const roll = rng();
        return appealed(lbwAppeal(rng, roll < 0.3 ? (rng() < 0.5 ? 'out' : 'call') : 'notout'), 'Thuds into the pad outside off... the bowler goes up!', info);
      }
      if (r < 0.4 * threat) return appealed(caughtAppeal(rng, 'notout'), 'Beaten past the edge, the keeper takes it... and they appeal for a nick!', info);
      return runs(0, text, { contact: false, fielderZone: 'keeper', ...info });
    }
    if (legLine) {
      if (r < 0.3) return appealed(lbwAppeal(rng, 'notout'), 'Struck on the pad down the leg side... appeal!', info);
      return runs(0, text, { contact: false, fielderZone: 'keeper', ...info });
    }
    return runs(0, text, { contact: false, fielderZone: 'keeper', ...info });
  };
  if (!shot) return miss(d.length === 'short' ? 'Ducks under the bouncer. Dot ball.' : 'Left alone. Dot ball.');

  const err = Math.abs(shot.t - d.flightMs);
  const skill = clamp((batSkill - 30) / 70, 0, 1);
  const window = (d.pace === 'fast' ? 260 : 330) * (0.72 + 0.5 * skill);
  const tq = Math.pow(Math.max(0, 1 - err / window), 0.85);
  let bonus = (batSkill - 65) / 300;
  const diff = Math.abs(LINES.indexOf(d.line) - DIRS.indexOf(shot.dir));
  if (diff === 0) bonus += 0.12; else if (diff === 2) bonus -= 0.45; else bonus -= 0.12;
  if (d.length === 'full') bonus += shot.kind === 'defend' ? 0.04 : 0.10;
  else if (d.length === 'short') bonus += shot.kind === 'attack' ? 0.08 : shot.kind === 'loft' ? -0.04 : 0.02;
  else bonus += shot.kind === 'defend' ? 0.10 : shot.kind === 'attack' ? -0.08 : -0.14;
  const q = clamp(tq + bonus + (rng() - 0.5) * 0.12, 0, 1);
  const pos = pick(rng, FIELD[shot.dir]);
  const info = { shot: { dir: shot.dir, kind: shot.kind, timing: timingLabel(err), quality: Number(q.toFixed(3)) } };
  const zone = { fielderZone: shot.dir };
  const r = rng();

  if (shot.kind === 'defend') {
    if (q >= 0.45) return r < 0.35 ? runs(1, `Single, dabbed to ${pos}.`, { ...info, ...zone }) : runs(0, 'Solid defence. Dot ball.', { ...info, ...zone });
    if (q >= 0.2) return r < 0.1 ? runs(1, `Inside edge, scampers a single to ${pos}.`, { ...info, ...zone }) : runs(0, 'Blocked, no run.', { ...info, ...zone });
    return miss('Beaten outside the edge. Dot ball.', info);
  }
  if (shot.kind === 'attack') {
    if (q >= 0.9) return runs(4, `FOUR! Crisp, races away through ${pos}.`, { ...info, ...zone });
    if (q >= 0.75) return r < 0.25 ? runs(4, `FOUR! Timed sweetly past ${pos}.`, { ...info, ...zone }) : r < 0.4 ? runs(3, `Three runs, placed wide of ${pos}.`, { ...info, ...zone }) : runs(2, `Two runs, pushed into the gap at ${pos}.`, { ...info, ...zone });
    if (q >= 0.55) return r < 0.6 ? runs(1, `Single, worked to ${pos}.`, { ...info, ...zone }) : runs(2, `Two, good running to ${pos}.`, { ...info, ...zone });
    if (q >= 0.35) return r < 0.5 ? runs(0, `Mistimed, straight to ${pos}. Dot ball.`, { ...info, ...zone }) : runs(1, `Thick edge, one run to ${pos}.`, { ...info, ...zone });
    if ((onStumps || nearOff) && r < 0.35 * threat) return appealed(caughtAppeal(rng, rng() < 0.8 ? 'out' : 'notout'), 'Edged?! The keeper takes it and they are all up!', info);
    if (!full && r < 0.3 * threat) return wicket('caught', `CAUGHT! Leading edge, easy catch at ${pos}!`, { ...info, ...zone });
    return miss('Swing and a miss!', info);
  }
  // loft
  if (q >= 0.9) return runs(6, `SIX! Launched high over ${pos}!`, { ...info });
  if (q >= 0.78) return r < 0.5 ? runs(6, `SIX! Clears the rope at ${pos}!`, { ...info }) : runs(4, `FOUR! One bounce over ${pos}.`, { ...info, ...zone });
  if (q >= 0.62) {
    if (r < 0.4) return runs(4, `FOUR! Lofted safely over ${pos}.`, { ...info, ...zone });
    if (r < 0.8) return runs(2, `Two runs, in the air but safe at ${pos}.`, { ...info, ...zone });
    return wicket('caught', `CAUGHT! Holed out on the rope at ${pos}!`, { ...info, ...zone });
  }
  if (q >= 0.45) {
    if (r < 0.4) return runs(1, `Single, skied but drops short of ${pos}.`, { ...info, ...zone });
    if (r < 0.6) return runs(2, `Two, mistimed over ${pos}.`, { ...info, ...zone });
    return wicket('caught', `CAUGHT! Top-edged, swallowed at ${pos}!`, { ...info, ...zone });
  }
  if (r < 0.6 * threat) return wicket('caught', `CAUGHT! Skied miles up, taken by ${pos}!`, { ...info, ...zone });
  return miss('Big swing, no contact.', info);
}

// ------------------------------------------------------------------ the match
class Match {
  constructor({ id, code, overs, wickets, reviews, teamSize, budget, pool = [], rng = Math.random, timeScale = 1 } = {}) {
    this.id = id;
    this.code = code;
    const ov = clampInt(overs, 1, 20, 2);
    this.settings = {
      overs: ov,
      wickets: clampInt(wickets, 1, 10, 3),
      reviews: clampInt(reviews, 0, 3, ov <= 2 ? 1 : 2),
      teamSize: clampInt(teamSize, 2, TEAM_SIZE, TEAM_SIZE),
      budget: clampInt(budget, 50, 2000, BUDGET),
    };
    this.pool = pool;
    this.poolById = new Map(pool.map((p) => [p.id, p]));
    this.rng = rng;
    this.timeScale = timeScale;
    this.players = [null, null];      // slot -> { id, name, connected, team: { name, squad, ready } | null }
    this.phase = 'waiting';           // waiting | teams | toss | innings | break | finished
    this.toss = null;
    this.innings = [];
    this.inningsIndex = -1;
    this.target = null;
    this.delivery = null;
    this.lastResult = null;
    this.result = null;
    this.rematch = new Set();
    this.seq = 0;
    this.resolver = resolveDelivery;   // tests swap this to script outcomes
  }

  get isFull() { return this.players.every(Boolean); }
  slotOf(playerId) { return this.players.findIndex((p) => p && p.id === playerId); }
  name(slot) { const p = this.players[slot]; return p ? p.name : `Player ${slot + 1}`; }
  teamName(slot) { const p = this.players[slot]; return p && p.team ? p.team.name : this.name(slot); }
  current() { return this.innings[this.inningsIndex]; }
  delay(key) { return Math.max(1, Math.round(DELAYS[key] * this.timeScale)); }
  cricketer(id) { return this.poolById.get(id) || { id, name: String(id), bat: 60, bowl: 40, hand: 'R', bowlType: 'medium', role: 'ar' }; }

  // ---- joining and teams
  addPlayer({ id, name }) {
    if (this.phase !== 'waiting') fail('That match has already started.');
    const slot = this.players.indexOf(null);
    if (slot < 0) fail('That match is full.');
    this.players[slot] = { id, name, connected: true, team: null };
    const events = [{ t: 'joined', slot, name }];
    if (this.isFull) { this.phase = 'teams'; events.push({ t: 'teamsStart' }); }
    return { slot, events };
  }

  setConnected(playerId, connected) {
    const slot = this.slotOf(playerId);
    if (slot < 0) return [];
    this.players[slot].connected = connected;
    return [{ t: connected ? 'reconnected' : 'disconnected', slot }];
  }

  removePlayer(playerId) {
    const slot = this.slotOf(playerId);
    if (slot < 0) return [];
    if (this.phase === 'waiting') { this.players[slot] = null; return [{ t: 'left', slot }]; }
    if (this.phase === 'finished') return [{ t: 'left', slot }];
    const other = 1 - slot;
    this.phase = 'finished';
    this.delivery = null;
    this.result = { text: `${this.name(slot)} left the match. ${this.name(other)} wins by default.`, winnerSlot: other, abandoned: true };
    return [{ t: 'left', slot }, { t: 'finished', result: this.result }];
  }

  setTeam(playerId, { name, squad } = {}) {
    const slot = this.slotOf(playerId);
    if (this.phase !== 'teams' || slot < 0) fail('Teams are not being picked right now.');
    if (this.players[slot].team && this.players[slot].team.ready) fail('Your XI is already locked in.');
    validateSquad(squad, this.poolById, this.settings);
    const teamName = String(name || '').replace(/[^\w .'&-]/g, '').trim().slice(0, 20) || `${this.name(slot)} XI`;
    this.players[slot].team = { name: teamName, squad: [...squad], ready: true };
    return this.afterTeam(slot);
  }

  autoTeam(playerId) {
    const slot = this.slotOf(playerId);
    if (this.phase !== 'teams' || slot < 0) fail('Teams are not being picked right now.');
    if (this.players[slot].team && this.players[slot].team.ready) fail('Your XI is already locked in.');
    // Prefer players the opponent has not already locked in, so the two XIs do not share cricketers.
    const other = this.players[1 - slot];
    const taken = new Set(other && other.team && other.team.ready ? other.team.squad : []);
    let squad = autoPick(this.pool.filter((p) => !taken.has(p.id)), this.settings, this.rng);
    try { validateSquad(squad, this.poolById, this.settings); } catch { squad = autoPick(this.pool, this.settings, this.rng); }
    this.players[slot].team = { name: `${this.name(slot)} XI`, squad, ready: true, auto: true };
    return this.afterTeam(slot);
  }

  afterTeam(slot) {
    const events = [{ t: 'teamReady', slot, name: this.players[slot].team.name }];
    if (this.players.every((p) => p && p.team && p.team.ready)) {
      this.phase = 'toss';
      this.toss = { caller: 1, call: null, landed: null, winner: null, choice: null };
      events.push({ t: 'teamsDone' }, { t: 'tossStart', caller: 1 });
    }
    return events;
  }

  // ---- toss
  callToss(playerId, side) {
    if (this.phase !== 'toss' || this.toss.call) fail('The toss is not waiting for a call.');
    if (this.slotOf(playerId) !== this.toss.caller) fail('Your opponent calls the toss.');
    if (!SIDES.includes(side)) fail('Call heads or tails.');
    const landed = this.rng() < 0.5 ? 'heads' : 'tails';
    const winner = landed === side ? this.toss.caller : 1 - this.toss.caller;
    Object.assign(this.toss, { call: side, landed, winner });
    return [{ t: 'toss', call: side, landed, winner }];
  }

  chooseToss(playerId, choice) {
    if (this.phase !== 'toss' || this.toss.winner === null || this.toss.choice) fail('The toss is not waiting for a choice.');
    if (this.slotOf(playerId) !== this.toss.winner) fail('The toss winner chooses.');
    if (choice !== 'bat' && choice !== 'bowl') fail('Choose bat or bowl.');
    this.toss.choice = choice;
    const battingSlot = choice === 'bat' ? this.toss.winner : 1 - this.toss.winner;
    return [{ t: 'tossChoice', winner: this.toss.winner, choice }, ...this.startInnings(battingSlot)];
  }

  // ---- innings
  startInnings(battingSlot) {
    const order = [...this.players[battingSlot].team.squad];
    const inn = {
      battingSlot, bowlingSlot: 1 - battingSlot, runs: 0, wickets: 0, balls: 0, extras: 0, fours: 0, sixes: 0,
      thisOver: [], overNo: 0, oversLog: [],
      order, nextIn: 2, striker: order[0], nonStriker: order[1],
      batting: Object.fromEntries(order.map((id) => [id, { runs: 0, balls: 0, fours: 0, sixes: 0, out: null }])),
      bowling: {}, bowler: null, lastBowler: null,
      reviewsLeft: [this.settings.reviews, this.settings.reviews],
      fow: [], partnership: { runs: 0, balls: 0 },
    };
    this.inningsIndex += 1;
    this.innings.push(inn);
    if (this.inningsIndex === 1) this.target = this.innings[0].runs + 1;
    this.phase = 'innings';
    this.delivery = { state: 'awaitingBowler' };
    this.lastResult = null;
    return [{ t: 'inningsStart', innings: this.inningsIndex, battingSlot, target: this.target }];
  }

  eligibleBowlers(inn) {
    const squad = this.players[inn.bowlingSlot].team.squad;
    const max = maxOversPerBowler(this.settings.overs);
    const overs = (id) => Math.floor(((inn.bowling[id] || {}).balls || 0) / 6);
    const all = squad.filter((id) => canBowl(this.cricketer(id)));
    let list = all.filter((id) => id !== inn.lastBowler && overs(id) < max);
    if (!list.length) list = all.filter((id) => overs(id) < max);
    if (!list.length) list = all.length ? all : squad.filter((id) => id !== inn.lastBowler);
    return list;
  }

  chooseBowler(playerId, bowlerId, { auto = false } = {}) {
    if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'awaitingBowler') fail('Not waiting for a bowler.');
    const inn = this.current();
    if (this.slotOf(playerId) !== inn.bowlingSlot) fail('You are not bowling.');
    const eligible = this.eligibleBowlers(inn);
    if (!eligible.includes(bowlerId)) fail('That player cannot bowl this over.');
    inn.bowler = bowlerId;
    inn.bowling[bowlerId] = inn.bowling[bowlerId] || { balls: 0, runs: 0, wickets: 0, wides: 0 };
    this.delivery = { state: 'awaitingBowl' };
    return [{ t: 'overStart', over: inn.overNo, bowler: bowlerId, auto }];
  }

  bowl(playerId, { line, length, pace, timing } = {}, { auto = false } = {}) {
    if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'awaitingBowl') fail('Not waiting for a delivery.');
    const inn = this.current();
    if (this.slotOf(playerId) !== inn.bowlingSlot) fail('You are not bowling.');
    const bowler = this.cricketer(inn.bowler);
    const allowed = PACES_FOR[bowler.bowlType] || PACES_FOR.medium;
    if (!LINES.includes(line) || !LENGTHS.includes(length) || !allowed.includes(pace)) fail('Pick a line, length and pace.');
    const striker = this.cricketer(inn.striker);
    const skill = clamp((bowler.bowl - 30) / 70, 0, 1);
    const terr = Math.abs(clamp(Number(timing) || 0, -1000, 1000)) * (1.35 - 0.7 * skill);
    const rng = this.rng;
    let li = LINES.indexOf(line);
    let le = LENGTHS.indexOf(length);
    const step = () => (rng() < 0.5 ? -1 : 1);
    if (terr >= 300) { li += step() * (rng() < 0.5 ? 1 : 2); if (rng() < 0.5) le += step(); }
    else if (terr >= 180) { if (rng() < 0.75) li += step(); if (rng() < 0.3) le += step(); }
    else if (terr >= 90) { if (rng() < 0.35) li += step(); }
    li = clamp(li, -1, 3);
    le = clamp(le, 0, 2);
    // Spin turns after pitching (batter-relative: off-spin comes in to a right-hander, leg-spin and left-arm
    // orthodox go away); pace occasionally seams.
    let turn = 0;
    if (pace === 'spin') {
      const baseTurn = bowler.spin === 'off' ? -1 : 1;
      if (rng() < 0.55 + 0.3 * skill) turn = baseTurn * (striker.hand === 'L' ? -1 : 1);
    } else if (pace === 'fast' && rng() < 0.08 + 0.1 * skill) turn = step();
    const arrival = clamp(li + turn, -1, 3);
    turn = arrival - li;
    const wide = arrival < 0 || arrival > 2;
    const flightKey = pace === 'fast' ? (bowler.bowlType === 'medium' ? 'flightMedium' : 'flightFast') : pace === 'slower' ? 'flightSlower' : pace === 'spin' ? 'flightSpin' : 'flightArm';
    this.seq += 1;
    this.delivery = {
      state: 'inFlight', seq: this.seq, bowler: inn.bowlingSlot, bowlerId: inn.bowler, striker: inn.striker, auto,
      lineIndex: li, turn, line: wide ? 'wide' : LINES[arrival], length: LENGTHS[le], pace, wide,
      flightMs: this.delay(flightKey), lead: this.delay(pace === 'spin' || pace === 'arm' ? 'leadSpin' : 'leadFast'),
      intended: { line, length, pace, timing: Number(timing) || 0 },
    };
    const d = this.delivery;
    return [{ t: 'delivery', seq: d.seq, bowler: d.bowler, bowlerId: d.bowlerId, bowlerType: bowler.bowlType || 'medium', auto, lineIndex: li, turn, length: d.length, pace, wide, flightMs: d.flightMs, lead: d.lead }];
  }

  shot(playerId, { dir, kind, t } = {}) {
    if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'inFlight') fail('No ball to play.');
    if (this.slotOf(playerId) !== this.current().battingSlot) fail('You are not batting.');
    if (!DIRS.includes(dir) || !KINDS.includes(kind)) fail('Pick a shot.');
    const time = clamp(Number(t), -2000, 5000);
    if (!Number.isFinite(time)) fail('Bad shot timing.');
    return this.resolve({ dir, kind, t: time });
  }

  noShot() {
    if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'inFlight') return [];
    return this.resolve(null);
  }

  resolve(shot) {
    const inn = this.current();
    const d = this.delivery;
    const ctx = { batSkill: this.cricketer(inn.striker).bat, bowlSkill: this.cricketer(inn.bowler).bowl };
    const outcome = this.resolver(d, shot, ctx, this.rng);
    const ball = { lineIndex: d.lineIndex, turn: d.turn, length: d.length, pace: d.pace, wide: d.wide };
    if (outcome.appeal) {
      const reviewer = outcome.appeal.decision === 'out' ? inn.battingSlot : inn.bowlingSlot;
      const canReview = inn.reviewsLeft[reviewer] > 0;
      this.delivery = { ...d, state: 'decision', outcome, reviewer: canReview ? reviewer : null };
      const events = [
        { t: 'result', seq: d.seq, pending: true, type: outcome.type, runs: 0, wicketKind: outcome.wicketKind, contact: false, wide: false, shot: outcome.shot, ball, fielderZone: outcome.fielderZone, commentary: outcome.commentary, decisionPending: true, umpire: null },
        { t: 'decision', seq: d.seq, decision: outcome.appeal.decision, kind: outcome.appeal.kind, reviewer: canReview ? reviewer : null, reviewsLeft: [...inn.reviewsLeft], windowMs: canReview ? this.delay('decision') : 0 },
      ];
      if (!canReview) events.push(...this.finalize(outcome, null));
      return events;
    }
    return this.finalize(outcome, null);
  }

  review(playerId) {
    if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'decision') fail('There is nothing to review.');
    const d = this.delivery;
    const slot = this.slotOf(playerId);
    if (d.reviewer === null || slot !== d.reviewer) fail('You cannot review this decision.');
    const inn = this.current();
    const appeal = d.outcome.appeal;
    const overturned = appeal.verdict !== appeal.decision;
    const umpiresCall = appeal.review.wickets === 'umpires-call';
    const retained = overturned || umpiresCall;
    if (!retained) inn.reviewsLeft[slot] -= 1;
    const data = { by: slot, kind: appeal.kind, ...appeal.review, verdict: appeal.verdict, overturned, decision: appeal.decision, retained, reviewsLeft: [...inn.reviewsLeft], durationMs: this.delay('review') };
    this.delivery = { ...d, state: 'reviewing', reviewData: data };
    return [{ t: 'review', seq: d.seq, ...data }];
  }

  accept(playerId) {
    if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'decision') fail('There is no decision to accept.');
    const d = this.delivery;
    const slot = this.slotOf(playerId);
    if (d.reviewer === null || slot !== d.reviewer) fail('That is not your call.');
    return this.finalize(d.outcome, null);
  }

  decisionStands() {
    if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'decision') return [];
    return this.finalize(this.delivery.outcome, null);
  }

  reviewDone() {
    if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'reviewing') return [];
    const d = this.delivery;
    const data = d.reviewData;
    const final = { ...d.outcome };
    if (data.overturned) {
      if (data.verdict === 'out') { final.type = 'wicket'; final.umpire = 'out'; final.commentary = data.kind === 'lbw' ? 'OVERTURNED! Ball tracking has it hitting, that is OUT!' : 'OVERTURNED! UltraEdge shows a clear spike, that is OUT!'; }
      else { final.type = 'runs'; final.wicketKind = null; final.umpire = 'notout'; final.commentary = data.kind === 'lbw' ? 'OVERTURNED! Not out, the batter survives.' : 'OVERTURNED! No spike on UltraEdge, not out!'; }
    } else {
      final.commentary = data.retained ? `Umpire's call, the on-field decision stands: ${data.decision === 'out' ? 'OUT' : 'not out'}.` : `Decision stands: ${data.decision === 'out' ? 'OUT' : 'not out'}. Review lost.`;
    }
    return this.finalize(final, data);
  }

  // Applies the final outcome of the ball to the scorebook and emits the result event.
  finalize(outcome, review) {
    const inn = this.current();
    const d = this.delivery;
    const legal = !outcome.wide;
    const strikerId = inn.striker;
    const bat = inn.batting[strikerId];
    const bowl = inn.bowling[inn.bowler] = inn.bowling[inn.bowler] || { balls: 0, runs: 0, wickets: 0, wides: 0 };
    let wicket = null;
    if (outcome.wide) { inn.runs += 1; inn.extras += 1; inn.thisOver.push('wd'); bowl.runs += 1; bowl.wides += 1; }
    else if (outcome.type === 'wicket') {
      inn.wickets += 1; inn.balls += 1; inn.thisOver.push('W'); bat.balls += 1; bowl.balls += 1; bowl.wickets += 1;
      const fielder = outcome.fielderZone === 'keeper' ? 'keeper' : outcome.fielderZone;
      bat.out = { kind: outcome.wicketKind, bowler: inn.bowler, fielder: outcome.wicketKind === 'caught' ? fielder : null };
      wicket = { batter: strikerId, kind: outcome.wicketKind, bowler: inn.bowler, runs: bat.runs, balls: bat.balls };
      inn.fow.push({ runs: inn.runs, wicket: inn.wickets, batter: strikerId, over: `${Math.floor(inn.balls / 6)}.${inn.balls % 6}` });
    } else {
      inn.runs += outcome.runs; inn.balls += 1; inn.thisOver.push(String(outcome.runs));
      bat.runs += outcome.runs; bat.balls += 1; bowl.runs += outcome.runs; bowl.balls += 1;
      if (outcome.runs === 4) { inn.fours += 1; bat.fours += 1; }
      if (outcome.runs === 6) { inn.sixes += 1; bat.sixes += 1; }
    }
    if (legal) { inn.partnership.balls += 1; }
    inn.partnership.runs += outcome.wide ? 1 : outcome.runs;
    const overEnd = legal && inn.balls % 6 === 0;
    // strike rotation: odd runs swap the batters; the over's end swaps them again. After a wicket the new
    // batter is placed by nextBall(), which also handles the end-of-over swap.
    if (legal && outcome.type !== 'wicket' && outcome.runs % 2 === 1) [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
    if (overEnd && outcome.type !== 'wicket') [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
    const inningsEnd = this.inningsOver(inn);
    this.lastResult = {
      seq: d.seq, pending: false, type: outcome.type, runs: outcome.wide ? 1 : outcome.runs, wicketKind: outcome.type === 'wicket' ? outcome.wicketKind : null,
      contact: outcome.contact, wide: outcome.wide, shot: outcome.shot, fielderZone: outcome.fielderZone, commentary: outcome.commentary,
      umpire: outcome.umpire, decisionPending: false, review: review ? { by: review.by, kind: review.kind, overturned: review.overturned, verdict: review.verdict, retained: review.retained } : null,
      ball: { lineIndex: d.lineIndex, turn: d.turn, length: d.length, pace: d.pace, wide: d.wide },
      wicket, overEnd, inningsEnd, batter: strikerId, bowler: inn.bowler,
      score: { runs: inn.runs, wickets: inn.wickets, balls: inn.balls },
    };
    this.delivery = { ...d, state: 'result', outcome: undefined, reviewData: undefined };
    return [{ t: 'result', ...this.lastResult }];
  }

  inningsOver(inn) {
    return inn.wickets >= this.settings.wickets || inn.wickets >= inn.order.length - 1
      || inn.balls >= this.settings.overs * 6 || (this.inningsIndex === 1 && inn.runs >= this.target);
  }

  nextBall() {
    if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'result') return [];
    const inn = this.current();
    const events = [];
    if (this.lastResult.inningsEnd) {
      if (this.inningsIndex === 0) {
        this.phase = 'break';
        this.delivery = null;
        return [{ t: 'inningsEnd', innings: 0, score: { runs: inn.runs, wickets: inn.wickets, balls: inn.balls }, target: inn.runs + 1 }];
      }
      return this.finish();
    }
    if (this.lastResult.wicket) {
      const id = inn.order[inn.nextIn];
      inn.nextIn += 1;
      // The new batter takes the dismissed batter's end. If the over also ended, the strike rotates, so the
      // surviving batter faces and the newcomer waits at the non-striker's end.
      if (this.lastResult.overEnd) { inn.striker = inn.nonStriker; inn.nonStriker = id; }
      else inn.striker = id;
      inn.partnership = { runs: 0, balls: 0 };
      events.push({ t: 'newBatter', batter: id });
    }
    const overNo = Math.floor(inn.balls / 6);
    if (overNo !== inn.overNo) {
      inn.oversLog.push(inn.thisOver);
      inn.overNo = overNo;
      inn.thisOver = [];
      inn.lastBowler = inn.bowler;
      inn.bowler = null;
      this.delivery = { state: 'awaitingBowler' };
      events.push({ t: 'overEnd', over: overNo });
    } else {
      this.delivery = { state: 'awaitingBowl' };
      events.push({ t: 'nextBall' });
    }
    return events;
  }

  finish() {
    const [a, b] = this.innings;
    const t = this.target;
    let text, winnerSlot;
    if (b.runs >= t) {
      winnerSlot = b.battingSlot;
      const wk = Math.min(this.settings.wickets, b.order.length - 1) - b.wickets;
      const left = this.settings.overs * 6 - b.balls;
      const spare = left > 0 ? ` with ${left} ball${left === 1 ? '' : 's'} to spare` : '';
      text = `${this.teamName(winnerSlot)} won by ${wk} wicket${wk === 1 ? '' : 's'}${spare}!`;
    } else if (b.runs === t - 1) {
      winnerSlot = null;
      text = 'Match tied!';
    } else {
      winnerSlot = a.battingSlot;
      const by = t - 1 - b.runs;
      text = `${this.teamName(winnerSlot)} won by ${by} run${by === 1 ? '' : 's'}!`;
    }
    this.phase = 'finished';
    this.delivery = null;
    this.result = { text, winnerSlot, abandoned: false };
    return [{ t: 'finished', result: this.result }];
  }

  requestRematch(playerId) {
    const slot = this.slotOf(playerId);
    if (this.phase !== 'finished' || slot < 0) fail('No match to replay yet.');
    if ((this.result && this.result.abandoned) || !this.isFull) fail('Your opponent has left.');
    this.rematch.add(slot);
    const events = [{ t: 'rematchVote', slot, votes: [...this.rematch] }];
    if (this.rematch.size === 2) {
      const caller = this.toss ? 1 - this.toss.caller : 1;
      Object.assign(this, { innings: [], inningsIndex: -1, target: null, delivery: null, lastResult: null, result: null, seq: 0 });
      this.rematch = new Set();
      this.phase = 'toss';
      this.toss = { caller, call: null, landed: null, winner: null, choice: null };
      events.push({ t: 'rematch' }, { t: 'tossStart', caller });
    }
    return events;
  }

  // ---- time-driven transitions
  pendingAction() {
    if (this.phase === 'teams') return { action: 'autoTeams', delayMs: this.delay('teams') };
    if (this.phase === 'toss') {
      if (!this.toss.call) return { action: 'autoToss', delayMs: this.delay('autoToss') };
      if (!this.toss.choice) return { action: 'autoChoose', delayMs: this.delay('autoToss') };
      return null;
    }
    if (this.phase === 'break') return { action: 'startInnings', delayMs: this.delay('inningsBreak') };
    if (this.phase !== 'innings' || !this.delivery) return null;
    const d = this.delivery;
    switch (d.state) {
      case 'awaitingBowler': return { action: 'autoBowler', delayMs: this.delay('autoBowler') };
      case 'awaitingBowl': return { action: 'autoBowl', delayMs: this.delay('autoBowl') };
      case 'inFlight': return { action: 'noShot', delayMs: d.lead + d.flightMs + this.delay('shotGrace') };
      case 'decision': return { action: 'decisionStands', delayMs: this.delay('decision') };
      case 'reviewing': return { action: 'reviewDone', delayMs: this.delay('review') };
      default: {
        const r = this.lastResult;
        let ms = this.delay('result');
        if (r.type === 'wicket') ms += this.delay('wicketExtra');
        if (r.overEnd) ms += this.delay('overExtra');
        if (r.inningsEnd) ms += this.delay('inningsEndExtra');
        return { action: 'nextBall', delayMs: ms };
      }
    }
  }

  perform(action) {
    switch (action) {
      case 'autoTeams': {
        if (this.phase !== 'teams') return [];
        const events = [];
        for (const p of this.players) if (p && !(p.team && p.team.ready)) events.push(...this.autoTeam(p.id));
        return events;
      }
      case 'autoToss':
        if (this.phase !== 'toss' || this.toss.call) return [];
        return this.callToss(this.players[this.toss.caller].id, pick(this.rng, SIDES));
      case 'autoChoose':
        if (this.phase !== 'toss' || this.toss.winner === null || this.toss.choice) return [];
        return this.chooseToss(this.players[this.toss.winner].id, 'bat');
      case 'autoBowler': {
        if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'awaitingBowler') return [];
        const inn = this.current();
        const list = this.eligibleBowlers(inn);
        const overs = (id) => Math.floor(((inn.bowling[id] || {}).balls || 0) / 6);
        list.sort((a, b) => (this.cricketer(b).bowl - overs(b) * 8) - (this.cricketer(a).bowl - overs(a) * 8));
        return this.chooseBowler(this.players[inn.bowlingSlot].id, list[0], { auto: true });
      }
      case 'autoBowl': {
        if (this.phase !== 'innings' || !this.delivery || this.delivery.state !== 'awaitingBowl') return [];
        const inn = this.current();
        const allowed = PACES_FOR[this.cricketer(inn.bowler).bowlType] || PACES_FOR.medium;
        return this.bowl(this.players[inn.bowlingSlot].id,
          { line: pick(this.rng, LINES), length: pick(this.rng, LENGTHS), pace: pick(this.rng, allowed), timing: (this.rng() - 0.5) * 500 }, { auto: true });
      }
      case 'noShot': return this.noShot();
      case 'decisionStands': return this.decisionStands();
      case 'reviewDone': return this.reviewDone();
      case 'nextBall': return this.nextBall();
      case 'startInnings':
        if (this.phase !== 'break') return [];
        return this.startInnings(1 - this.innings[0].battingSlot);
      default: return [];
    }
  }

  snapshot() {
    const d = this.delivery;
    const pending = d && (d.state === 'decision' || d.state === 'reviewing') ? d.outcome.appeal : null;
    return {
      id: this.id, code: this.code, phase: this.phase, settings: { ...this.settings },
      players: this.players.map((p, slot) => (p ? { slot, id: p.id, name: p.name, connected: p.connected !== false, team: p.team ? { name: p.team.name, squad: [...p.team.squad], ready: !!p.team.ready } : null } : null)),
      toss: this.toss ? { ...this.toss } : null,
      innings: this.innings.map((i) => ({
        ...i, thisOver: [...i.thisOver], oversLog: i.oversLog.map((o) => [...o]), order: [...i.order],
        batting: Object.fromEntries(Object.entries(i.batting).map(([k, v]) => [k, { ...v }])),
        bowling: Object.fromEntries(Object.entries(i.bowling).map(([k, v]) => [k, { ...v }])),
        reviewsLeft: [...i.reviewsLeft], fow: i.fow.map((f) => ({ ...f })), partnership: { ...i.partnership },
      })),
      inningsIndex: this.inningsIndex, target: this.target,
      delivery: d ? {
        state: d.state, seq: d.seq, bowler: d.bowler, bowlerId: d.bowlerId, striker: d.striker, lineIndex: d.lineIndex, turn: d.turn, line: d.line,
        length: d.length, pace: d.pace, wide: d.wide, flightMs: d.flightMs, lead: d.lead, auto: d.auto,
        reviewer: d.state === 'decision' ? d.reviewer : null,
        decision: pending ? pending.decision : null, appealKind: pending ? pending.kind : null,
        eligibleBowlers: d.state === 'awaitingBowler' ? this.eligibleBowlers(this.current()) : null,
      } : null,
      lastResult: this.lastResult, result: this.result, rematch: [...this.rematch],
    };
  }
}

module.exports = {
  Match, resolveDelivery, EngineError, validateSquad, autoPick, playerPrice, overallRating, canBowl, maxOversPerBowler, bowlersNeeded,
  LINES, LENGTHS, PACES, PACES_FOR, DIRS, KINDS, SIDES, DELAYS, TEAM_SIZE, BUDGET,
};
