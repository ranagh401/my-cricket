'use strict';
// Shared test helpers: a seeded generator and a small fake player pool.

function seeded(seed) {
  let s = (seed * 2654435761) >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 4; i++) next();   // warm up: the first outputs of an LCG are nearly linear in the seed
  return next;
}

// 22 players: p0 keeper, odd ids bowl (p1, p5, p9... spinners), the rest batters. Prices stay modest so an
// XI fits the budget, except p20/p21 who are expensive stars.
function fakePool() {
  const pool = [];
  for (let i = 0; i < 22; i++) {
    const bowler = i % 2 === 1;
    const star = i >= 20;
    const spinner = bowler && i % 4 === 1;
    pool.push({
      id: `p${i}`, name: `Player ${i}`, country: i < 11 ? 'AAA' : 'BBB',
      role: i === 0 ? 'wk' : bowler ? 'bowl' : 'bat',
      bat: star ? 95 : bowler ? 30 + (i % 3) * 5 : 52 + (i % 5) * 5,
      bowl: bowler ? (star ? 95 : 55 + (i % 4) * 8) : 10,
      hand: i % 3 === 2 ? 'L' : 'R',
      bowlType: bowler ? (spinner ? 'spin' : 'fast') : null,
      spin: spinner ? (i % 8 === 1 ? 'off' : 'leg') : null,
    });
  }
  return pool;
}

module.exports = { seeded, fakePool };
