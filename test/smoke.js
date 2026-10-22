// Seeded run of the engine without a server: two auto-picked XIs, toss, a full match with random shots.
//   node test/smoke.js [seed] [overs] [wickets]
const { Match } = require('../engine.js');
let pool = [];
try { pool = require('../public/players.js'); } catch { /* fall back to a fake pool below */ }
if (!pool.length) {
  for (let i = 0; i < 22; i++) {
    const bowler = i % 2 === 1;
    pool.push({ id: `p${i}`, name: `Player ${i}`, country: 'TST', role: bowler ? 'bowl' : i === 0 ? 'wk' : 'bat', bat: bowler ? 30 : 60 + (i % 5) * 7, bowl: bowler ? 60 + (i % 4) * 8 : 10, hand: i % 3 ? 'R' : 'L', bowlType: bowler ? (i % 4 === 1 ? 'spin' : 'fast') : null, spin: bowler && i % 4 === 1 ? 'off' : null });
  }
}
let s = Number(process.argv[2] || 12345);
const rng = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
const noise = Number(process.argv[5] || 200);   // +/- ms of timing error in the random shots
const m = new Match({ id: 'm1', code: 'ABCD', overs: Number(process.argv[3] || 2), wickets: Number(process.argv[4] || 3), pool, rng });
m.addPlayer({ id: 'a', name: 'Asha' });
m.addPlayer({ id: 'b', name: 'Bilal' });
console.log('phase after join:', m.phase);
m.perform('autoTeams');
console.log('teams:', m.players.map((p) => `${p.team.name}: ${p.team.squad.slice(0, 4).join(', ')}...`).join(' | '));
console.log('toss:', JSON.stringify(m.callToss('b', 'heads')));
m.chooseToss(m.players[m.toss.winner].id, 'bat');
const nameOf = (id) => (m.poolById.get(id) || { name: id }).name;
let guard = 0, decisions = 0, reviews = 0;
while (m.phase !== 'finished' && guard++ < 3000) {
  const d = m.delivery;
  if (m.phase === 'innings' && d) {
    if (d.state === 'awaitingBowler') { const ev = m.perform('autoBowler'); console.log(`  over ${ev[0].over + 1}: ${nameOf(ev[0].bowler)} to bowl`); continue; }
    if (d.state === 'awaitingBowl') { m.perform('autoBowl'); continue; }
    if (d.state === 'inFlight') {
      const bat = m.players[m.current().battingSlot].id;
      if (rng() < 0.08) { const evs = m.noShot(); console.log(`  ${d.pace} ${d.line}/${d.length} -> (no shot) ${evs[0].commentary}`); continue; }
      const evs = m.shot(bat, { dir: ['leg', 'straight', 'off'][Math.floor(rng() * 3)], kind: ['defend', 'attack', 'loft'][Math.floor(rng() * 3)], t: d.flightMs + (rng() - 0.5) * 2 * noise });
      const last = evs[evs.length - 1];
      const r = evs[0];
      console.log(`  ${d.pace}${d.turn ? ' (turns ' + d.turn + ')' : ''} ${d.line}/${d.length} -> ${r.commentary}${last.t === 'decision' ? ` [umpire: ${last.decision.toUpperCase()}, reviewer slot ${last.reviewer}]` : ''}`);
      continue;
    }
    if (d.state === 'decision') {
      decisions += 1;
      if (d.reviewer !== null && rng() < 0.7) {
        reviews += 1;
        const ev = m.review(m.players[d.reviewer].id)[0];
        console.log(`    REVIEW by slot ${ev.by}: ${ev.kind} ${ev.kind === 'lbw' ? `${ev.pitching}/${ev.impact}/${ev.wickets}` : `ultraEdge=${ev.ultraEdge}`} -> ${ev.verdict} (${ev.overturned ? 'OVERTURNED' : ev.retained ? 'umpire\'s call' : 'stands, review lost'})`);
        const fin = m.perform('reviewDone');
        console.log(`    ${fin[0].commentary}`);
      } else {
        const fin = m.perform('decisionStands');
        console.log(`    decision stands: ${fin[0].type === 'wicket' ? 'OUT' : 'not out'}`);
      }
      continue;
    }
  }
  const p = m.pendingAction();
  if (!p) break;
  const evs = m.perform(p.action);
  for (const ev of evs) {
    if (ev.t === 'inningsEnd') console.log(`== innings over: ${ev.score.runs}/${ev.score.wickets} in ${Math.floor(ev.score.balls / 6)}.${ev.score.balls % 6}, target ${ev.target}`);
    if (ev.t === 'newBatter') console.log(`  new batter: ${nameOf(ev.batter)}`);
  }
}
const inn = m.innings;
console.log('\nRESULT:', m.phase, '|', m.result && m.result.text, '| steps', guard, '| decisions', decisions, '| reviews', reviews);
for (const i of inn) {
  console.log(`${m.teamName(i.battingSlot)} ${i.runs}/${i.wickets} (${Math.floor(i.balls / 6)}.${i.balls % 6} ov) extras ${i.extras}`);
  for (const id of i.order) { const b = i.batting[id]; if (b.balls || b.out) console.log(`   ${nameOf(id).padEnd(22)} ${String(b.runs).padStart(3)} (${b.balls})${b.out ? ` ${b.out.kind} b ${nameOf(b.out.bowler)}` : ' not out'}`); }
  for (const [id, b] of Object.entries(i.bowling)) console.log(`   bowl ${nameOf(id).padEnd(20)} ${Math.floor(b.balls / 6)}.${b.balls % 6}-${b.runs}-${b.wickets}`);
}
