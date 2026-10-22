'use strict';
// Drives the real client in headless Chrome through a whole match using the DevTools protocol only
// (no npm packages): two tabs are two players. Saves screenshots and reports page errors.
//
//   node test/browser-check.js [outputDir]
//
// Needs Chrome or Edge installed. Exit code 1 if the match does not finish or a page throws.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { start } = require('../server.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'screenshots'));
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const DEBUG_PORT = 9333 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.data || ''})`)); else resolve(msg.result);
      } else if (msg.method) for (const h of this.handlers) h(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  on(fn) { this.handlers.push(fn); }
}

class Page {
  constructor(cdp, sessionId, name) {
    this.cdp = cdp; this.sessionId = sessionId; this.name = name; this.errors = [];
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') this.errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    });
  }
  send(method, params) { return this.cdp.send(method, params, this.sessionId); }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expression, ms = 15000, label = expression) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await this.eval(expression)) return true; await sleep(60); }
    throw new Error(`${this.name}: timed out waiting for ${label}`);
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
    console.log(`  screenshot ${file}`);
  }
  // A 3D frame can hold the page's main thread for a while in software-rendered headless Chrome, so a
  // button may appear a moment after the state that enables it: retry for a few seconds before giving up.
  async click(selector, ms = 6000) {
    const until = Date.now() + ms;
    for (;;) {
      const r = await this.eval(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b || b.disabled) return 'missing'; b.click(); return 'ok'; })()`);
      if (r === 'ok' || Date.now() > until) return r;
      await sleep(80);
    }
  }
  async press(selector, ms = 6000) {
    const until = Date.now() + ms;
    for (;;) {
      const r = await this.eval(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b || b.disabled) return 'missing'; b.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })); return 'ok'; })()`);
      if (r === 'ok' || Date.now() > until) return r;
      await sleep(80);
    }
  }
  state() { return this.eval('JSON.parse(JSON.stringify(window.__myCricket.state()))'); }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('No Chrome or Edge found.');
  const srv = await start({ port: 0, timeScale: 0.6, quiet: true });
  const base = `http://127.0.0.1:${srv.port}/`;
  console.log(`server on ${base} (pool ${srv.poolSize}), browser ${exe}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mycricket-chrome-'));
  const chrome = spawn(exe, [
    '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, '--window-size=1200,900', 'about:blank',
  ], { stdio: 'ignore' });
  const failures = [];
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) { try { version = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`); } catch { await sleep(250); } }
    if (!version) throw new Error('Chrome did not open its debugging port.');
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new CDP(ws);

    async function openPage(name, mobile) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const page = new Page(cdp, sessionId, name);
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      // confirm() dialogs (leaving a live match) would block the page: accept them
      cdp.on((msg) => { if (msg.sessionId === sessionId && msg.method === 'Page.javascriptDialogOpening') page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
      if (mobile) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      else await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 860, deviceScaleFactor: 1, mobile: false });
      await page.send('Page.navigate', { url: base });
      await page.waitFor(`document.readyState === 'complete' && typeof window.__myCricket === 'object'`, 15000, 'page load');
      await page.waitFor(`document.getElementById('conn').textContent === 'Connected'`, 10000, 'websocket connection');
      return page;
    }

    const A = await openPage('Asha (desktop)', false);
    const B = await openPage('Bilal (phone)', true);
    await sleep(2500);   // let the 3D module load
    const hasRenderer = await A.eval('!!window.__myCricket.renderer()');
    console.log(`renderer loaded on desktop: ${hasRenderer}`);
    await A.eval(`document.getElementById('name').value = 'Asha'; document.getElementById('name').dispatchEvent(new Event('change'))`);
    await B.eval(`document.getElementById('name').value = 'Bilal'; document.getElementById('name').dispatchEvent(new Event('change'))`);
    await A.shot('01-lobby-desktop.png');
    await B.shot('02-lobby-phone.png');

    await A.eval(`document.getElementById('overs').value = '1'; document.getElementById('wickets').value = '2'; document.getElementById('reviews').value = '1'`);
    await A.click('#create');
    await A.waitFor(`window.__myCricket.state() && window.__myCricket.state().phase === 'waiting'`, 5000, 'match created');
    await A.shot('03-waiting-for-opponent.png');
    await B.waitFor(`document.querySelectorAll('.match-row').length === 1`, 5000, 'open match listed on the phone');
    await B.click('.match-row .btn');
    await A.waitFor(`window.__myCricket.state().phase === 'teams'`, 5000, 'team building on A');
    await B.waitFor(`window.__myCricket.state() && window.__myCricket.state().phase === 'teams'`, 5000, 'team building on B');
    await sleep(300);
    // A builds by hand through the UI: add the first players shown until 11, then lock; B auto-picks.
    await A.shot('04-team-builder-desktop.png');
    await B.shot('05-team-builder-phone.png');
    await B.click('#team-auto');
    for (let i = 0; i < 11; i++) {
      await A.eval(`(() => { const rows = [...document.querySelectorAll('#pool-list .prow:not(.picked) .btn')]; const b = rows[0]; if (b) b.click(); })()`);
    }
    await A.eval(`document.getElementById('team-name').value = 'Asha Avengers'`);
    await A.shot('06-team-builder-filled.png');
    await A.click('#team-lock');
    await A.waitFor(`window.__myCricket.state().phase === 'toss'`, 8000, 'toss after locking (budget/bowlers may reject the naive XI)').catch(async () => {
      console.log('  hand-picked XI rejected (expected if over budget), falling back to auto-pick');
      await A.click('#team-auto');
      await A.waitFor(`window.__myCricket.state().phase === 'toss'`, 8000, 'toss after auto-pick');
    });
    await B.waitFor(`window.__myCricket.state().phase === 'toss'`, 5000, 'toss on B');
    await sleep(300);
    await B.shot('07-toss-call-phone.png');
    if ((await B.click('button[data-act="call"][data-v="heads"]')) !== 'ok') throw new Error('B could not call the toss');
    await A.waitFor(`window.__myCricket.state().toss.winner !== null`, 5000, 'toss result');
    await sleep(150);
    const winnerPage = (await A.state()).toss.winner === 0 ? A : B;
    await winnerPage.shot('08-toss-won.png');
    if ((await winnerPage.click('button[data-act="choose"][data-v="bat"]')) !== 'ok') throw new Error('toss winner could not choose');
    await A.waitFor(`window.__myCricket.state().phase === 'innings'`, 5000, 'first innings');
    await B.waitFor(`window.__myCricket.state().phase === 'innings'`, 5000, 'first innings');

    const dirs = ['straight', 'leg', 'off'];
    const kinds = ['attack', 'loft', 'defend'];
    const lines = ['middle', 'leg', 'off'], lengths = ['good', 'full', 'short'];
    const taken = new Set();
    let ball = 0, reviewsUsed = 0;
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const st = await A.state();
      if (st.phase === 'finished') break;
      if (st.phase === 'break') { if (!taken.has('break')) { taken.add('break'); await sleep(400); await A.shot('16-innings-break-scorecard.png'); } await sleep(300); continue; }
      if (st.phase !== 'innings' || !st.delivery) { await sleep(150); continue; }
      const inn = st.innings[st.inningsIndex];
      const bowler = inn.bowlingSlot === 0 ? A : B;
      const batter = inn.battingSlot === 0 ? A : B;
      const d = st.delivery;
      if (d.state === 'awaitingBowler') {
        if (!taken.has('bowlerpick')) { taken.add('bowlerpick'); await sleep(200); await bowler.shot('09-pick-bowler.png'); }
        await bowler.click('.bowler-btn');
        await sleep(150);
        continue;
      }
      if (d.state === 'awaitingBowl') {
        await bowler.eval(`document.querySelector('.opt-group[data-opt="line"] button[data-v="${lines[ball % 3]}"]').click();
          document.querySelector('.opt-group[data-opt="length"] button[data-v="${lengths[Math.floor(ball / 3) % 3]}"]').click();`);
        if ((await bowler.press('#bowl')) !== 'ok') { await sleep(100); continue; }
        if (!taken.has('meter')) { taken.add('meter'); await sleep(140); await bowler.shot('10-bowling-meter.png'); await sleep(160); }
        else await sleep(300);
        await bowler.press('#bowl');
        ball += 1;
        // Chrome throttles timers and requestAnimationFrame in a hidden tab, so the swing is timed from here:
        // poll the page for the flight, then sleep in Node until just before the ball reaches the bat.
        const side = dirs[ball % 3] === 'straight' ? 'center' : dirs[ball % 3] === 'leg' ? 'left' : 'right';
        let swung = 'no-flight';
        const swingDeadline = Date.now() + 9000;
        while (Date.now() < swingDeadline) {
          const info = await batter.eval(`(() => { const h = window.__myCricket; const s = h.state(); const d = s && s.delivery; return { st: d ? d.state : null, left: d && d.state === 'inFlight' ? h.t0() + d.flightMs - performance.now() : null }; })()`);
          if (info.st === 'inFlight' && info.left !== null) {
            if (info.left > 30) { await sleep(Math.min(info.left - 20, 250)); continue; }
            swung = await batter.eval(`(() => {
              document.querySelector('.opt-group[data-opt="kind"] button[data-v="${kinds[ball % 3]}"]').click();
              const b = document.querySelector('.shot[data-side="${side}"]');
              if (!b || b.disabled) return 'disabled';
              b.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
              const h = window.__myCricket; const d = h.state().delivery;
              return Math.round(performance.now() - h.t0()) + '/' + d.flightMs;
            })()`);
            break;
          }
          if (info.st && info.st !== 'awaitingBowl' && info.st !== 'inFlight') { swung = 'no-flight:' + info.st; break; }
          await sleep(25);
        }
        if (ball === 1) { await sleep(10); }
        // mid-flight screenshots on the second ball: wait until the ball is ~60% of the way
        if (ball === 2 && !taken.has('flight')) { taken.add('flight'); }
        await sleep(350);
        const after = await A.state();
        const lr = after.lastResult;
        const dd = after.delivery;
        console.log(`  ball ${ball}: swing ${swung} -> ${dd && dd.state === 'decision' ? 'DECISION ' + dd.decision : lr ? lr.commentary : '(pending)'}`);
        if (lr && !taken.has('result')) { taken.add('result'); await batter.shot('12-shot-result.png'); await bowler.shot('13-shot-result-other-view.png'); }
        if (lr && lr.type === 'wicket' && !taken.has('wicket')) { taken.add('wicket'); await sleep(400); await batter.shot('14-wicket.png'); }
        if (lr && lr.runs >= 4 && !taken.has('boundary')) { taken.add('boundary'); await sleep(500); await batter.shot('15-boundary.png'); }
        continue;
      }
      if (d.state === 'decision') {
        const reviewer = d.reviewer === 0 ? A : d.reviewer === 1 ? B : null;
        if (!taken.has('decision')) { taken.add('decision'); await sleep(500); await (reviewer || A).shot('17-umpire-decision.png'); await (reviewer === A ? B : A).shot('18-umpire-decision-other.png'); }
        if (reviewer) {
          if (reviewsUsed === 0) { reviewsUsed += 1; await reviewer.click('#drs-review'); await sleep(2200); await reviewer.shot('19-drs-review-in-progress.png'); await sleep(1500); await reviewer.shot('20-drs-review-verdict.png'); }
          else await reviewer.click('#drs-accept');
        }
        await sleep(200);
        continue;
      }
      if (d.state === 'inFlight' && !taken.has('flightshot')) {
        taken.add('flightshot');
        await batter.shot('11-ball-in-flight-batter.png');
        await bowler.shot('11b-ball-in-flight-bowler.png');
        continue;
      }
      await sleep(120);
    }
    const final = await A.state();
    if (final.phase !== 'finished') failures.push(`match did not finish (phase ${final.phase}, delivery ${final.delivery && final.delivery.state})`);
    else console.log(`result: ${final.result.text}`);
    await sleep(500);
    await A.shot('21-result-desktop.png');
    await B.shot('22-result-phone.png');
    await A.click('button[data-act="leave"]');
    await A.waitFor(`document.getElementById('screen-lobby').offsetParent !== null`, 5000, 'back to lobby');
    for (const p of [A, B]) for (const e of p.errors) failures.push(`${p.name}: ${e}`);
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    await srv.close();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (failures.length) {
    console.error('FAILURES:');
    for (const f of failures) console.error(' - ' + f);
    process.exit(1);
  }
  console.log('browser check passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
