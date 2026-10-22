// MY CRICKET client: lobby, XI builder, match HUD, controls, DRS, and the WebSocket link to server.js.
// The 3D presentation lives in render.js (an ES module that sets window.Renderer when ready).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'), conn: $('conn'), lobby: $('screen-lobby'), teams: $('screen-teams'), game: $('screen-game'),
    name: $('name'), overs: $('overs'), wickets: $('wickets'), reviews: $('reviews'), create: $('create'), code: $('code'), join: $('join'),
    openMatches: $('open-matches'), share: $('share'), shareUrls: $('share-urls'),
    teamsHint: $('teams-hint'), oppTeamStatus: $('opp-team-status'), teamName: $('team-name'), budgetTxt: $('budget-txt'), budgetFill: $('budget-fill'),
    squadCount: $('squad-count'), xiCount: $('xi-count'), panePool: $('pane-pool'), paneXi: $('pane-xi'), poolSearch: $('pool-search'),
    poolCountry: $('pool-country'), poolRoles: $('pool-roles'), poolList: $('pool-list'), xiList: $('xi-list'), teamAuto: $('team-auto'), teamLock: $('team-lock'),
    sbTeam: $('sb-team'), sbScore: $('sb-score'), sbOvers: $('sb-overs'), sbDrs: $('sb-drs'), sbStriker: $('sb-striker'), sbNonStriker: $('sb-nonstriker'),
    sbBowler: $('sb-bowler'), sbTarget: $('sb-target'), thisOver: $('this-over'),
    stage: $('stage'), canvas: $('field'), banner: $('banner'), drs: $('drs'), drsTitle: $('drs-title'), drsActions: $('drs-actions'), drsReview: $('drs-review'),
    drsAccept: $('drs-accept'), drsTimerFill: $('drs-timer-fill'), camNote: $('cam-note'), commentary: $('commentary'),
    ctlBowler: $('ctl-bowler'), bowlerTitle: $('bowler-title'), bowlerList: $('bowler-list'), ctlBowl: $('ctl-bowl'), paceGroup: $('pace-group'),
    marker: $('meter-marker'), bowl: $('bowl'), ctlBat: $('ctl-bat'), ctlWait: $('ctl-wait'), waitText: $('wait-text'),
    matchCode: $('match-code'), oppStatus: $('opp-status'), scorecardBtn: $('scorecard-btn'), leave: $('leave'), muteBtn: $('mute-btn'),
    overlay: $('overlay'), overlayCard: $('overlay-card'), toast: $('toast'),
  };

  // ---------------------------------------------------------------- player pool (mirrors engine.js rules)
  const POOL = Array.isArray(window.CRICKET_PLAYERS) ? window.CRICKET_PLAYERS : [];
  const BY_ID = new Map(POOL.map((p) => [p.id, p]));
  const TEAM_SIZE = 11;
  const overall = (p) => (p.role === 'bowl' ? p.bowl : p.role === 'ar' ? Math.min(99, Math.round((p.bat + p.bowl) / 2 + 5)) : p.role === 'wk' ? Math.min(99, p.bat + 3) : p.bat);
  const price = (p) => Math.max(4, overall(p) - 55);   // keep in step with playerPrice() in engine.js
  const canBowl = (p) => !!p.bowlType && p.bowl >= 40;
  const maxOversPerBowler = (overs) => Math.max(1, Math.ceil(overs / 5));
  const bowlersNeeded = (overs) => Math.min(5, Math.ceil(overs / maxOversPerBowler(overs)));
  const cricketer = (id) => BY_ID.get(id) || { id, name: String(id || '?'), country: '', role: 'bat', bat: 60, bowl: 40, hand: 'R', bowlType: 'medium' };
  const shortName = (id) => { const n = cricketer(id).name.split(' '); return n.length > 1 ? `${n[0][0]}. ${n.slice(1).join(' ')}` : n[0]; };
  const ROLE_LABEL = { bat: 'BAT', bowl: 'BOWL', ar: 'AR', wk: 'WK' };
  const COUNTRY_KIT = {
    IND: ['#1d4ed8', '#f97316'], AUS: ['#facc15', '#166534'], ENG: ['#1e3a8a', '#dc2626'], PAK: ['#15803d', '#fde047'], NZ: ['#111827', '#2dd4bf'],
    SA: ['#166534', '#facc15'], SL: ['#1d4ed8', '#fde047'], WI: ['#7f1d1d', '#fbbf24'], BAN: ['#166534', '#dc2626'], AFG: ['#1e40af', '#dc2626'],
  };
  const SLOT_KIT = [['#1f5fbf', '#f3c23b'], ['#1e8a4c', '#ffd54a']];

  // ---------------------------------------------------------------- state
  const choice = { line: 'middle', length: 'good', pace: 'fast', kind: 'attack' };
  const meter = { running: false, start: 0, timeout: null };
  const team = { name: '', squad: [], q: '', country: '', role: '' };
  let ws = null, retryMs = 600, retryTimer = null;
  let me = { id: null, slot: null };
  let state = null;
  let renderer = null;
  let t0 = 0;                 // local time the current ball leaves the hand
  let shotSeq = null;         // delivery I already played at
  let sceneKey = '', matchKey = '';
  let lanUrls = [];
  let lastOverlay = '';
  let overlayMode = null;     // null | 'scorecard' (user-opened)
  let toastTimer = null, bannerTimer = null, drsTimer = null, drsDeadline = 0;
  let seenDecisionSeq = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const playerName = (slot) => (state && state.players && state.players[slot] ? state.players[slot].name : 'Opponent');
  const teamName = (slot) => (state && state.players && state.players[slot] && state.players[slot].team ? state.players[slot].team.name : playerName(slot));
  const oversText = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
  const currentInnings = () => (state && state.innings[state.inningsIndex]) || null;
  const amBatting = () => { const i = currentInnings(); return !!(state && state.phase === 'innings' && i && i.battingSlot === me.slot); };
  const amBowling = () => { const i = currentInnings(); return !!(state && state.phase === 'innings' && i && i.bowlingSlot === me.slot); };
  const myName = () => (el.name.value.trim() || 'Player').slice(0, 16);
  const now = () => performance.now();

  // ---------------------------------------------------------------- renderer (3D module loads asynchronously)
  function initRenderer() {
    if (renderer || typeof window.Renderer !== 'function') return;
    try {
      renderer = new window.Renderer(el.canvas);
      el.camNote.classList.add('hidden');
      matchKey = ''; sceneKey = '';
      if (state) { syncMatch(); syncScene(); }
    } catch (e) {
      console.error('renderer failed', e);
      el.camNote.textContent = '3D view unavailable on this device';
      el.camNote.classList.remove('hidden');
    }
  }
  window.addEventListener('renderer-ready', initRenderer);
  setTimeout(() => { if (!renderer) { el.camNote.textContent = typeof window.Renderer === 'function' ? '' : 'Loading 3D view…'; el.camNote.classList.toggle('hidden', !el.camNote.textContent); initRenderer(); } }, 1500);
  setTimeout(() => { if (!renderer) { el.camNote.textContent = '3D view unavailable (WebGL needed). The match still plays here.'; el.camNote.classList.remove('hidden'); } }, 8000);
  const R = (fn) => { if (!renderer) return; try { fn(renderer); } catch (e) { console.error('renderer error', e); } };
  const S = (name, delayMs = 0) => {
    if (!window.CricketSound) return;
    if (delayMs > 0) setTimeout(() => window.CricketSound.play(name), delayMs);
    else window.CricketSound.play(name);
  };

  function kitFor(slot) {
    const p = state.players[slot];
    if (p && p.team) {
      const counts = {};
      for (const id of p.team.squad) { const c = cricketer(id).country; counts[c] = (counts[c] || 0) + 1; }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      const other = state.players[1 - slot];
      let otherTop = null;
      if (other && other.team) {
        const oc = {};
        for (const id of other.team.squad) { const c = cricketer(id).country; oc[c] = (oc[c] || 0) + 1; }
        otherTop = Object.entries(oc).sort((a, b) => b[1] - a[1])[0];
      }
      if (top && COUNTRY_KIT[top[0]] && !(otherTop && otherTop[0] === top[0] && slot === 1)) return COUNTRY_KIT[top[0]];
    }
    return SLOT_KIT[slot];
  }

  function syncMatch() {
    if (!state || !state.players.every((p) => p && p.team)) return;
    const key = state.players.map((p) => p.team.name + ':' + p.team.squad.join(',')).join('|');
    if (key === matchKey) return;
    matchKey = key;
    const teams = state.players.map((p, slot) => {
      const [color, color2] = kitFor(slot);
      return { name: p.team.name, short: p.team.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || `T${slot + 1}`, color, color2 };
    });
    R((r) => r.setMatch({ teams }));
  }

  function syncScene() {
    const inn = currentInnings();
    if (!inn) return;
    const key = `${inn.battingSlot}:${inn.striker}:${inn.nonStriker}:${inn.bowler}`;
    if (key === sceneKey) return;
    sceneKey = key;
    const s = cricketer(inn.striker), n = cricketer(inn.nonStriker), b = cricketer(inn.bowler);
    R((r) => r.setScene({
      battingSlot: inn.battingSlot, bowlingSlot: inn.bowlingSlot,
      striker: { name: s.name, hand: s.hand || 'R' }, nonStriker: { name: n.name, hand: n.hand || 'R' },
      bowler: { name: b.name, type: b.bowlType || 'medium' },
    }));
  }

  // ---------------------------------------------------------------- connection
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function setConn(ok, text) { el.conn.classList.toggle('is-off', !ok); el.conn.textContent = text || (ok ? 'Connected' : 'Reconnecting…'); }

  function connect() {
    clearTimeout(retryTimer);
    if (ws && ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/');
    ws.onopen = () => {
      let token = null;
      try { token = sessionStorage.getItem('cricket-token'); } catch { /* storage blocked */ }
      send({ t: 'hello', name: myName(), token });
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
    ws.onclose = () => { setConn(false); retryTimer = setTimeout(connect, retryMs); retryMs = Math.min(8000, Math.round(retryMs * 1.6)); };
    ws.onerror = () => { /* onclose follows */ };
  }

  function handle(m) {
    switch (m.t) {
      case 'welcome':
        retryMs = 600;
        me.id = m.id;
        try { sessionStorage.setItem('cricket-token', m.token); } catch { /* storage blocked */ }
        setConn(true);
        break;
      case 'lobby':
        renderLobby(m.matches);
        if (state) { state = null; showScreen('lobby'); }
        break;
      case 'update': {
        me.slot = m.you;
        const prevPhase = state ? state.phase : null;
        state = m.state;
        if (prevPhase !== state.phase) onPhaseChange(prevPhase, state.phase);
        applyState();
        for (const ev of m.events || []) onEvent(ev);
        break;
      }
      case 'error': toast(m.message, true); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- screens
  function showScreen(name) {
    el.lobby.classList.toggle('hidden', name !== 'lobby');
    el.teams.classList.toggle('hidden', name !== 'teams');
    el.game.classList.toggle('hidden', name !== 'game');
    el.app.classList.toggle('wide', name === 'game' && window.innerWidth >= 900);
    if (name !== 'game') { el.overlay.classList.add('hidden'); lastOverlay = ''; overlayMode = null; hideBanner(); hideDrs(); stopMeter(); R((r) => r.idle()); }
    if (name === 'lobby') { el.oppStatus.textContent = ''; send({ t: 'lobby' }); }
    if (name === 'game') { R((r) => r.resize()); }
  }

  function onPhaseChange(prev, next) {
    if (next === 'waiting' || next === 'toss' || next === 'innings' || next === 'break' || next === 'finished') {
      if (!el.game.classList.contains('hidden') === false) showScreen('game');
      else if (next === 'waiting') showScreen('game');
    }
    if (next === 'teams') { setupTeamBuilder(); showScreen('teams'); }
    if (prev === 'teams' && next === 'toss') { showScreen('game'); el.matchCode.textContent = state.code; setCommentary('Teams are in. Time for the toss.'); }
    if (next === 'innings' && prev !== 'innings') { sceneKey = ''; shotSeq = null; }
    if (next === 'waiting') { el.matchCode.textContent = state.code; setCommentary(''); }
    if (next === 'toss' && prev === 'finished') { hideBanner(); R((r) => r.idle()); setCommentary('Rematch! New toss.'); }
  }

  function applyState() {
    el.matchCode.textContent = state.code || '';
    if (state.phase === 'teams') { updateTeamsScreen(); return; }
    if (el.game.classList.contains('hidden') && state.phase !== 'teams') showScreen('game');
    syncMatch();
    syncScene();
    updateScorebug();
    updateControls();
    updateDrs();
    updateOverlay();
  }

  function renderLobby(matches) {
    el.openMatches.innerHTML = '';
    if (!matches || !matches.length) {
      el.openMatches.innerHTML = '<p class="muted">No open matches yet. Create one, or ask your friend for their code.</p>';
      return;
    }
    for (const m of matches) {
      const row = document.createElement('div');
      row.className = 'match-row';
      row.innerHTML = `<div><div class="host">${esc(m.host)}'s match</div><div class="meta">${m.overs} over${m.overs === 1 ? '' : 's'} · ${m.wickets} wicket${m.wickets === 1 ? '' : 's'} · ${m.reviews} review${m.reviews === 1 ? '' : 's'} · code ${esc(m.code)}</div></div>`;
      const b = document.createElement('button');
      b.className = 'btn primary';
      b.textContent = 'Join';
      b.onclick = () => join(m.code);
      row.appendChild(b);
      el.openMatches.appendChild(row);
    }
  }

  function shareHtml() {
    if (!lanUrls.length) return '';
    return `<div class="share"><div class="share-title">Friends on this wifi open</div>${lanUrls.map((u) => `<code>${esc(u)}</code>`).join('')}</div>`;
  }

  function loadUrls() {
    fetch('/urls', { cache: 'no-store' }).then((r) => r.json()).then((info) => {
      lanUrls = (info.addresses || []).slice(0, 4).map((a) => `http://${a.address}:${info.port}`);
      if (lanUrls.length) { el.share.classList.remove('hidden'); el.shareUrls.innerHTML = lanUrls.map((u) => `<code>${esc(u)}</code>`).join(''); }
      if (state) { lastOverlay = ''; updateOverlay(); }
    }).catch(() => { /* not important */ });
  }

  function saveName() {
    try { localStorage.setItem('cricket-name', myName()); } catch { /* storage blocked */ }
    send({ t: 'name', name: myName() });
  }
  function create() { saveName(); send({ t: 'create', overs: Number(el.overs.value), wickets: Number(el.wickets.value), reviews: Number(el.reviews.value) }); }
  function join(code) {
    saveName();
    const c = String(code || '').trim().toUpperCase();
    if (c.length !== 4) { toast('Enter the 4-letter code from your friend.', true); return; }
    send({ t: 'join', code: c });
  }
  function leave() {
    if (state && ['teams', 'toss', 'innings', 'break'].includes(state.phase) && !window.confirm('Leave the match? Your opponent wins by default.')) return;
    send({ t: 'leave' });
    state = null;
    showScreen('lobby');
  }

  // ---------------------------------------------------------------- team builder
  function setupTeamBuilder() {
    team.squad = [];
    team.q = ''; team.country = ''; team.role = '';
    el.poolSearch.value = '';
    el.poolCountry.innerHTML = '<option value="">All countries</option>';
    for (const c of [...new Set(POOL.map((p) => p.country))].sort()) { const o = document.createElement('option'); o.value = c; o.textContent = c; el.poolCountry.appendChild(o); }
    el.poolCountry.value = '';
    for (const b of el.poolRoles.querySelectorAll('button')) b.classList.toggle('on', b.dataset.role === '');
    try { el.teamName.value = localStorage.getItem('cricket-team') || ''; } catch { /* storage blocked */ }
    switchPane('pool');
    if (!POOL.length) toast('players.js did not load, so only auto-pick will work.', true);
    renderPool();
    renderXI();
  }

  function updateTeamsScreen() {
    const s = state.settings;
    const need = Math.min(bowlersNeeded(s.overs), s.teamSize);
    el.teamsHint.textContent = `Pick ${s.teamSize} players within ${s.budget} credits. You need at least ${need} bowler${need === 1 ? '' : 's'} for ${s.overs} over${s.overs === 1 ? '' : 's'}; no bowler bowls more than ${maxOversPerBowler(s.overs)} over${maxOversPerBowler(s.overs) === 1 ? '' : 's'}.`;
    const mine = state.players[me.slot] && state.players[me.slot].team;
    const opp = state.players[1 - me.slot];
    const oppReady = !!(opp && opp.team && opp.team.ready);
    el.oppTeamStatus.textContent = opp ? (oppReady ? `${opp.name}: XI locked ✓` : `${opp.name} is picking…`) : '';
    el.oppTeamStatus.classList.toggle('ready', oppReady);
    const locked = !!(mine && mine.ready);
    el.teamLock.disabled = locked;
    el.teamAuto.disabled = locked;
    el.teamLock.textContent = locked ? (oppReady ? 'Starting…' : 'Locked. Waiting for opponent…') : 'Lock in my XI';
    if (locked && mine.squad.length && team.squad.join() !== mine.squad.join()) { team.squad = [...mine.squad]; el.teamName.value = mine.name; renderPool(); renderXI(); }
    updateBudget();
  }

  function switchPane(name) {
    el.panePool.classList.toggle('hidden', name !== 'pool' && window.innerWidth <= 640);
    el.paneXi.classList.toggle('hidden', name !== 'xi' && window.innerWidth <= 640);
    for (const b of document.querySelectorAll('.teams-tabs .tab')) b.classList.toggle('on', b.dataset.tab === name);
  }

  function ratingHtml(label, v) {
    const c = v >= 80 ? '#4ccf7a' : v >= 65 ? '#f3c23b' : '#9fb8a8';
    return `<span class="rating">${label} <i style="--w:${v}%;--c:${c}"></i>${v}</span>`;
  }

  function renderPool() {
    const q = team.q.trim().toLowerCase();
    const list = POOL.filter((p) => (!team.country || p.country === team.country) && (!team.role || p.role === team.role) && (!q || p.name.toLowerCase().includes(q)))
      .sort((a, b) => overall(b) - overall(a));
    const locked = state && state.players[me.slot] && state.players[me.slot].team && state.players[me.slot].team.ready;
    el.poolList.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const p of list.slice(0, 120)) {
      const picked = team.squad.includes(p.id);
      const row = document.createElement('div');
      row.className = `prow${picked ? ' picked' : ''}`;
      row.innerHTML = `<div><div class="pname">${esc(p.name)} <span class="flag">${esc(p.country)}</span> <span class="role ${p.role}">${ROLE_LABEL[p.role] || p.role}</span></div>` +
        `<div class="pmeta">${ratingHtml('Bat', p.bat)} ${ratingHtml('Bowl', p.bowl)} <span>${p.hand === 'L' ? 'LHB' : 'RHB'}${p.bowlType ? ' · ' + (p.bowlType === 'spin' ? (p.spin || 'spin') + ' spin' : p.bowlType) : ''}</span></div></div>` +
        `<div style="text-align:right"><div class="price">${price(p)}</div></div>`;
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = picked ? 'Remove' : 'Add';
      b.disabled = !!locked;
      b.onclick = () => (picked ? removeFromXI(p.id) : addToXI(p.id));
      row.lastElementChild.appendChild(b);
      frag.appendChild(row);
    }
    if (!list.length) frag.appendChild(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'No players match.' }));
    el.poolList.appendChild(frag);
  }

  function renderXI() {
    el.xiList.innerHTML = '';
    el.xiCount.textContent = String(team.squad.length);
    const locked = state && state.players[me.slot] && state.players[me.slot].team && state.players[me.slot].team.ready;
    team.squad.forEach((id, i) => {
      const p = cricketer(id);
      const row = document.createElement('div');
      row.className = 'xi-row';
      row.innerHTML = `<span class="num">${i + 1}</span><div><div class="pname">${esc(p.name)} <span class="flag">${esc(p.country)}</span> <span class="role ${p.role}">${ROLE_LABEL[p.role] || p.role}</span></div><div class="pmeta">Bat ${p.bat} · Bowl ${p.bowl} · ${p.hand === 'L' ? 'LHB' : 'RHB'} · <span class="price">${price(p)}</span></div></div>`;
      const btns = document.createElement('div');
      btns.className = 'xi-btns';
      for (const [label, fn] of [['▲', () => moveInXI(i, -1)], ['▼', () => moveInXI(i, 1)], ['✕', () => removeFromXI(id)]]) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.disabled = !!locked; b.onclick = fn;
        btns.appendChild(b);
      }
      row.appendChild(btns);
      el.xiList.appendChild(row);
    });
    if (!team.squad.length) el.xiList.innerHTML = '<p class="muted small">Nobody picked yet. Add players from the list, or press Auto-pick.</p>';
    updateBudget();
  }

  function updateBudget() {
    if (!state) return;
    const budget = state.settings.budget, size = state.settings.teamSize;
    const spent = team.squad.reduce((s, id) => s + price(cricketer(id)), 0);
    const bowlers = team.squad.filter((id) => canBowl(cricketer(id))).length;
    const need = Math.min(bowlersNeeded(state.settings.overs), size);
    el.budgetTxt.textContent = `${spent} / ${budget}`;
    el.budgetFill.style.width = `${Math.min(100, (spent / budget) * 100)}%`;
    el.budgetFill.classList.toggle('over', spent > budget);
    el.squadCount.textContent = `${team.squad.length} of ${size} picked · ${bowlers} bowler${bowlers === 1 ? '' : 's'} (need ${need})`;
  }

  function addToXI(id) {
    if (team.squad.includes(id)) return;
    if (team.squad.length >= TEAM_SIZE) { toast('Your XI is full. Remove someone first.', true); return; }
    team.squad.push(id);
    renderPool(); renderXI();
  }
  function removeFromXI(id) { team.squad = team.squad.filter((x) => x !== id); renderPool(); renderXI(); }
  function moveInXI(i, d) {
    const j = i + d;
    if (j < 0 || j >= team.squad.length) return;
    [team.squad[i], team.squad[j]] = [team.squad[j], team.squad[i]];
    renderXI();
  }
  function lockTeam() {
    const name = el.teamName.value.trim();
    try { localStorage.setItem('cricket-team', name); } catch { /* storage blocked */ }
    const spent = team.squad.reduce((s, id) => s + price(cricketer(id)), 0);
    if (team.squad.length !== TEAM_SIZE) { toast(`Pick exactly ${TEAM_SIZE} players (you have ${team.squad.length}).`, true); return; }
    if (spent > state.settings.budget) { toast(`Over budget: ${spent} of ${state.settings.budget}.`, true); return; }
    send({ t: 'team', name, squad: team.squad });
  }

  el.teamLock.addEventListener('click', lockTeam);
  el.teamAuto.addEventListener('click', () => { send({ t: 'teamAuto' }); });
  el.poolSearch.addEventListener('input', () => { team.q = el.poolSearch.value; renderPool(); });
  el.poolCountry.addEventListener('change', () => { team.country = el.poolCountry.value; renderPool(); });
  el.poolRoles.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-role]');
    if (!b) return;
    team.role = b.dataset.role;
    for (const x of el.poolRoles.querySelectorAll('button')) x.classList.toggle('on', x === b);
    renderPool();
  });
  for (const tab of document.querySelectorAll('.teams-tabs .tab')) tab.addEventListener('click', () => switchPane(tab.dataset.tab));

  // ---------------------------------------------------------------- scorebug, controls, DRS, overlays
  function batLine(id, inn, star) {
    if (!id) return '';
    const b = inn.batting[id] || { runs: 0, balls: 0 };
    return `${esc(shortName(id))}${star ? '*' : ''} ${b.runs} (${b.balls})`;
  }

  function updateScorebug() {
    const inn = currentInnings();
    if (!inn) {
      for (const k of ['sbTeam', 'sbScore', 'sbOvers', 'sbDrs', 'sbStriker', 'sbNonStriker', 'sbBowler', 'sbTarget']) el[k].textContent = '';
      el.thisOver.innerHTML = '';
      return;
    }
    el.sbTeam.textContent = teamName(inn.battingSlot);
    el.sbScore.textContent = `${inn.runs}/${inn.wickets}`;
    el.sbOvers.textContent = `${oversText(inn.balls)} / ${state.settings.overs} ov`;
    const rl = inn.reviewsLeft || [0, 0];
    el.sbDrs.innerHTML = state.settings.reviews ? `DRS <b>${rl[inn.battingSlot]}</b>·<b>${rl[inn.bowlingSlot]}</b>` : '';
    el.sbDrs.title = `Reviews left: ${teamName(inn.battingSlot)} ${rl[inn.battingSlot]}, ${teamName(inn.bowlingSlot)} ${rl[inn.bowlingSlot]}`;
    el.sbStriker.innerHTML = batLine(inn.striker, inn, true);
    el.sbStriker.classList.add('on');
    el.sbNonStriker.innerHTML = batLine(inn.nonStriker, inn, false);
    if (inn.bowler) {
      const f = inn.bowling[inn.bowler] || { balls: 0, runs: 0, wickets: 0 };
      el.sbBowler.innerHTML = `<b>${esc(shortName(inn.bowler))}</b> ${oversText(f.balls)}-${f.runs}-${f.wickets}`;
    } else el.sbBowler.textContent = state.delivery && state.delivery.state === 'awaitingBowler' ? 'Choosing a bowler…' : '';
    if (state.inningsIndex === 1) {
      const need = state.target - inn.runs;
      const left = state.settings.overs * 6 - inn.balls;
      const rrr = left > 0 ? (need / left * 6).toFixed(2) : '-';
      el.sbTarget.textContent = need > 0 ? `Target ${state.target} · need ${need} off ${left} ball${left === 1 ? '' : 's'} · RRR ${rrr}` : `Target ${state.target} reached`;
    } else {
      const rr = inn.balls ? (inn.runs / inn.balls * 6).toFixed(2) : '0.00';
      el.sbTarget.textContent = `1st innings · ${teamName(inn.bowlingSlot)} bowling · RR ${rr}`;
    }
    el.thisOver.innerHTML = '';
    for (const b of inn.thisOver) {
      const s = document.createElement('span');
      s.textContent = b;
      s.className = b === '4' ? 'b4' : b === '6' ? 'b6' : b === 'W' ? 'bw' : b === 'wd' ? 'wd' : '';
      el.thisOver.appendChild(s);
    }
  }

  function updateControls() {
    const d = state.delivery;
    const inn = currentInnings();
    const batting = amBatting(), bowling = amBowling();
    const pickingBowler = bowling && d && d.state === 'awaitingBowler';
    el.ctlBowler.classList.toggle('hidden', !pickingBowler);
    el.ctlBowl.classList.toggle('hidden', !bowling || pickingBowler);
    el.ctlBat.classList.toggle('hidden', !batting);
    el.ctlWait.classList.toggle('hidden', bowling || batting);
    if (pickingBowler) {
      el.bowlerTitle.textContent = `Over ${inn.overNo + 1}: pick your bowler`;
      el.bowlerList.innerHTML = '';
      for (const id of d.eligibleBowlers || []) {
        const p = cricketer(id);
        const f = inn.bowling[id] || { balls: 0, runs: 0, wickets: 0 };
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bowler-btn';
        b.innerHTML = `<span class="bname">${esc(p.name)}</span><span class="bmeta">${p.bowlType === 'spin' ? (p.spin || '') + ' spin' : p.bowlType} · bowl ${p.bowl} · ${oversText(f.balls)}-${f.runs}-${f.wickets}</span>`;
        b.onclick = () => { send({ t: 'bowler', id }); };
        el.bowlerList.appendChild(b);
      }
    }
    if (bowling && !pickingBowler) {
      const can = !!(d && d.state === 'awaitingBowl');
      const type = inn.bowler ? (cricketer(inn.bowler).bowlType || 'medium') : 'medium';
      const paces = type === 'spin' ? [['spin', 'Spin'], ['arm', 'Arm ball']] : [['fast', 'Fast'], ['slower', 'Slower']];
      if (!paces.some(([v]) => v === choice.pace)) choice.pace = paces[0][0];
      if (el.paceGroup.dataset.type !== type) {
        el.paceGroup.dataset.type = type;
        el.paceGroup.innerHTML = paces.map(([v, label]) => `<button type="button" data-v="${v}">${label}</button>`).join('');
      }
      for (const b of el.paceGroup.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === choice.pace);
      for (const b of el.ctlBowl.querySelectorAll('.opt-group button')) b.disabled = !can;
      if (!can && meter.running) stopMeter();
      el.bowl.disabled = !can;
      el.bowl.textContent = can ? (meter.running ? 'Release!' : 'Bowl') : d && d.state === 'inFlight' ? 'Ball in play…' : 'Wait…';
    }
    if (batting) {
      const can = !!(d && d.state === 'inFlight' && shotSeq !== d.seq);
      for (const b of el.ctlBat.querySelectorAll('.shot')) b.disabled = !can;
      const lefty = cricketer(inn.striker).hand === 'L';
      el.ctlBat.querySelector('[data-side="left"]').textContent = lefty ? '◀ Off' : '◀ Leg';
      el.ctlBat.querySelector('[data-side="right"]').textContent = lefty ? 'Leg ▶' : 'Off ▶';
    }
    if (!bowling && !batting) el.waitText.textContent = state.phase === 'innings' ? 'Watching…' : state.phase === 'waiting' ? 'Waiting for an opponent…' : '';
    const opp = state.players && state.players[1 - me.slot];
    el.oppStatus.textContent = opp && opp.connected === false ? `${opp.name} lost connection… waiting` : '';
  }

  function updateDrs() {
    const d = state.delivery;
    if (!d || d.state !== 'decision' || state.phase !== 'innings') { hideDrs(); return; }
    const inn = currentInnings();
    const decisionText = d.decision === 'out' ? 'OUT' : 'NOT OUT';
    const kind = d.appealKind === 'lbw' ? 'lbw' : 'caught behind';
    const rl = inn.reviewsLeft || [0, 0];
    if (d.reviewer === me.slot) {
      el.drsTitle.innerHTML = `Umpire says <b>${decisionText}</b> (${kind}).<small>Review it? You have ${rl[me.slot]} review${rl[me.slot] === 1 ? '' : 's'} left. A failed review is lost.</small>`;
      el.drsActions.classList.remove('hidden');
    } else {
      const who = d.reviewer === null ? null : playerName(d.reviewer);
      el.drsTitle.innerHTML = `Umpire says <b>${decisionText}</b> (${kind}).<small>${who ? `${esc(who)} is deciding whether to review…` : 'No reviews left, the decision stands.'}</small>`;
      el.drsActions.classList.add('hidden');
    }
    el.drs.classList.remove('hidden');
  }

  function startDrsTimer(ms) {
    clearInterval(drsTimer);
    drsDeadline = now() + ms;
    el.drsTimerFill.style.width = '100%';
    drsTimer = setInterval(() => {
      const left = Math.max(0, drsDeadline - now());
      el.drsTimerFill.style.width = `${(left / ms) * 100}%`;
      if (left <= 0) clearInterval(drsTimer);
    }, 200);
  }
  function hideDrs() { el.drs.classList.add('hidden'); clearInterval(drsTimer); }
  el.drsReview.addEventListener('click', () => send({ t: 'review' }));
  el.drsAccept.addEventListener('click', () => send({ t: 'accept' }));

  function scorecardHtml(inn, label) {
    if (!inn) return '';
    const rows = inn.order.map((id, i) => {
      const b = inn.batting[id];
      if (!b) return '';
      const faced = b.balls > 0 || b.out || id === inn.striker || id === inn.nonStriker;
      if (!faced && i >= 2) return '';
      const how = b.out ? (b.out.kind === 'caught' ? `c ${b.out.fielder === 'keeper' ? '†keeper' : 'fielder'} b ${esc(shortName(b.out.bowler))}` : `${b.out.kind} b ${esc(shortName(b.out.bowler))}`) : (id === inn.striker || id === inn.nonStriker ? 'not out' : 'did not bat');
      const sr = b.balls ? (b.runs / b.balls * 100).toFixed(0) : '-';
      return `<tr><td>${esc(cricketer(id).name)}${!b.out && (id === inn.striker) && state.phase === 'innings' ? '*' : ''}</td><td class="how">${how}</td><td class="bold">${b.runs}</td><td>${b.balls}</td><td>${b.fours}</td><td>${b.sixes}</td><td>${sr}</td></tr>`;
    }).join('');
    const bowl = Object.entries(inn.bowling).map(([id, f]) => `<tr><td>${esc(cricketer(id).name)}</td><td>${oversText(f.balls)}</td><td>${f.runs}</td><td class="bold">${f.wickets}</td><td>${f.balls ? (f.runs / f.balls * 6).toFixed(2) : '-'}</td></tr>`).join('');
    const fow = inn.fow.length ? `<div class="extras">Fall of wickets: ${inn.fow.map((f) => `${f.runs}-${f.wicket} (${esc(shortName(f.batter))}, ${f.over})`).join(', ')}</div>` : '';
    return `<div class="scorecard"><h3>${esc(teamName(inn.battingSlot))} ${inn.runs}/${inn.wickets} <span>${oversText(inn.balls)} ov${label ? ' · ' + label : ''}</span></h3>` +
      `<table><tr><th>Batter</th><th></th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr>${rows}</table>` +
      `<div class="extras">Extras ${inn.extras} (wides)</div>${fow}` +
      `<table style="margin-top:6px"><tr><th>Bowler</th><th>O</th><th>R</th><th>W</th><th>Econ</th></tr>${bowl}</table></div>`;
  }

  function updateOverlay() {
    const ph = state.phase;
    let html = '';
    if (overlayMode === 'scorecard') {
      html = `<h2>Scorecard</h2>${state.innings.map((i, k) => scorecardHtml(i, k === 0 ? '1st innings' : '2nd innings')).join('') || '<p class="muted">No play yet.</p>'}<div class="actions"><button class="btn" data-act="close">Close</button></div>`;
    } else if (ph === 'waiting') {
      html = `<h2>Waiting for an opponent</h2><p class="muted">Your friend opens this page on the same wifi and joins with the code</p>` +
        `<div class="big-code">${esc(state.code)}</div>${shareHtml()}<div class="actions"><button class="btn" data-act="leave">Cancel</button></div>`;
    } else if (ph === 'toss') {
      const t = state.toss;
      if (!t.call) {
        html = t.caller === me.slot
          ? `<h2>The toss</h2><div class="coin">🪙</div><p>You call it.</p><div class="actions"><button class="btn primary" data-act="call" data-v="heads">Heads</button><button class="btn primary" data-act="call" data-v="tails">Tails</button></div>`
          : `<h2>The toss</h2><div class="coin">🪙</div><p class="muted">${esc(playerName(t.caller))} is calling…</p>`;
      } else {
        const won = t.winner === me.slot;
        html = `<h2>It's ${esc(t.landed)}!</h2><p>${esc(playerName(t.caller))} called ${esc(t.call)}. <b>${won ? 'You' : esc(playerName(t.winner))}</b> won the toss.</p>` +
          (won ? `<div class="actions"><button class="btn primary" data-act="choose" data-v="bat">Bat first</button><button class="btn primary" data-act="choose" data-v="bowl">Bowl first</button></div>`
            : `<p class="muted">Waiting for ${esc(playerName(t.winner))} to choose…</p>`);
      }
    } else if (ph === 'break') {
      const a = state.innings[0];
      html = `<h2>Innings break</h2><p>${esc(teamName(1 - a.battingSlot))} need <b>${a.runs + 1}</b> to win off ${state.settings.overs * 6} balls.</p>${scorecardHtml(a, '1st innings')}<p class="muted small" style="margin-top:10px">Second innings starts in a moment…</p>`;
    } else if (ph === 'finished') {
      const r = state.result;
      const title = r.winnerSlot === null ? 'Tied!' : r.winnerSlot === me.slot ? 'You won! 🏆' : 'You lost';
      const votes = state.rematch || [];
      const oppWants = votes.includes(1 - me.slot), iWant = votes.includes(me.slot);
      html = `<h2>${title}</h2><p>${esc(r.text)}</p>${state.innings.map((i, k) => scorecardHtml(i, k === 0 ? '1st innings' : '2nd innings')).join('')}` +
        (r.abandoned ? '' : `<p class="muted" style="margin-top:8px">${oppWants ? esc(playerName(1 - me.slot)) + ' wants a rematch!' : '&nbsp;'}</p>`) +
        `<div class="actions">` +
        (r.abandoned ? '' : `<button class="btn primary" data-act="rematch" ${iWant ? 'disabled' : ''}>${iWant ? 'Waiting for opponent…' : 'Rematch (same teams)'}</button>`) +
        `<button class="btn" data-act="leave">Back to lobby</button></div>`;
    }
    el.overlay.classList.toggle('hidden', !html);
    if (html !== lastOverlay) { el.overlayCard.innerHTML = html; lastOverlay = html; }
  }

  el.overlayCard.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act, v = b.dataset.v;
    if (act === 'leave') leave();
    else if (act === 'call') send({ t: 'call', side: v });
    else if (act === 'choose') send({ t: 'choose', pick: v });
    else if (act === 'rematch') send({ t: 'rematch' });
    else if (act === 'close') { overlayMode = null; updateOverlay(); }
  });
  el.scorecardBtn.addEventListener('click', () => { overlayMode = overlayMode === 'scorecard' ? null : 'scorecard'; if (state) updateOverlay(); });
  const syncMute = () => { const m = !!(window.CricketSound && window.CricketSound.muted); el.muteBtn.textContent = m ? '🔇' : '🔊'; el.muteBtn.title = m ? 'Sound is off' : 'Sound is on'; };
  el.muteBtn.addEventListener('click', () => { if (window.CricketSound) { window.CricketSound.setMuted(!window.CricketSound.muted); if (!window.CricketSound.muted) S('tick'); } syncMute(); });
  syncMute();

  // ---------------------------------------------------------------- events from the match
  function onEvent(ev) {
    const t = now();
    switch (ev.t) {
      case 'teamReady': if (ev.slot !== me.slot) toast(`${playerName(ev.slot)} locked in ${ev.name}`); break;
      case 'teamsDone': break;
      case 'toss': setCommentary(`It's ${ev.landed}! ${playerName(ev.winner)} won the toss.`); break;
      case 'tossChoice': setCommentary(`${playerName(ev.winner)} chose to ${ev.choice} first.`); break;
      case 'inningsStart':
        R((r) => r.idle()); hideBanner(); sceneKey = ''; syncScene();
        setCommentary(ev.innings === 0 ? `${teamName(ev.battingSlot)} bat first.` : `${teamName(ev.battingSlot)} need ${ev.target} to win.`);
        break;
      case 'overStart': {
        sceneKey = ''; syncScene();
        const b = cricketer(ev.bowler);
        setCommentary(`${b.name} ${ev.auto ? 'is handed' : 'takes'} the ball for over ${ev.over + 1}.${amBowling() ? ' Pick line, length and pace, then press Bowl.' : ''}`);
        break;
      }
      case 'delivery':
        t0 = t + ev.lead;
        shotSeq = null;
        R((r) => r.startDelivery(ev, t0));
        S('release', ev.lead);
        S('bounce', ev.lead + ev.flightMs * (ev.length === 'short' ? 0.45 : ev.length === 'good' ? 0.62 : 0.8));
        hideBanner();
        setCommentary(amBatting() ? 'Watch the ball and play as it reaches the bat!' : `${cricketer(ev.bowlerId).name} runs in…`);
        updateControls();
        break;
      case 'result':
        R((r) => r.startResult(ev, t));
        if (ev.pending) { S(ev.wicketKind === 'lbw' ? 'pad' : 'edge'); S('appeal', 150); setCommentary(ev.commentary, true); }
        else showResult(ev);
        break;
      case 'decision':
        seenDecisionSeq = ev.seq;
        R((r) => r.showDecision(ev.decision, t));
        S(ev.decision === 'out' ? 'wicket' : 'notout');
        setCommentary(`The umpire says ${ev.decision === 'out' ? 'OUT' : 'not out'}!${ev.reviewer === null ? ' No reviews left.' : ev.reviewer === me.slot ? ' Review?' : ` ${playerName(ev.reviewer)} may review.`}`, true);
        updateDrs();
        if (ev.windowMs) startDrsTimer(ev.windowMs);
        break;
      case 'review':
        hideDrs();
        R((r) => r.startReview(ev, t));
        S('review');
        S('verdict', Math.max(500, (ev.durationMs || 9000) - 1500));
        setCommentary(`${playerName(ev.by)} reviews the ${ev.kind === 'lbw' ? 'lbw' : 'catch'}. Over to the third umpire…`, true);
        break;
      case 'newBatter': sceneKey = ''; syncScene(); setCommentary(`${cricketer(ev.batter).name} comes in to bat.`); break;
      case 'nextBall':
        R((r) => r.idle()); hideBanner();
        setCommentary(amBowling() ? 'Your ball: pick line, length and pace, then press Bowl.' : amBatting() ? `${cricketer(currentInnings().bowler).name} is preparing to bowl…` : '');
        break;
      case 'overEnd': R((r) => r.idle()); hideBanner(); setCommentary(`End of over ${ev.over}.${amBowling() ? ' Pick a bowler for the next over.' : ''}`); break;
      case 'inningsEnd': R((r) => r.idle()); break;
      case 'finished':
        if (ev.result && !ev.result.abandoned && ev.result.winnerSlot === me.slot) { R((r) => r.celebrate('win', t)); S('win'); }
        break;
      case 'joined': if (ev.slot !== me.slot) toast(`${ev.name} joined the match`); break;
      case 'disconnected': if (ev.slot !== me.slot) toast(`${playerName(ev.slot)} lost connection, waiting up to a minute…`); break;
      case 'reconnected': if (ev.slot !== me.slot) toast(`${playerName(ev.slot)} is back`); break;
      case 'left': if (ev.slot !== me.slot) toast(`${playerName(ev.slot)} left the match`); break;
      case 'rematchVote': if (ev.slot !== me.slot) toast(`${playerName(ev.slot)} wants a rematch`); break;
      case 'rematch': R((r) => r.idle()); hideBanner(); break;
      default: break;
    }
  }

  function showResult(ev) {
    let text = ev.commentary;
    if (ev.shot && ev.shot.timing) text += ` (timing: ${ev.shot.timing})`;
    if (ev.wicket) text += ` ${cricketer(ev.wicket.batter).name} ${ev.wicket.runs} (${ev.wicket.balls}).`;
    if (ev.overEnd && !ev.inningsEnd) text += ' End of the over.';
    setCommentary(text, true);
    const reviewed = !!ev.review;
    const decided = seenDecisionSeq === ev.seq;
    let banner = '', cls = '';
    if (ev.wide) { banner = 'WIDE'; cls = 'wide'; }
    else if (ev.type === 'wicket') { banner = 'OUT!'; cls = 'out'; }
    else if (ev.runs === 4) { banner = 'FOUR!'; cls = 'four'; }
    else if (ev.runs === 6) { banner = 'SIX!'; cls = 'six'; }
    else if (decided) { banner = 'NOT OUT'; cls = 'notout'; }
    const t = now();
    if (ev.umpire && !decided && !reviewed) R((r) => r.signal(ev.umpire, t));
    if (ev.type === 'wicket') R((r) => r.celebrate('wicket', t));
    else if (ev.runs === 6) R((r) => r.celebrate('six', t));
    else if (ev.runs === 4) R((r) => r.celebrate('four', t));
    if (!decided && !reviewed) {
      if (ev.contact && !ev.wide) S('bat');
      else if (ev.wicketKind === 'bowled') S('stumps');
      if (ev.wicketKind === 'caught') S('catch', 450);
      if (ev.type === 'wicket') S('wicket', 300);
      else if (ev.runs === 6) S('six', 400);
      else if (ev.runs === 4) S('four', 500);
    } else if (ev.type === 'wicket') S('wicket');
    if (banner) {
      clearTimeout(bannerTimer);
      const delay = decided || reviewed ? 100 : ev.type === 'wicket' ? 350 : ev.wide ? 200 : 650;
      bannerTimer = setTimeout(() => {
        el.banner.textContent = banner;
        el.banner.className = `banner ${cls}`;
        bannerTimer = setTimeout(hideBanner, 1900);
      }, delay);
    }
  }

  function hideBanner() { clearTimeout(bannerTimer); el.banner.className = 'banner hidden'; }
  function setCommentary(text, flash) {
    el.commentary.textContent = text || ' ';
    el.commentary.classList.remove('flash');
    if (flash) { void el.commentary.offsetWidth; el.commentary.classList.add('flash'); }
  }
  function toast(text, isError) {
    clearTimeout(toastTimer);
    el.toast.textContent = text;
    el.toast.className = `toast${isError ? ' err' : ''}`;
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2800);
  }

  // ---------------------------------------------------------------- batting and bowling input
  function setOpt(opt, v) {
    choice[opt] = v;
    for (const group of document.querySelectorAll(`.opt-group[data-opt="${opt}"]`)) {
      for (const b of group.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === v);
    }
  }
  for (const group of document.querySelectorAll('.opt-group')) {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b && !b.disabled) setOpt(group.dataset.opt, b.dataset.v);
    });
  }

  function sideToDir(side) {
    if (side === 'center') return 'straight';
    const lefty = cricketer(currentInnings().striker).hand === 'L';
    if (side === 'left') return lefty ? 'off' : 'leg';
    return lefty ? 'leg' : 'off';
  }

  function playShot(dir) {
    const d = state && state.delivery;
    if (!amBatting() || !d || d.state !== 'inFlight' || shotSeq === d.seq) return;
    shotSeq = d.seq;
    const at = Math.round(now() - t0);
    send({ t: 'shot', dir, kind: choice.kind, at });
    R((r) => r.swing(dir, now()));
    S('release');
    updateControls();
  }

  function markerPos(t) { const ph = ((t - meter.start) % 1200) / 1200; return ph < 0.5 ? -1 + 4 * ph : 3 - 4 * ph; }
  function animateMeter() {
    if (!meter.running) return;
    el.marker.style.left = `${50 + markerPos(now()) * 50}%`;
    requestAnimationFrame(animateMeter);
  }
  function startMeter() {
    meter.running = true;
    meter.start = now();
    el.bowl.textContent = 'Release!';
    clearTimeout(meter.timeout);
    meter.timeout = setTimeout(release, 2600);
    animateMeter();
  }
  function stopMeter() { meter.running = false; clearTimeout(meter.timeout); el.marker.style.left = '50%'; }
  function release() {
    if (!meter.running) return;
    const timing = Math.round(markerPos(now()) * 600);
    stopMeter();
    send({ t: 'bowl', line: choice.line, length: choice.length, pace: choice.pace, timing });
    el.bowl.textContent = 'Bowling…';
    el.bowl.disabled = true;
  }
  function bowlPress() {
    const d = state && state.delivery;
    if (!amBowling() || !d || d.state !== 'awaitingBowl') return;
    if (meter.running) release(); else startMeter();
  }

  const press = (node, fn) => {
    node.addEventListener('pointerdown', (e) => { if (e.button === 0 && !node.disabled) { e.preventDefault(); fn(); } });
    node.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !node.disabled) { e.preventDefault(); fn(); } });
  };
  for (const b of el.ctlBat.querySelectorAll('.shot')) press(b, () => playShot(sideToDir(b.dataset.side)));
  press(el.bowl, bowlPress);

  document.addEventListener('keydown', (e) => {
    if (el.game.classList.contains('hidden')) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const d = state && state.delivery;
    if (d && d.state === 'decision' && d.reviewer === me.slot) {
      if (k === 'r') { send({ t: 'review' }); e.preventDefault(); }
      else if (k === 'Enter') { send({ t: 'accept' }); e.preventDefault(); }
      return;
    }
    if (!el.overlay.classList.contains('hidden')) return;
    if (amBowling()) {
      const map = { ArrowLeft: ['line', 'leg'], ArrowUp: ['line', 'middle'], ArrowRight: ['line', 'off'], a: ['length', 'short'], s: ['length', 'good'], d: ['length', 'full'] };
      if (map[k]) { setOpt(map[k][0], map[k][1]); e.preventDefault(); }
      else if (k === 'f') { const btns = [...el.paceGroup.querySelectorAll('button')]; const i = btns.findIndex((b) => b.dataset.v === choice.pace); setOpt('pace', btns[(i + 1) % btns.length].dataset.v); }
      else if (k === ' ' || k === 'Enter') { bowlPress(); e.preventDefault(); }
    } else if (amBatting()) {
      if (k === '1') setOpt('kind', 'defend');
      else if (k === '2') setOpt('kind', 'attack');
      else if (k === '3') setOpt('kind', 'loft');
      else if (k === 'ArrowLeft') { playShot(sideToDir('left')); e.preventDefault(); }
      else if (k === 'ArrowUp' || k === ' ') { playShot('straight'); e.preventDefault(); }
      else if (k === 'ArrowRight') { playShot(sideToDir('right')); e.preventDefault(); }
    }
  });

  // ---------------------------------------------------------------- lobby wiring and start-up
  el.create.addEventListener('click', create);
  el.join.addEventListener('click', () => join(el.code.value));
  el.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(el.code.value); });
  el.code.addEventListener('input', () => { el.code.value = el.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });
  el.name.addEventListener('change', saveName);
  el.leave.addEventListener('click', leave);
  try { el.name.value = localStorage.getItem('cricket-name') || ''; } catch { /* storage blocked */ }
  const params = new URLSearchParams(location.search);
  if (params.get('join')) el.code.value = params.get('join').toUpperCase().slice(0, 4);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) connect(); });
  window.addEventListener('online', connect);
  window.addEventListener('resize', () => { el.app.classList.toggle('wide', !el.game.classList.contains('hidden') && window.innerWidth >= 900); R((r) => r.resize()); if (!el.teams.classList.contains('hidden')) switchPane(document.querySelector('.teams-tabs .tab.on')?.dataset.tab || 'pool'); });

  (function loop() {
    if (renderer && !el.game.classList.contains('hidden')) { try { renderer.draw(now()); } catch (e) { console.error(e); } }
    requestAnimationFrame(loop);
  })();

  // Read-only hooks for automated checks (test/browser-check.js) and debugging from the console.
  window.__myCricket = { state: () => state, t0: () => t0, slot: () => me.slot, choice, team, renderer: () => renderer };

  initRenderer();
  loadUrls();
  connect();
})();
