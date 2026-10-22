// Synthesised match sounds for MY CRICKET (no audio files): bat on ball, stumps, crowd, appeals, DRS beeps.
// Everything is generated with the Web Audio API, which only starts after the first tap or click.
(function () {
  'use strict';
  let ctx = null, master = null, crowdNode = null, crowdGain = null;
  let muted = false;
  try { muted = localStorage.getItem('cricket-muted') === '1'; } catch { /* storage blocked */ }

  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      master.connect(ctx.destination);
      // a continuous, very quiet crowd bed: filtered noise
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
      crowdNode = ctx.createBufferSource();
      crowdNode.buffer = buffer;
      crowdNode.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      crowdGain = ctx.createGain();
      crowdGain.gain.value = 0.035;
      crowdNode.connect(lp).connect(crowdGain).connect(master);
      crowdNode.start();
      return true;
    } catch { ctx = null; return false; }
  }

  function noise(duration, { freq = 1500, q = 1, gain = 0.5, type = 'bandpass', attack = 0.002, decay = duration } = {}) {
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
    const d = buffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + attack + decay + 0.05);
  }

  function tone(freq, duration, { gain = 0.2, type = 'sine', slide = 0 } = {}) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + duration);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + duration + 0.05);
  }

  function crowd(level, seconds) {
    if (!crowdGain) return;
    const t = ctx.currentTime;
    crowdGain.gain.cancelScheduledValues(t);
    crowdGain.gain.setValueAtTime(crowdGain.gain.value, t);
    crowdGain.gain.linearRampToValueAtTime(level, t + 0.15);
    crowdGain.gain.linearRampToValueAtTime(0.035, t + seconds);
  }

  const SOUNDS = {
    bat() { noise(0.09, { freq: 1800, q: 0.7, gain: 0.7, attack: 0.001, decay: 0.08 }); tone(220, 0.05, { gain: 0.12, type: 'triangle', slide: -120 }); },
    edge() { noise(0.05, { freq: 3200, q: 2, gain: 0.3, attack: 0.001, decay: 0.04 }); },
    pad() { noise(0.08, { freq: 300, q: 0.8, gain: 0.4, type: 'lowpass', attack: 0.002, decay: 0.07 }); },
    stumps() { noise(0.12, { freq: 900, q: 1.2, gain: 0.6, attack: 0.001, decay: 0.1 }); tone(160, 0.12, { gain: 0.15, type: 'square', slide: -80 }); setTimeout(() => tone(1200, 0.08, { gain: 0.05, type: 'triangle' }), 60); },
    catch() { noise(0.07, { freq: 600, q: 1, gain: 0.35, type: 'lowpass', attack: 0.002, decay: 0.06 }); },
    bounce() { noise(0.03, { freq: 700, q: 1, gain: 0.12, attack: 0.001, decay: 0.025 }); },
    four() { crowd(0.3, 2.2); },
    six() { crowd(0.45, 3); setTimeout(() => tone(880, 0.12, { gain: 0.05 }), 300); },
    wicket() { crowd(0.5, 3.2); },
    appeal() { crowd(0.22, 1.6); },
    notout() { crowd(0.12, 1.2); tone(330, 0.15, { gain: 0.06, type: 'triangle', slide: -60 }); },
    review() { tone(660, 0.09, { gain: 0.08 }); setTimeout(() => tone(880, 0.09, { gain: 0.08 }), 120); crowd(0.18, 2); },
    verdict() { tone(523, 0.08, { gain: 0.08 }); setTimeout(() => tone(784, 0.14, { gain: 0.08 }), 100); },
    win() { crowd(0.5, 5); [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.25, { gain: 0.08 }), i * 140)); },
    tick() { tone(1000, 0.03, { gain: 0.04 }); },
    release() { noise(0.06, { freq: 400, q: 0.5, gain: 0.15, type: 'lowpass', attack: 0.002, decay: 0.05 }); },
  };

  const api = {
    get muted() { return muted; },
    unlock() { return ensure(); },
    play(name) { if (!ensure() || muted) return; const f = SOUNDS[name]; if (f) { try { f(); } catch { /* ignore */ } } },
    setMuted(v) {
      muted = !!v;
      try { localStorage.setItem('cricket-muted', muted ? '1' : '0'); } catch { /* storage blocked */ }
      if (master) master.gain.value = muted ? 0 : 0.8;
    },
  };
  const unlockOnce = () => { ensure(); };
  window.addEventListener('pointerdown', unlockOnce, { passive: true });
  window.addEventListener('keydown', unlockOnce);
  window.CricketSound = api;
})();
