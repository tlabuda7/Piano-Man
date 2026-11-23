(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = m => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
  const COL = { paper: '#efe3c8', leaf: '#f6edd8', ink: '#2a1f14', dim: '#6b5a43', rule: '#b7a37e', R: '#b07a1c', L: '#2f5574', ok: '#3f7a4a', bad: '#c7361f', white: '#fbf5e4', black: '#231a11' };
  const SERIF = 'Baskerville, "Hoefler Text", Palatino, Georgia, serif';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  let clock = () => performance.now();

  // ---------- Song library ----------
  let imported = store.get('pm.songs', []);
  let stats = store.get('pm.stats', {});
  const opts = Object.assign({ names: true, octave: true, fingers: true, lyrics: false }, store.get('pm.opts', {}));
  const builtins = window.BUILTIN_SONGS.map(b => ({ id: b.id, song: Parsers.parseAbc(b.abc), builtin: true }));
  const library = () => builtins.concat(imported);

  // ---------- State ----------
  const S = {
    id: null, song: null, steps: [], idx: 0, mode: 'learn', playing: false, view: 0, li: 0,
    hands: 'B', tempo: 1, loopA: null, loopB: null, hit: new Set(), misses: [], finished: false,
    flashes: new Map(), keys: [], lo: 48, hi: 71, hitY: 0, W: 0, H: 0, muteMicUntil: 0, hold: null, inset: 0, ppb: 64, loopBars: null
  };

  function barOf(t) {
    const s = S.song;
    if (s.pickup && t < s.pickup - 1e-6) return 0;
    return Math.floor((t - s.pickup + 1e-6) / s.barLen) + 1;
  }
  const barLabel = b => (b === 0 ? 'the pickup' : 'bar ' + b);

  function buildSteps() {
    let ns = S.song.notes.filter(n => S.hands === 'B' || n.h === S.hands);
    if (!ns.length) ns = S.song.notes;
    const steps = [];
    for (const n of ns) {
      const last = steps[steps.length - 1];
      if (last && Math.abs(n.t - last.t) < 0.06) { if (!last.notes.some(x => x.m === n.m)) last.notes.push(n); }
      else steps.push({ t: n.t, notes: [n] });
    }
    S.steps = steps;
    // Lyrics: every sung syllable in order, and for each step the syllable being sung at that moment.
    S.syl = S.song.notes.filter(n => n.ly).map(n => ({ t: n.t, text: n.ly, line: n.ll }));
    let k = -1;
    for (const st of steps) { while (k + 1 < S.syl.length && S.syl[k + 1].t <= st.t + 0.01) k++; st.syl = k; }
  }

  function selectSong(id) {
    const entry = library().find(e => e.id === id) || builtins[0];
    S.id = entry.id; S.song = entry.song;
    store.set('pm.last', S.id);
    const hasL = S.song.notes.some(n => n.h === 'L');
    $('hands').hidden = !hasL;
    if (!hasL) S.hands = 'B';
    if (!S.song.notes.some(n => n.f)) window.assignFingering(S.song);
    S.loopA = S.loopB = null; S.loopBars = null;
    buildSteps(); setRange(); restart();
  }

  // The keyboard shows only the octaves the chosen hand(s) need, so keys stay as large as possible.
  function setRange() {
    const ms = [].concat(...S.steps.map(s => s.notes.map(n => n.m)));
    // One spare white key beyond the lowest and highest notes, and never fewer than two octaves.
    S.lo = Math.min(...ms) - 1; if (isBlack(S.lo)) S.lo--;
    S.hi = Math.max(...ms) + 1; if (isBlack(S.hi)) S.hi++;
    for (let up = true; S.hi - S.lo < 23; up = !up) {
      if (up) { S.hi++; if (isBlack(S.hi)) S.hi++; } else { S.lo--; if (isBlack(S.lo)) S.lo--; }
    }
    layoutKeys();
  }

  function restart() {
    S.idx = S.loopA != null ? S.loopA : 0;
    S.hit.clear(); S.misses = []; S.finished = false; S.playing = false; endHold();
    S.view = S.steps[S.idx].t - (S.mode === 'listen' ? 1 : 0);
    seekListen();
    prompt(); updateUI();
  }

  function seekListen() {
    S.li = S.song.notes.findIndex(n => n.t > S.view);
    if (S.li < 0) S.li = S.song.notes.length;
  }

  // ---------- Coach banner ----------
  let coachTimer = 0;
  function coach(kind, big, msg, actions) {
    const c = $('coach');
    $('coachBig').textContent = big;
    $('coachBig').classList.toggle('long', big.length > 4);
    $('coachMsg').innerHTML = msg;
    const a = $('coachActions'); a.textContent = '';
    (actions || []).forEach(([label, fn, primary]) => {
      const b = document.createElement('button');
      b.textContent = label; if (primary) b.className = 'primary';
      b.onclick = fn; a.appendChild(b);
    });
    clearTimeout(coachTimer);
  }

  function stepNames(step) { return step.notes.map(n => noteName(n.m)).join(' + '); }

  function fingerText(step) {
    if (!opts.fingers) return 'Play the lit key.';
    const twoHands = S.song.notes.some(n => n.h === 'L');
    const parts = ['R', 'L'].map(h => {
      const fs = step.notes.filter(n => n.h === h && n.f).map(n => n.f);
      if (!fs.length) return '';
      return (twoHands ? (h === 'R' ? 'Right ' : 'Left ') : (fs.length > 1 ? 'Fingers ' : 'Finger ')) + fs.join('+');
    }).filter(Boolean);
    return parts.length ? '<b>' + parts.join(' · ') + '</b>' : 'Play the lit key.';
  }

  function prompt(kind) {
    if (S.mode === 'listen') {
      coach('', '', S.playing ? 'Watch which keys light up.' : 'Hear the song and watch the keys.');
      return;
    }
    const step = S.steps[S.idx];
    const where = barLabel(barOf(step.t)).replace(/^./, ch => ch.toUpperCase()) + ` \u00b7 ${S.idx + 1} of ${S.steps.length}`;
    coach('', stepNames(step), fingerText(step) + `<span class="sub">${where}</span>`);
  }

  // ---------- Learn mode ----------
  function findMatch(m, src) {
    const want = S.steps[S.idx].notes.filter(n => !S.hit.has(n.m));
    const lenient = src === 'mic' && opts.octave;
    return want.find(n => n.m === m) || (lenient && want.find(n => (n.m - m) % 12 === 0)) || null;
  }

  function noteInput(m, src) {
    if (S.mode !== 'learn' || S.finished) return;
    if (tooEarly()) {
      const h = S.hold;
      coach('', h.names, `<b>Keep holding.</b><span class="sub">This note lasts ${beatText(h.beats)}.</span>`);
      clearTimeout(coachTimer);
      return;
    }
    const step = S.steps[S.idx];
    const want = step.notes.filter(n => !S.hit.has(n.m));
    const match = findMatch(m, src);
    if (match) {
      S.hit.add(match.m);
      flash(match.m, 'ok');
      if (S.hit.size >= step.notes.length) advance();
      return;
    }
    if (step.notes.some(n => n.m === m)) return; // already-held chord note
    S.misses[S.idx] = (S.misses[S.idx] || 0) + 1;
    flash(m, 'bad');
    const hint = S.misses[S.idx] % 3 === 0;
    coach('', stepNames(step), `<b>Try again.</b> That was ${noteName(m)}.<span class="sub">${hint ? 'Listen, this is how it sounds.' : fingerText(step).replace(/<[^>]+>/g, '')}</span>`);
    if (hint) setTimeout(() => want.forEach(n => tone(n.m, 0.9)), src === 'tap' ? 500 : 150);
  }

  // After a right note the lane scrolls to the next note in time with the music.
  // A note longer than one beat has to be held: the next note is not accepted until its time is nearly up.
  const beatText = b => (Math.abs(b - Math.round(b)) < 0.01 ? Math.round(b) : +b.toFixed(1)) + (Math.abs(b - 1) < 0.01 ? ' beat' : ' beats');
  function endHold() { S.hold = null; $('holdBar').firstElementChild.style.width = '0'; }
  function tooEarly() {
    const h = S.hold;
    return !!(h && h.gate && h.dur - (clock() - h.start) > h.early);
  }
  function tickHold(now) {
    const h = S.hold;
    if (!h) return false;
    const k = (now - h.start) / h.dur;
    if (k >= 1) { S.view = h.toV; endHold(); prompt(); return true; }
    S.view = h.fromV + (h.toV - h.fromV) * k;
    if (h.gate) $('holdBar').firstElementChild.style.width = Math.round(k * 100) + '%';
    return true;
  }
  function released() {
    const h = S.hold;
    if (!h || !h.gate || h.tipped || clock() - h.start > h.dur * 0.6) return;
    h.tipped = true;
    coach('', h.names, `<b>Let go too soon.</b><span class="sub">Hold it for the full ${beatText(h.beats)}.</span>`);
  }

  function advance() {
    const prev = S.steps[S.idx];
    S.hit.clear();
    S.idx++;
    if (S.loopB != null && S.idx > S.loopB) S.idx = S.loopA || 0;
    else if (S.idx >= S.steps.length) { endHold(); return finish(); }
    const beats = S.steps[S.idx].t - prev.t;
    endHold();
    if (beats > 0) {
      const beatMs = 60000 / (S.song.bpm * S.tempo), dur = beats * beatMs;
      S.hold = { start: clock(), dur, fromV: S.view, toV: S.steps[S.idx].t, beats, gate: beats > 1.01, early: Math.max(150, beatMs * 0.3), names: stepNames(prev), tipped: false };
      if (S.hold.gate) {
        prev.notes.forEach(n => flash(n.m, 'ok', dur - S.hold.early));
        coach('', S.hold.names, `<b>Hold it</b> for ${beatText(beats)}.`);
        clearTimeout(coachTimer); updateUI();
        return;
      }
    }
    prompt('ok'); updateUI();
  }

  function finish() {
    S.finished = true; S.idx = S.steps.length - 1;
    const total = S.steps.length;
    const clean = S.steps.filter((s, i) => !S.misses[i]).length;
    const pct = Math.round(100 * clean / total);
    const byBar = {};
    S.steps.forEach((s, i) => { if (S.misses[i]) { const b = barOf(s.t); byBar[b] = (byBar[b] || 0) + S.misses[i]; } });
    const worst = Object.keys(byBar).sort((a, b) => byBar[b] - byBar[a])[0];
    const st = stats[S.id] || {};
    st.best = Math.max(st.best || 0, pct); st.plays = (st.plays || 0) + 1;
    stats[S.id] = st; store.set('pm.stats', stats);
    const actions = [['Play again', restart, worst === undefined]];
    if (worst !== undefined) actions.unshift(['Practice ' + barLabel(+worst), () => loopBar(+worst), true]);
    coach('', pct + '%', `<b>Finished.</b> ${clean} of ${total} right first time.<span class="sub">` + (worst !== undefined ? `Hardest spot: ${barLabel(+worst)}.` : 'No mistakes.') + '</span>', actions);
    clearTimeout(coachTimer);
    updateUI();
  }

  // Repeat bars b1..b2 (inclusive).
  function loopBar(b1, b2) {
    if (b2 == null) b2 = b1;
    const idxs = S.steps.map((s, i) => (barOf(s.t) >= b1 && barOf(s.t) <= b2 ? i : -1)).filter(i => i >= 0);
    if (!idxs.length) return;
    S.loopA = idxs[0]; S.loopB = idxs[idxs.length - 1]; S.loopBars = [b1, b2];
    restart();
  }
  function stopLoop() { S.loopA = S.loopB = null; S.loopBars = null; updateUI(); }
  // Tapping a bar number: start repeating that bar, stretch the section to it, or (inside the section) stop.
  function tapBar(bar) {
    const L = S.loopBars;
    if (!L) loopBar(bar);
    else if (bar >= L[0] && bar <= L[1]) stopLoop();
    else loopBar(Math.min(bar, L[0]), Math.max(bar, L[1]));
  }

  // ---------- Sound ----------
  let ac = null, out = null;
  function audio() {
    if (!ac) {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      // Everything goes through a limiter, so notes can be loud without crackling when several play at once.
      const limiter = ac.createDynamicsCompressor();
      limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.15;
      out = ac.createGain(); out.gain.value = 2.4;
      out.connect(limiter); limiter.connect(ac.destination);
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(m, dur) {
    const a = audio(), t = a.currentTime, f = 440 * Math.pow(2, (m - 69) / 12);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.35);
    g.connect(out);
    // Phone speakers cannot play deep bass, so low notes lean on their higher harmonics to stay audible.
    const low = f < 220;
    [[1, 'triangle', 1], [2, 'sine', low ? 0.8 : 0.4], [3, 'sine', low ? 0.6 : 0.2], [4, 'sine', low ? 0.4 : 0.1]].forEach(([mult, type, vol]) => {
      const o = a.createOscillator(), og = a.createGain();
      o.type = type; o.frequency.value = f * mult; og.gain.value = vol;
      o.connect(og); og.connect(g); o.start(t); o.stop(t + dur + 0.4);
    });
    S.muteMicUntil = Math.max(S.muteMicUntil, clock() + (dur + 0.45) * 1000);
  }
  function flash(m, kind, ms) { S.flashes.set(m, { kind, until: clock() + (ms || 320) }); }

  // ---------- Microphone listening ----------
  // Right notes: the app knows which note it is waiting for, so it looks for that note's own
  // frequencies appearing in the sound. This works at low volume and while other notes still ring.
  // Wrong notes: a separate pitch tracker (YIN) has to hear one clear, steady, different note.
  const FFT_N = 16384;
  const mic = { on: false, an: null, stream: null, time: null, frames: [], hitAt: -1e9, prevHitAt: -1e9, lastC: null, lastNotes: [], attackAt: -1e9, floor: 0.01, quiet: 0,
    cand: null, candN: 0, lastWrong: null, wrongAt: -1e9, nextAt: 0, tune: 0, hits: 0, log: [], pendChord: {}, partialAt: 0, stale: [], d: new Float32Array(2049), sr: 48000 };

  const spectrum = (() => {
    const N = FFT_N, re = new Float32Array(N), im = new Float32Array(N), win = new Float32Array(N), rev = new Uint16Array(N);
    const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) {
      win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
      let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
    return function (time, sr) {
      for (let i = 0; i < N; i++) { re[rev[i]] = time[i] * win[i]; im[rev[i]] = 0; }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, stride = N / size;
        for (let start = 0; start < N; start += size) {
          for (let k = 0, t = 0; k < half; k++, t += stride) {
            const a = start + k, b = a + half;
            const xr = re[b] * cos[t] - im[b] * sin[t], xi = re[b] * sin[t] + im[b] * cos[t];
            re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          }
        }
      }
      const K = Math.min(N / 2, Math.ceil(8000 * N / sr)), mag = new Float32Array(K);
      let max = 0;
      for (let k = 1; k < K; k++) { const v = Math.hypot(re[k], im[k]); mag[k] = v; if (v > max) max = v; }
      return { mag, max };
    };
  })();

  // How strongly note m shows up in a spectrum. `ok` means its own harmonics stand out as clear peaks.
  // Real pianos are rarely exactly in tune, and a string's higher harmonics run sharp. So each harmonic is
  // looked for in a window around where it should be (40 cents either side, more above for high harmonics),
  // centred on this piano's overall tuning, which the app learns as you play (mic.tune, in cents).
  const noteFreq = m => 440 * Math.pow(2, (m - 69 + mic.tune / 100) / 12);
  function findPeak(mag, f, h) {
    const perHz = FFT_N / mic.sr, c0 = Math.round(f * perHz);
    const lo = Math.min(c0 - 1, Math.floor(f * 0.9772 * perHz)), hi = Math.max(c0 + 1, Math.ceil(f * Math.pow(2, (40 + Math.min(50, 2.5 * h * h)) / 1200) * perHz));
    let p = 0, at = c0;
    for (let i = Math.max(1, lo); i <= hi && i < mag.length - 1; i++) {
      const v = mag[i];
      if (v > p && v >= mag[i - 1] && v >= mag[i + 1]) { p = v; at = i; } // a true local peak, not the skirt of a neighbour
    }
    return { p, at };
  }
  function noteInfo(fr, m) {
    const mag = fr.mag, f0 = noteFreq(m), perHz = FFT_N / mic.sr;
    let e = 0, peaks = 0, used = 0, first = null;
    const hs = [];
    for (let h = 1; h <= 5; h++) {
      const f = h * f0;
      if (f * 1.06 * perHz >= mag.length - 3) break;
      if (f * 0.0293 * perHz < 2) continue; // too low to separate from neighbouring keys; rely on higher harmonics
      const { p, at } = findPeak(mag, f, h);
      // A real note is a sharp peak that towers over the typical level within a semitone either side.
      // (The median ignores a neighbouring key that is still ringing; plain noise almost never passes.)
      const span = Math.max(4, Math.round(f * 0.0595 * perHz)), around = [];
      for (let i = at - span; i <= at + span; i++) if (Math.abs(i - at) > 2) around.push(mag[i] || 0);
      around.sort((a, b) => a - b);
      const isPeak = p > 4 * around[around.length >> 1] && p > 0.06 * fr.max;
      if (first === null) first = isPeak;
      if (isPeak) peaks++;
      e += p; used++;
      hs.push({ h, f, p, at, peak: isPeak });
    }
    let ok = first === true && peaks >= Math.min(2, used);
    // Strict octave: reject if this is really the same note an octave lower (which adds a peak at 1.5x).
    if (ok && !opts.octave && findPeak(mag, 1.5 * f0, 1).p > 0.4 * findPeak(mag, f0, 1).p) ok = false;
    return { e, ok, hs };
  }

  // How much of the sound that just appeared belongs to note m (0 to 1). A creak, a cough or a knock
  // spreads its energy everywhere; a piano note puts it on that note's own harmonics.
  // The few analysis bins that hold note m's harmonics in this frame: the actual peaks, not the whole
  // window they were searched in. (A hiss has energy everywhere; only a real string piles it onto these.)
  function noteBins(fr, m) {
    const f0 = noteFreq(m), bins = [];
    for (let h = 1; h <= (f0 < 150 ? 16 : 10) && h * f0 < 5000; h++) {
      const { p, at } = findPeak(fr.mag, h * f0, h);
      if (p > 0) for (let i = at - 2; i <= at + 2; i++) bins.push(i);
    }
    return bins;
  }
  // Two questions about the sound that has just appeared (m: one note, or several notes struck together):
  //  1. how much of it lies on those notes' harmonics, and
  //  2. is it concentrated in a handful of sharp pitches at all? Water, fans, flushes, creaks and voices
  //     smear across hundreds of pitches; piano notes do not.
  // Returns the share (0 to 1), or 0 if the new sound is not concentrated enough to be notes.
  function shareOfNewSound(fr, m) {
    const older = mic.frames.filter(f => f !== fr).slice(-8);
    if (!older.length) return 0;
    const notes = [].concat(m);
    const bins = [...new Set(notes.flatMap(n => noteBins(fr, n)))].filter(i => i > 0 && i < fr.mag.length);
    const en = f => bins.reduce((t, i) => t + f.mag[i] * f.mag[i], 0);
    // Compare with the most recent moment before this note started.
    const low = Math.min(...older.map(en));
    let q = older[0];
    for (const f of older) if (en(f) <= 1.2 * low + 1e-12) q = f;
    const perHz = FFT_N / mic.sr, lo = Math.round(60 * perHz), hi = Math.min(fr.mag.length, Math.round(5000 * perHz));
    const grew = new Float32Array(hi);
    let all = 0;
    for (let i = lo; i < hi; i++) { grew[i] = Math.max(0, fr.mag[i] * fr.mag[i] - q.mag[i] * q.mag[i]); all += grew[i]; }
    if (all <= 0) return 0;
    const top = Array.from(grew).sort((a, b) => b - a).slice(0, 24 * notes.length).reduce((t, v) => t + v, 0);
    fr.focus = top / all;
    if (fr.focus < 0.4) return 0;
    return bins.reduce((t, i) => t + (grew[i] || 0), 0) / all;
  }

  // Loudness of note m in a short (85 ms) slice of sound: quick enough to catch a key being struck again.
  const shortWin = new Float32Array(4096).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 4095));
  function shortEnergy(buf, m) {
    const f0 = noteFreq(m);
    let sum = 0;
    for (let h = 1; h <= 3; h++) {
      const w = 2 * Math.PI * h * f0 / mic.sr;
      if (w > 2) break;
      const k = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < 4096; i++) { const s0 = buf[i] * shortWin[i] + k * s1 - s2; s2 = s1; s1 = s0; }
      sum += Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2));
    }
    return sum;
  }

  function yin(buf, sr) {
    const W = buf.length >> 1, tMin = Math.floor(sr / 2000), tMax = Math.min(W - 1, Math.floor(sr / 60));
    const d = mic.d; let run = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i += 2) { const x = buf[i] - buf[i + tau]; s += x * x; }
      run += s;
      d[tau] = run ? s * tau / run : 1;
    }
    for (let tau = Math.max(2, tMin); tau < tMax; tau++) {
      if (d[tau] < 0.15) {
        while (tau + 1 < tMax && d[tau + 1] < d[tau]) tau++;
        const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c;
        return sr / (tau + (den ? (a - c) / (2 * den) : 0));
      }
    }
    return 0;
  }

  // iPhone: say what kind of sound the app makes, so "Hear it" and Listen still play with the silent switch on.
  function audioMode(type) { try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* older iOS */ } }
  audioMode('playback');

  // auto: started by the app itself (opening Learn), so a refusal is noted quietly instead of interrupting.
  async function toggleMic(auto) {
    if (mic.busy) return;
    if (mic.on) {
      mic.stream.getTracks().forEach(t => t.stop());
      audioMode('playback');
      mic.on = false; $('micBtn').classList.remove('on'); $('micLabel').textContent = 'Mic off'; $('micInfo').textContent = ''; $('micLevel').hidden = true;
      return;
    }
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
      audioMode('play-and-record');
      const a = audio();
      mic.busy = true;
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      mic.busy = false;
      if (S.mode !== 'learn') { mic.stream.getTracks().forEach(t => t.stop()); audioMode('playback'); return; } // moved to Listen meanwhile
      mic.an = a.createAnalyser(); mic.an.fftSize = FFT_N;
      a.createMediaStreamSource(mic.stream).connect(mic.an);
      mic.time = new Float32Array(FFT_N); mic.sr = a.sampleRate;
      mic.stream.getAudioTracks()[0].addEventListener('ended', () => { if (mic.on) toggleMic(); }); // phone took the mic away
      mic.frames = []; mic.floor = 0.01; mic.lastC = null; mic.hitAt = mic.prevHitAt = -1e9; mic.on = true;
      $('micBtn').classList.add('on'); $('micLabel').textContent = 'Mic on';
      $('micInfo').textContent = 'Listening for your piano';
      $('micLevel').hidden = false;
    } catch (e) {
      mic.busy = false; mic.denied = true;
      audioMode('playback');
      const why = e.message === 'unsupported'
        ? 'This browser cannot use the microphone here. Open the app over https in Safari.'
        : 'Microphone blocked. Allow it in your browser settings, then try again.';
      $('micInfo').textContent = why;
      if (auto !== true) coach('', '', why);
    }
  }

  function micTick(now) {
    if (!mic.on || now < mic.nextAt) return;
    mic.nextAt = now + 50;
    mic.an.getFloatTimeDomainData(mic.time);
    micProcess(mic.time, now);
  }

  // --- The loudest pitches in a frame, for the live readout in Options.
  function binFreq(mag, i) { // exact frequency of a peak, between analysis bins
    const a = mag[i - 1] || 0, b = mag[i] || 0, c = mag[i + 1] || 0, den = a - 2 * b + c;
    return (i + (den ? 0.5 * (a - c) / den : 0)) * mic.sr / FFT_N;
  }
  function topPeaks(fr, count) {
    const mag = fr.mag, perHz = FFT_N / mic.sr, found = [];
    for (let i = Math.round(60 * perHz); i < Math.min(mag.length - 1, Math.round(4200 * perHz)); i++) {
      if (mag[i] > 0.05 * fr.max && mag[i] > mag[i - 1] && mag[i] >= mag[i + 1]) found.push(i);
    }
    return found.sort((a, b) => mag[b] - mag[a]).slice(0, count).map(i => {
      const f = binFreq(mag, i), exact = 69 + 12 * Math.log2(f / 440), m = Math.round(exact), cents = Math.round((exact - m) * 100);
      return { f, rel: Math.round(100 * mag[i] / fr.max), label: `${noteName(m)}${cents ? (cents > 0 ? ', ' + cents + ' cents sharp' : ', ' + -cents + ' cents flat') : ''}`, short: `${f.toFixed(1)}(${noteName(m)}${cents >= 0 ? '+' : ''}${cents})${Math.round(100 * mag[i] / fr.max)}` };
    });
  }

  // A note whose harmonics all belong to a lower note as well (B over a low E, or the octave above) cannot be
  // told apart by which frequencies are present. But a lone string's harmonics fade smoothly, so if this
  // note's pitch stands far above the average of the lower note's two neighbouring harmonics, it is really there.
  function standsOut(fr, m, lowers) {
    const f1 = noteFreq(m), mine = findPeak(fr.mag, f1, 1).p;
    return lowers.some(L => {
      const fL = noteFreq(L), k = Math.round(f1 / fL);
      return k >= 2 && Math.abs(f1 / (k * fL) - 1) < 0.025 && mine > 1.8 * Math.sqrt(findPeak(fr.mag, (k - 1) * fL, 1).p * findPeak(fr.mag, (k + 1) * fL, 1).p);
    });
  }

  // Two or more notes written together (both hands, or a chord): every one of them has to be heard, struck
  // within half a second of each other. Returns true if any of the wanted notes is sounding.
  function chordListen(fr, now, dbg) {
    const step = S.steps[S.idx], all = step.notes.map(n => n.m);
    if (mic.partialAt && S.hit.size && now - mic.partialAt > 500) { // only part of it arrived: start the step again
      mic.stale = [...S.hit]; // these are still ringing, so they must be struck afresh to count
      S.hit.clear(); mic.partialAt = 0; mic.pendChord = {};
      coach('', stepNames(step), `<b>Together.</b> Strike ${all.length > 2 ? 'all the notes' : 'both notes'} at the same moment.<span class="sub">${fingerText(step).replace(/<[^>]+>/g, '')}</span>`);
    }
    const want = step.notes.filter(n => !S.hit.has(n.m));
    const settled = mic.lastC == null || now - mic.hitAt >= 450;
    const from = Math.max(mic.prevHitAt, settled ? mic.hitAt : -1e9) + 240;
    const baseFrames = mic.frames.filter(f => f !== fr && f.t > from).slice(-10);
    const again = mic.frames.filter(f => f !== fr && f.t > mic.hitAt).slice(-3);
    const coincides = (f, L) => { const fL = noteFreq(L), k = Math.max(1, Math.round(f / fL)); return Math.abs(f / (k * fL) - 1) < 0.025; };
    const heard = [];
    let any = false;
    for (const n of want) {
      const info = noteInfo(fr, n.m);
      // An odd harmonic must show, or this could just be the companion an octave above.
      if (!info.ok || !info.hs.some(h => h.h % 2 === 1 && h.peak)) continue;
      any = true;
      if (!baseFrames.length) continue;
      const base = baseFrames.map(f => noteInfo(f, n.m)), others = all.filter(m => m !== n.m);
      let risen = 0, own = 0;
      info.hs.forEach((h, i) => {
        if (!h.peak || h.p <= 1.35 * Math.min(...base.map(b => b.hs[i].p))) return;
        risen++;
        if (!others.some(L => coincides(h.f, L)) && !(!settled && mic.lastNotes.some(L => coincides(h.f, L)))) own++;
      });
      const enough = risen >= Math.min(2, info.hs.length);
      let good = enough && own >= 1;
      if (enough && !good) good = standsOut(fr, n.m, others.concat(settled ? [] : mic.lastNotes));
      // the same key struck again straight after the previous step
      if (!good && mic.lastNotes.includes(n.m) && now - mic.hitAt >= 200 && again.length &&
        shortEnergy(fr.short, n.m) > 1.4 * Math.min(...again.map(f => shortEnergy(f.short, n.m)))) good = true;
      if (good && mic.stale.includes(n.m) && !(again.length && shortEnergy(fr.short, n.m) > 1.4 * Math.min(...again.map(f => shortEnergy(f.short, n.m))))) good = false;
      if (good) heard.push(n);
    }
    // Guard against noises: the notes together must account for the new sound, and each must last two looks.
    const share = heard.length ? shareOfNewSound(fr, want.map(n => n.m)) : 0;
    const prevT = mic.frames.length > 1 ? mic.frames[mic.frames.length - 2].t : -1;
    const sure = share >= 0.3 ? heard.filter(n => mic.pendChord[n.m] === prevT) : [];
    const pend = {};
    if (share >= 0.3) heard.forEach(n => { if (!sure.includes(n)) pend[n.m] = now; });
    mic.pendChord = pend;
    dbg.note = 'chord ' + want.map(n => noteName(n.m)).join('+');
    dbg.why = `heard ${heard.map(n => noteName(n.m)).join('+') || '-'} share${share.toFixed(2)} focus${(fr.focus || 0).toFixed(2)} have ${S.hit.size}/${all.length}`;
    const idx0 = S.idx;
    for (const n of sure) {
      if (!mic.partialAt) mic.partialAt = now;
      dbg.out = 'HIT ' + noteName(n.m);
      noteInput(n.m, 'mic');
      if (S.idx !== idx0 || S.finished) { // the whole step is complete
        mic.prevHitAt = mic.hitAt; mic.hitAt = now; mic.lastC = n.m; mic.lastNotes = all; mic.partialAt = 0; mic.pendChord = {}; mic.stale = [];
        break;
      }
    }
    return any;
  }

  // time: the most recent FFT_N samples.
  function micProcess(time, now) {
    let e = 0;
    for (let i = FFT_N - 4096; i < FFT_N; i += 2) e += time[i] * time[i];
    const rms = Math.sqrt(e / 2048);
    // The quiet level of the room is tracked, so "sound" always means "clearly louder than the room".
    mic.floor = Math.min(mic.floor * 1.003 + 1e-7, Math.max(rms, 1e-5));
    const gate = Math.max(0.0006, mic.floor * 3);
    $('micLevel').firstElementChild.style.width = Math.round(100 * Math.max(0, Math.min(1, Math.log10(rms / gate) / 1.7))) + '%';
    const fr = spectrum(time, mic.sr); fr.t = now;
    mic.frames.push(fr); if (mic.frames.length > 14) mic.frames.shift();
    fr.rms = rms; fr.short = time.slice(FFT_N - 4096);
    const recent = mic.frames.slice(-4, -1);
    if (recent.length && rms > 1.25 * Math.min(...recent.map(f => f.rms))) mic.attackAt = now; // a key was just struck
    const dbg = { t: now, lvl: 20 * Math.log10(rms / gate), fr };
    mic.log = [dbg]; // the latest look only, for testing
    if (rms >= gate && !$('moreWrap').hidden) {
      const top = topPeaks(fr, 1)[0];
      if (top) $('micInfo').textContent = `Loudest pitch right now: ${top.label}. This piano's tuning so far: ${Math.round(mic.tune)} cents.`;
    }
    if (now < S.muteMicUntil || S.mode !== 'learn' || S.finished) { mic.cand = null; dbg.out = 'paused'; return; }
    if (rms < gate) {
      if (++mic.quiet === 3) released();
      mic.cand = null; dbg.out = 'quiet';
      return;
    }
    mic.quiet = 0;
    dbg.want = S.steps[S.idx].notes.map(n => noteName(n.m)).join('+');
    if (tooEarly()) { mic.cand = null; dbg.out = 'holding'; return; }

    // 1. Is the note we are waiting for newly sounding?
    const want = S.steps[S.idx].notes.filter(n => !S.hit.has(n.m));
    let targetHeard = false;
    if (S.steps[S.idx].notes.length > 1) {
      if (chordListen(fr, now, dbg)) { mic.cand = null; return; }
    } else
    for (const n of want) {
      for (const c of (opts.octave ? [n.m, n.m - 12, n.m + 12, n.m - 24, n.m + 24] : [n.m])) {
        const info = noteInfo(fr, c);
        const main = n === want[0] && c === n.m;
        if (main) dbg.note = noteName(c) + ' ' + info.hs.map(h => 'h' + h.h + (h.peak ? 'P' : '-')).join('') + (info.ok ? ' ok' : ' no');
        if (!info.ok) continue;
        targetHeard = true;
        // The notes just played keep "growing" in the analysis for about half a second, and they contain
        // the frequencies of other notes too (octaves, fifths). So right after a note, a new note only
        // counts if frequencies of its own, ones the previous notes do not have, have appeared.
        const settled = mic.lastC == null || now - mic.hitAt >= 450;
        const from = Math.max(mic.prevHitAt, settled ? mic.hitAt : -1e9) + 240; // earlier notes must have stopped growing
        const base = mic.frames.filter(f => f !== fr && f.t > from).slice(-10).map(f => noteInfo(f, c));
        let risen = 0, own = 0;
        if (base.length) info.hs.forEach((h, i) => {
          if (!h.peak || h.p <= 1.35 * Math.min(...base.map(b => b.hs[i].p))) return;
          risen++;
          const explained = !settled && mic.lastNotes.some(L => {
            const fL = noteFreq(L), k = Math.max(1, Math.round(h.f / fL));
            return Math.abs(h.f / (k * fL) - 1) < 0.025;
          });
          if (!explained) own++;
        });
        const rose = risen >= Math.min(2, info.hs.length) && (own >= 1 || (!settled && standsOut(fr, c, mic.lastNotes)));
        // The same key struck again: this note suddenly louder in the last fraction of a second.
        const again = mic.frames.filter(f => f !== fr && f.t > mic.hitAt).slice(-3);
        const restruck = c === mic.lastC && now - mic.hitAt >= 200 && again.length > 0 &&
          shortEnergy(fr.short, c) > 1.4 * Math.min(...again.map(f => shortEnergy(f.short, c)));
        // Guard against noises: most of the new sound must be this note, and it must last two looks in a row.
        const share = rose ? shareOfNewSound(fr, c) : 0;
        const real = restruck || (rose && share >= 0.3);
        if (main || real) dbg.why = `${noteName(c)} risen${risen} own${own} share${share.toFixed(2)} focus${(fr.focus || 0).toFixed(2)}${restruck ? ' restruck' : ''}${settled ? '' : ' unsettled'}`;
        const steady = real && mic.pend === c && mic.pendAt === mic.frames[mic.frames.length - 2].t;
        if (real && !steady) { mic.pend = c; mic.pendAt = now; dbg.out = 'pending'; return; }
        if (steady) {
          mic.pend = null;
          mic.prevHitAt = mic.hitAt; mic.hitAt = now; mic.lastC = c; mic.cand = null;
          mic.lastNotes = S.steps[S.idx].notes.map(x => x.m).concat(c);
          const lead = info.hs.find(h => h.peak && h.h <= 2);
          if (lead) { // learn how sharp or flat this piano is
            const off = 1200 * Math.log2(binFreq(fr.mag, lead.at) / (lead.h * 440 * Math.pow(2, (c - 69) / 12)));
            mic.tune = Math.max(-70, Math.min(70, mic.hits++ ? mic.tune * 0.75 + off * 0.25 : off));
          }
          dbg.out = 'HIT';
          noteInput(n.m, 'mic');
          return;
        }
      }
    }
    if (targetHeard) { mic.cand = null; return; }

    // 2. Otherwise, is one clear wrong note being struck?
    const f = yin(time.subarray(FFT_N - 4096), mic.sr);
    if (!f) { mic.cand = null; return; }
    const m = Math.round(69 + 12 * Math.log2(f / 440) - mic.tune / 100);
    if (m === mic.cand) mic.candN++; else { mic.cand = m; mic.candN = 1; }
    dbg.yin = noteName(m) + 'x' + mic.candN;
    if (mic.candN < 4) return;
    const related = want.some(n => [0, 5, 7].includes((((m - n.m) % 12) + 12) % 12)); // octaves and fifths confuse pitch trackers
    const info = noteInfo(fr, m), before = mic.frames.slice(-9, -1);
    const distinct = info.hs.some(h => h.h % 2 === 1 && h.peak); // odd harmonics rule out "really the octave above"
    if (related || !info.ok || !distinct || !before.length) return;
    const fresh = info.e > 1.35 * Math.min(...before.map(f => noteInfo(f, m).e)) && shareOfNewSound(fr, m) >= 0.3; // newly struck, not left ringing, and not a noise
    const justPlayed = now - mic.hitAt < 700 && mic.lastNotes.some(L => (m - L) % 12 === 0);
    const sameAgain = m === mic.lastWrong && now - mic.wrongAt < 700;
    if (!fresh || justPlayed || sameAgain) return;
    mic.lastWrong = m; mic.wrongAt = now; mic.candN = 0;
    dbg.out = 'WRONG ' + noteName(m);
    noteInput(m, 'mic');
  }

  // ---------- MIDI keyboard (browsers that support Web MIDI) ----------
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(acc => {
      const hook = () => {
        let n = 0;
        acc.inputs.forEach(inp => { n++; inp.onmidimessage = ev => { const [s, note, vel] = ev.data; if ((s & 0xf0) === 0x90 && vel > 0) noteInput(note, 'midi'); else if ((s & 0xf0) === 0x80 || (s & 0xf0) === 0x90) released(); }; });
        if (n && !mic.on) $('micInfo').textContent = 'MIDI keyboard connected';
      };
      hook(); acc.onstatechange = hook;
    }).catch(() => { /* no MIDI access; microphone and on-screen keys still work */ });
  }

  // ---------- Drawing ----------
  const cv = $('stage'), ctx = cv.getContext('2d');
  // Pixels per beat: fewer on short screens, so a couple of bars stay in view.

  function layoutKeys() {
    const whites = [];
    for (let m = S.lo; m <= S.hi; m++) if (!isBlack(m)) whites.push(m);
    // S.inset: the strip behind the iPhone home bar. Keys run down into it, but their labels stay above it.
    const face = Math.min(140, (S.H - S.inset) * 0.36), keyH = face + S.inset, ww = S.W / whites.length;
    S.hitY = S.H - keyH; S.keyH = keyH; S.keys = [];
    S.ppb = Math.max(40, Math.min(64, S.hitY / 5.5));
    let wi = 0;
    for (let m = S.lo; m <= S.hi; m++) {
      if (isBlack(m)) S.keys.push({ m, black: true, x: wi * ww - ww * 0.31, w: ww * 0.62, h: face * 0.62 });
      else { S.keys.push({ m, black: false, x: wi * ww, w: ww, h: keyH }); wi++; }
    }
  }
  const keyOf = m => S.keys[m - S.lo];

  function resize() {
    const r = cv.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    S.inset = parseFloat(getComputedStyle(cv.parentElement).paddingBottom) || 0;
    S.W = r.width; S.H = r.height;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.song) layoutKeys();
  }

  function rr(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // Aged paper: a small tile of speckles and fibres, used behind the page and the note lane.
  const paperTile = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 180;
    const x = c.getContext('2d');
    x.fillStyle = COL.paper; x.fillRect(0, 0, 180, 180);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2600; i++) {
      x.fillStyle = rnd() < 0.6 ? `rgba(110,80,35,${0.02 + rnd() * 0.05})` : `rgba(255,250,236,${0.05 + rnd() * 0.1})`;
      x.fillRect(rnd() * 180, rnd() * 180, 1 + rnd() * 1.6, 1 + rnd() * 1.6);
    }
    x.strokeStyle = 'rgba(110,80,35,0.05)'; x.lineWidth = 0.6;
    for (let i = 0; i < 26; i++) { const a = rnd() * 180, b = rnd() * 180, t = rnd() * 6.3; x.beginPath(); x.moveTo(a, b); x.lineTo(a + Math.cos(t) * 14, b + Math.sin(t) * 14); x.stroke(); }
    return c;
  })();
  try { document.documentElement.style.setProperty('--tile', `url(${paperTile.toDataURL()})`); } catch (e) { /* plain paper colour */ }
  const paperFill = ctx.createPattern(paperTile, 'repeat');

  // A note is drawn the way an engraver would: a notehead where the key is struck and a stem as long as it lasts.
  // Notes of two beats or more get an open (hollow) head, like half notes on a printed page.
  function drawNote(cx, yb, h, r, ink, open, label, faded) {
    ctx.globalAlpha = faded ? 0.28 : 1;
    ctx.fillStyle = ink;
    rr(cx - 2.5, yb - h, 5, Math.max(0, h - r), 2.5); ctx.fill();
    ctx.save(); ctx.translate(cx, yb - r * 0.78); ctx.rotate(-0.32);
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.78, 0, 0, Math.PI * 2); ctx.fill();
    if (open) { ctx.fillStyle = COL.leaf; ctx.beginPath(); ctx.ellipse(0, 0, r * 0.74, r * 0.5, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    if (label) {
      ctx.fillStyle = open ? COL.ink : COL.leaf;
      ctx.font = `700 ${Math.round(r * (label.length > 1 ? 0.95 : 1.2))}px ${SERIF}`;
      ctx.fillText(label, cx, yb - r * 0.74);
    }
    ctx.globalAlpha = 1;
  }

  function draw(now) {
    const { W, H, hitY } = S, s = S.song;
    ctx.fillStyle = paperFill || COL.paper; ctx.fillRect(0, 0, W, H);
    const shade = ctx.createLinearGradient(0, 0, W, 0); // the page darkens slightly toward its edges
    shade.addColorStop(0, 'rgba(110,80,35,0.14)'); shade.addColorStop(0.12, 'rgba(110,80,35,0)'); shade.addColorStop(0.88, 'rgba(110,80,35,0)'); shade.addColorStop(1, 'rgba(110,80,35,0.14)');
    ctx.fillStyle = shade; ctx.fillRect(0, 0, W, hitY);
    // octave guides (fine ruled lines) and bar lines (ink, numbered in the margin)
    ctx.strokeStyle = 'rgba(42,31,20,0.16)'; ctx.lineWidth = 0.75; ctx.beginPath();
    S.keys.forEach(k => { if (k.m % 12 === 0 && k.x > 0) { ctx.moveTo(k.x, 0); ctx.lineTo(k.x, hitY); } });
    ctx.stroke();
    ctx.strokeStyle = 'rgba(42,31,20,0.55)'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillStyle = COL.dim; ctx.font = `italic 12px ${SERIF}`;
    const firstBar = Math.floor((S.view - s.pickup) / s.barLen);
    const tags = [];
    for (let b = firstBar; b < firstBar + 14; b++) {
      const y = Math.round(hitY - 7 - (s.pickup + b * s.barLen - S.view) * S.ppb) + 0.5;
      if (y < 0) break;
      const inLoop = S.loopBars && b + 1 >= S.loopBars[0] && b + 1 <= S.loopBars[1];
      if (inLoop) { ctx.fillStyle = 'rgba(125,42,28,0.09)'; ctx.fillRect(0, y - s.barLen * S.ppb, W, s.barLen * S.ppb); }
      if (y <= hitY - 4) { ctx.moveTo(0, y); ctx.lineTo(W, y); if (b >= 0) tags.push([b + 1, y, inLoop]); }
    }
    ctx.stroke();
    // falling notes
    const step = S.steps[S.idx];
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const n of s.notes) {
      const yb = hitY - 7 - (n.t - S.view) * S.ppb, h = Math.max(16, n.d * S.ppb - 3); // heads rest just above the double rule
      if (yb < 0 || yb - h > hitY) continue;
      const k = keyOf(n.m); if (!k) continue;
      const active = S.hands === 'B' || n.h === S.hands || !s.notes.some(x => x.h === S.hands);
      const showFinger = opts.fingers && n.f && active;
      const label = showFinger ? String(n.f) : opts.names ? NAMES[n.m % 12].replace('#', '♯') : '';
      drawNote(k.x + k.w / 2, yb, h, Math.max(8, Math.min(11, k.w * 0.62)), COL[n.h], n.d >= 2, label, !active);
    }
    // bar numbers sit in small ruled boxes in the margin, drawn over the notes so they stay readable: tap one to repeat that bar
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `italic 600 13px ${SERIF}`;
    for (const [num, y, inLoop] of tags) {
      const w = num > 99 ? 34 : 28;
      ctx.fillStyle = inLoop ? '#7d2a1c' : COL.leaf; ctx.fillRect(3, y - 25, w, 20);
      ctx.strokeStyle = inLoop ? '#7d2a1c' : 'rgba(42,31,20,0.7)'; ctx.lineWidth = 1; ctx.strokeRect(3.5, y - 24.5, w - 1, 19);
      ctx.fillStyle = inLoop ? COL.leaf : COL.ink; ctx.fillText(String(num), 3 + w / 2, y - 14.5);
    }
    // keyboard: ivory and ebony with inked outlines
    ctx.fillStyle = COL.ink; ctx.fillRect(0, hitY, W, H - hitY);
    const targets = new Map();
    if (S.mode === 'learn' && !S.finished && !tooEarly()) step.notes.forEach(n => { if (!S.hit.has(n.m)) targets.set(n.m, n.h); });
    const fillFor = k => {
      const f = S.flashes.get(k.m);
      if (f) { if (f.until > now) return COL[f.kind]; S.flashes.delete(k.m); }
      if (targets.has(k.m)) return COL[targets.get(k.m)];
      if (S.hit.has(k.m) && S.mode === 'learn') return COL.ok;
      return k.black ? COL.black : COL.white;
    };
    for (const pass of [false, true]) {
      for (const k of S.keys) {
        if (k.black !== pass) continue;
        const base = fillFor(k), plain = base === COL.white || base === COL.black;
        if (plain && !k.black) {
          const g = ctx.createLinearGradient(0, hitY, 0, hitY + k.h);
          g.addColorStop(0, '#d9cdb0'); g.addColorStop(0.1, COL.white); g.addColorStop(1, '#fffaf0');
          ctx.fillStyle = g;
        } else ctx.fillStyle = base;
        rr(k.x + 0.6, hitY + 3, k.w - 1.2, k.h - 4, k.black ? 1.5 : 2.5); ctx.fill();
        if (k.black && !plain) { ctx.strokeStyle = COL.ink; ctx.lineWidth = 1; ctx.stroke(); }
        const lit = targets.has(k.m) || S.flashes.has(k.m) || (S.hit.has(k.m) && S.mode === 'learn');
        if (opts.names && (lit || (!k.black && k.m % 12 === 0)) && k.w >= 11) {
          ctx.fillStyle = lit ? COL.leaf : COL.dim;
          ctx.font = (lit ? '700 ' : 'italic 500 ') + Math.min(14, k.w * 0.6) + 'px ' + SERIF;
          ctx.fillText(lit ? NAMES[k.m % 12].replace('#', '♯') : noteName(k.m), k.x + k.w / 2, hitY + k.h - (k.black ? 0 : S.inset) - 14);
        }
      }
    }
    // where notes land: a double rule, thin over thick, like a final bar line
    ctx.fillStyle = COL.ink; ctx.fillRect(0, hitY - 5, W, 1); ctx.fillRect(0, hitY - 2.5, W, 3);
  }

  let lastT = 0;
  function frame() {
    const now = clock();
    const dt = Math.min(0.1, (now - lastT) / 1000 || 0); lastT = now;
    if (S.song) {
      if (S.mode === 'listen') {
        if (S.playing) {
          const s = S.song, spb = 60 / (s.bpm * S.tempo);
          S.view += dt / spb;
          while (S.li < s.notes.length && s.notes[S.li].t <= S.view) {
            const n = s.notes[S.li++];
            tone(n.m, Math.min(2.5, n.d * spb)); flash(n.m, n.h === 'L' ? 'L' : 'R', Math.max(180, n.d * spb * 900));
          }
          let moved = false;
          while (S.idx + 1 < S.steps.length && S.steps[S.idx + 1].t <= S.view) { S.idx++; moved = true; }
          const endStep = S.steps[S.loopB != null ? S.loopB : S.steps.length - 1];
          const endT = endStep.t + Math.max(...endStep.notes.map(n => n.d));
          if (S.view >= endT) {
            if (S.loopB != null) { S.idx = S.loopA || 0; S.view = S.steps[S.idx].t - 1; seekListen(); moved = true; }
            else { S.playing = false; prompt(); moved = true; }
          }
          if (moved) updateUI();
        }
      } else if (!tickHold(now)) {
        const target = S.steps[S.idx].t;
        S.view += (target - S.view) * Math.min(1, dt * 10);
      }
      micTick(now);
      draw(now);
    }
    requestAnimationFrame(frame);
  }

  // The lyric line: the whole phrase, with the syllable for the current note marked.
  function renderLyric() {
    const box = $('lyric');
    box.hidden = !(opts.lyrics && S.syl && S.syl.length);
    if (box.hidden) return;
    const cur = Math.max(0, S.steps[S.idx].syl), started = S.steps[S.idx].syl >= 0;
    const line = S.syl[cur].line;
    box.textContent = '';
    S.syl.forEach((sy, i) => {
      if (sy.line !== line) return;
      const sp = document.createElement('span');
      sp.textContent = sy.text;
      sp.className = !started || i > cur ? '' : i === cur ? 'now' : 'done';
      box.append(sp, sy.text.endsWith('-') ? '' : ' ');
    });
  }

  // ---------- Controls ----------
  function updateUI() {
    const st = stats[S.id];
    $('songBtn').innerHTML = '';
    const sm = document.createElement('small'); sm.textContent = 'Song' + (st && st.best != null ? ' · best ' + st.best + '%' : '');
    const ti = document.createElement('span'); ti.textContent = S.song.title;
    $('songBtn').append(sm, ti);
    $('scrub').max = S.steps.length - 1; $('scrub').value = S.idx;
    $('pos').textContent = `${S.idx + 1} / ${S.steps.length}`;
    renderLyric();
    const L = S.loopBars;
    $('loopClear').hidden = !L;
    if (L) $('loopClear').textContent = 'Repeating ' + (L[0] === L[1] ? barLabel(L[0]) : `bars ${Math.max(1, L[0])}\u2013${L[1]}`) + ' \u00b7 stop';
    for (const b of $('hands').children) b.classList.toggle('on', b.dataset.v === S.hands);
    for (const b of $('speed').children) b.classList.toggle('on', +b.dataset.v === S.tempo);
    $('modeLearn').classList.toggle('on', S.mode === 'learn');
    $('modeListen').classList.toggle('on', S.mode === 'listen');
    $('playBtn').hidden = S.mode !== 'listen'; $('playBtn').textContent = S.playing ? 'Pause' : 'Play';
    $('hearBtn').hidden = S.mode !== 'learn' || S.finished;
  }

  function setMode(mode) {
    S.mode = mode; S.playing = false; S.finished = false; S.hit.clear(); endHold();
    // iPhones play sound quietly through the earpiece while the microphone is on,
    // so the mic is switched off for Listen and back on when you return to Learn.
    if (mode === 'listen' && mic.on) toggleMic();
    else if (mode === 'learn') autoMic();
    if (mode === 'listen') { S.view = S.steps[S.idx].t - 1; seekListen(); }
    prompt(); updateUI();
  }

  $('modeLearn').onclick = () => setMode('learn');
  $('modeListen').onclick = () => setMode('listen');
  $('restartBtn').onclick = restart;
  $('micBtn').onclick = () => { mic.userOff = mic.on; mic.denied = false; store.set('pm.micOff', mic.userOff); toggleMic(); };
  // Learn mode needs the microphone, so it comes on by itself unless you have switched it off.
  function autoMic() { if (S.mode === 'learn' && !mic.on && !mic.userOff && !mic.denied) toggleMic(true); }
  document.addEventListener('pointerdown', () => { if (ac && ac.state === 'suspended') ac.resume(); }); // sound can only start after a touch
  $('playBtn').onclick = () => {
    audio();
    const last = S.steps[S.steps.length - 1];
    if (!S.playing && S.view >= last.t) { S.idx = S.loopA || 0; S.view = S.steps[S.idx].t - 1; seekListen(); }
    S.playing = !S.playing; prompt(); updateUI();
  };
  $('hearBtn').onclick = () => {
    const spb = 60 / S.song.bpm;
    S.steps[S.idx].notes.forEach(n => tone(n.m, Math.min(1.5, n.d * spb)));
  };
  $('hands').onclick = e => { if (e.target.dataset.v) $('hands').onchange({ target: { value: e.target.dataset.v } }); };
  $('speed').onclick = e => { if (e.target.dataset.v) { S.tempo = +e.target.dataset.v; store.set('pm.speed', S.tempo); updateUI(); } };
  $('hands').onchange = e => {
    S.hands = e.target.value;
    const t = S.steps[S.idx].t;
    buildSteps(); setRange();
    S.loopA = S.loopB = null; S.loopBars = null;
    S.idx = Math.max(0, S.steps.findIndex(s => s.t >= t - 1e-6));
    S.hit.clear(); S.misses = []; S.finished = false; endHold();
    prompt(); updateUI();
  };
  $('scrub').oninput = e => {
    S.idx = +e.target.value; S.hit.clear(); S.finished = false; endHold();
    if (S.mode === 'listen') { S.view = S.steps[S.idx].t - 0.001; seekListen(); }
    prompt(); updateUI();
  };
  $('loopClear').onclick = stopLoop;

  cv.addEventListener('pointerdown', ev => {
    const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (y < S.hitY) { // the left margin of the notes: bar numbers
      if (x > 52) return;
      const bar = Math.floor((S.view + (S.hitY - 7 - y) / S.ppb - S.song.pickup) / S.song.barLen) + 1;
      if (bar >= 1 && S.steps.some(st => barOf(st.t) === bar)) tapBar(bar);
      return;
    }
    ev.preventDefault();
    const inKey = k => x >= k.x && x < k.x + k.w && y < S.hitY + k.h;
    const k = S.keys.find(k => k.black && inKey(k)) || S.keys.find(k => !k.black && inKey(k));
    if (!k) return;
    tone(k.m, 0.5);
    if (S.mode === 'learn' && !S.finished) noteInput(k.m, 'tap'); else flash(k.m, 'R');
  });
  cv.addEventListener('pointerup', released);

  // ---------- Song sheet ----------
  function renderList() {
    const box = $('songList'); box.textContent = '';
    library().forEach(e => {
      const row = document.createElement('div'); row.className = 'song';
      const pick = document.createElement('button'); pick.className = 'pick';
      const st = stats[e.id];
      pick.append(e.song.title);
      const meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = `${e.song.notes.length} notes` + (e.song.notes.some(n => n.h === 'L') ? ' · both hands' : '') + (st && st.best != null ? ` · best ${st.best}%` : '');
      pick.append(meta);
      pick.onclick = () => { selectSong(e.id); $('sheet').hidden = true; };
      row.append(pick);
      if (!e.builtin) {
        const del = document.createElement('button'); del.textContent = 'Remove';
        del.onclick = () => {
          if (del.dataset.sure) {
            imported = imported.filter(x => x.id !== e.id); store.set('pm.songs', imported);
            if (S.id === e.id) selectSong(builtins[0].id);
            renderList();
          } else { del.dataset.sure = '1'; del.textContent = 'Tap again to remove'; }
        };
        row.append(del);
      }
      box.append(row);
    });
  }

  function addSong(song) {
    const entry = { id: 'u' + Date.now(), song };
    imported.push(entry); store.set('pm.songs', imported);
    selectSong(entry.id);
    $('importErr').textContent = ''; $('abcText').value = '';
    $('sheet').hidden = true;
  }

  $('moreBtn').onclick = () => { $('moreWrap').hidden = false; };
  $('moreClose').onclick = () => { $('moreWrap').hidden = true; };
  $('moreWrap').onclick = e => { if (e.target === $('moreWrap')) $('moreWrap').hidden = true; };
  $('songBtn').onclick = () => { renderList(); $('importErr').textContent = ''; $('sheet').hidden = false; };
  $('sheetClose').onclick = () => { $('sheet').hidden = true; };
  $('fileBtn').onclick = () => $('file').click();
  $('file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const buf = await f.arrayBuffer(), head = new Uint8Array(buf.slice(0, 4));
      const title = f.name.replace(/\.[^.]+$/, '');
      if (String.fromCharCode(...head) === 'MThd') addSong(Parsers.parseMidi(buf, title));
      else { const s = Parsers.parseAbc(new TextDecoder().decode(buf)); if (s.title === 'Untitled') s.title = title; addSong(s); }
    } catch (err) { $('importErr').textContent = err.message || 'Could not read that file.'; }
    e.target.value = '';
  };
  $('abcAdd').onclick = () => {
    try { addSong(Parsers.parseAbc($('abcText').value)); }
    catch (err) { $('importErr').textContent = err.message || 'Could not read that tune.'; }
  };
  $('optNames').checked = opts.names; $('optOctave').checked = opts.octave; $('optFingers').checked = opts.fingers;
  $('optLyrics').checked = opts.lyrics;
  $('optLyrics').onchange = e => { opts.lyrics = e.target.checked; store.set('pm.opts', opts); renderLyric(); resize(); };
  $('optFingers').onchange = e => { opts.fingers = e.target.checked; store.set('pm.opts', opts); prompt(); };
  $('optNames').onchange = e => { opts.names = e.target.checked; store.set('pm.opts', opts); };
  $('optOctave').onchange = e => { opts.octave = e.target.checked; store.set('pm.opts', opts); };

  // ---------- Keep the screen awake while practising ----------
  let wake = null;
  async function keepAwake() {
    if (wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    catch (e) { /* not allowed right now; try again on the next touch */ }
  }
  document.addEventListener('pointerdown', keepAwake);
  document.addEventListener('visibilitychange', keepAwake);
  // Coming back from another app or a locked screen: iPhone pauses sound and the microphone, so wake them up.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !ac) return;
    try { if (ac.state !== 'running') await ac.resume(); } catch (e) { /* resumes on the next touch */ }
    const track = mic.on && mic.stream.getAudioTracks()[0];
    if (track && (track.readyState !== 'live' || track.muted)) { await toggleMic(); await toggleMic(); }
    mic.frames = []; lastT = clock();
  });

  // ---------- Offline copy ----------
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });

  // Shown in Options, so it is easy to tell which version a phone has loaded.
  $('version').textContent = 'Version 26' + (builtins[0].song.notes.some(n => n.ly) ? '' : ' (song file is out of date: close and reopen the app)');

  // ---------- Start ----------
  new ResizeObserver(resize).observe(cv.parentElement);
  resize();
  S.tempo = [0.5, 0.75, 1].includes(store.get('pm.speed', 1)) ? store.get('pm.speed', 1) : 1;
  selectSong(store.get('pm.last', builtins[0].id));
  mic.userOff = store.get('pm.micOff', false);
  autoMic();
  requestAnimationFrame(frame);
  window.__pm = { S, noteInput, mic, micProcess, tickHold, setClock(f) { clock = f; } }; // handy for debugging from the console
})();
