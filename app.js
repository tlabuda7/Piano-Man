(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = m => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
  const COL = { bg: '#10121a', lane: '#181c2a', line: '#2c3246', fg: '#ece8dc', dim: '#9aa0b4', R: '#f2b33d', L: '#4fc3c7', ok: '#5fd38a', bad: '#ff6b6b', white: '#f3efe4', black: '#20232e' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  let clock = () => performance.now();

  // ---------- Song library ----------
  let imported = store.get('pm.songs', []);
  let stats = store.get('pm.stats', {});
  const opts = Object.assign({ names: true, octave: true, fingers: true }, store.get('pm.opts', {}));
  const builtins = window.BUILTIN_SONGS.map(b => ({ id: b.id, song: Parsers.parseAbc(b.abc), builtin: true }));
  const library = () => builtins.concat(imported);

  // ---------- State ----------
  const S = {
    id: null, song: null, steps: [], idx: 0, mode: 'learn', playing: false, view: 0, li: 0,
    hands: 'B', tempo: 1, loopA: null, loopB: null, hit: new Set(), misses: [], finished: false,
    flashes: new Map(), keys: [], lo: 48, hi: 71, hitY: 0, W: 0, H: 0, muteMicUntil: 0, hold: null
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
  }

  function selectSong(id) {
    const entry = library().find(e => e.id === id) || builtins[0];
    S.id = entry.id; S.song = entry.song;
    store.set('pm.last', S.id);
    const hasL = S.song.notes.some(n => n.h === 'L');
    $('hands').hidden = !hasL;
    if (!hasL) { S.hands = 'B'; $('hands').value = 'B'; }
    if (!S.song.notes.some(n => n.f)) window.assignFingering(S.song);
    S.loopA = S.loopB = null;
    buildSteps(); setRange(); restart();
  }

  // The keyboard shows only the octaves the chosen hand(s) need, so keys stay as large as possible.
  function setRange() {
    const ms = [].concat(...S.steps.map(s => s.notes.map(n => n.m)));
    S.lo = Math.floor(Math.min(...ms) / 12) * 12;
    S.hi = Math.ceil((Math.max(...ms) + 1) / 12) * 12 - 1;
    while (S.hi - S.lo + 1 < 24) S.hi += 12;
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
    const where = barLabel(barOf(step.t)).replace(/^./, ch => ch.toUpperCase());
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
      if (src === 'mic' || S.hit.size >= step.notes.length) advance();
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

  function loopBar(bar) {
    const idxs = S.steps.map((s, i) => (barOf(s.t) === bar ? i : -1)).filter(i => i >= 0);
    if (!idxs.length) return;
    S.loopA = idxs[0]; S.loopB = idxs[idxs.length - 1];
    restart();
  }

  // ---------- Sound ----------
  let ac = null;
  function audio() {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(m, dur) {
    const a = audio(), t = a.currentTime, f = 440 * Math.pow(2, (m - 69) / 12);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.35);
    g.connect(a.destination);
    [[1, 'triangle', 1], [2, 'sine', 0.3]].forEach(([mult, type, vol]) => {
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
    cand: null, candN: 0, lastWrong: null, wrongAt: -1e9, nextAt: 0, tune: 0, hits: 0, log: [], d: new Float32Array(2049), sr: 48000 };

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
      around.sort();
      const isPeak = p > 3 * around[around.length >> 1] && p > 0.06 * fr.max;
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
  function noteBins(m) {
    const f0 = noteFreq(m), perHz = FFT_N / mic.sr, bins = [];
    let last = -1;
    for (let h = 1; h <= 12 && h * f0 < 5000; h++) {
      const lo = Math.floor(h * f0 * 0.9772 * perHz) - 1, hi = Math.ceil(h * f0 * Math.pow(2, (40 + Math.min(50, 2.5 * h * h)) / 1200) * perHz) + 1;
      for (let i = Math.max(last + 1, lo); i <= hi; i++) { bins.push(i); last = i; }
    }
    return bins;
  }
  function shareOfNewSound(fr, m) {
    const older = mic.frames.filter(f => f !== fr).slice(-8);
    if (!older.length) return 0;
    const bins = noteBins(m).filter(i => i < fr.mag.length);
    const en = f => bins.reduce((t, i) => t + f.mag[i] * f.mag[i], 0);
    // Compare with the most recent moment before this note started.
    const low = Math.min(...older.map(en));
    let q = older[0];
    for (const f of older) if (en(f) <= 1.2 * low + 1e-12) q = f;
    const grew = i => Math.max(0, fr.mag[i] * fr.mag[i] - q.mag[i] * q.mag[i]);
    const perHz = FFT_N / mic.sr, hi = Math.min(fr.mag.length, Math.round(5000 * perHz));
    let all = 0;
    for (let i = Math.round(60 * perHz); i < hi; i++) all += grew(i);
    return all > 0 ? bins.reduce((t, i) => t + grew(i), 0) / all : 0;
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

  async function toggleMic() {
    if (mic.on) {
      mic.stream.getTracks().forEach(t => t.stop());
      mic.on = false; $('micBtn').classList.remove('on'); $('micLabel').textContent = 'Mic off'; $('micInfo').textContent = ''; $('micLevel').hidden = true;
      return;
    }
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
      const a = audio();
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      mic.an = a.createAnalyser(); mic.an.fftSize = FFT_N;
      a.createMediaStreamSource(mic.stream).connect(mic.an);
      mic.time = new Float32Array(FFT_N); mic.sr = a.sampleRate;
      mic.frames = []; mic.floor = 0.01; mic.lastC = null; mic.hitAt = mic.prevHitAt = -1e9; mic.on = true;
      $('micBtn').classList.add('on'); $('micLabel').textContent = 'Mic on';
      $('micInfo').textContent = 'Listening for your piano';
      $('micLevel').hidden = false;
    } catch (e) {
      const why = e.message === 'unsupported'
        ? 'This browser cannot use the microphone here. Open the app over https in Safari.'
        : 'Microphone blocked. Allow it in your browser settings, then try again.';
      $('micInfo').textContent = why;
      coach('', '', why);
    }
  }

  function micTick(now) {
    if (!mic.on || now < mic.nextAt) return;
    mic.nextAt = now + 50;
    mic.an.getFloatTimeDomainData(mic.time);
    micProcess(mic.time, now);
  }

  // --- Listening report: what the microphone actually picked up over the last few seconds, as text.
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
  function listeningReport() {
    const track = mic.stream && mic.stream.getAudioTracks()[0], set = track && track.getSettings ? track.getSettings() : {};
    const head = `Piano Man listening report v4 | rate ${mic.sr} | tuning ${Math.round(mic.tune)}c after ${mic.hits} notes | room ${mic.floor.toExponential(1)} | any-octave ${opts.octave} | hands ${S.hands} | phone filters: echo ${set.echoCancellation} noise ${set.noiseSuppression} gain ${set.autoGainControl}`;
    const t0 = mic.log.length ? mic.log[0].t : 0;
    const lines = mic.log.map(d => `${((d.t - t0) / 1000).toFixed(2)} ${d.lvl.toFixed(0)}dB ${d.out || '-'}` +
      (d.want ? ` want ${d.want} | ${d.note || ''} | ${d.why || ''}${d.yin ? ' | yin ' + d.yin : ''} | ${topPeaks(d.fr, 6).map(p => p.short).join(' ')}` : ''));
    return head + '\n' + lines.join('\n');
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
    mic.log.push(dbg); if (mic.log.length > 90) mic.log.shift();
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
        const rose = own >= 1 && risen >= Math.min(2, info.hs.length);
        // The same key struck again: this note suddenly louder in the last fraction of a second.
        const again = mic.frames.filter(f => f !== fr && f.t > mic.hitAt).slice(-3);
        const restruck = c === mic.lastC && now - mic.hitAt >= 200 && again.length > 0 &&
          shortEnergy(fr.short, c) > 1.4 * Math.min(...again.map(f => shortEnergy(f.short, c)));
        // Guard against noises: most of the new sound must be this note, and it must last two looks in a row.
        const share = rose ? shareOfNewSound(fr, c) : 0;
        const real = restruck || (rose && share >= 0.3);
        if (main || real) dbg.why = `${noteName(c)} risen${risen} own${own} share${share.toFixed(2)}${restruck ? ' restruck' : ''}${settled ? '' : ' unsettled'}`;
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
    const fresh = info.e > 1.35 * Math.min(...before.map(f => noteInfo(f, m).e)); // newly struck, not left ringing
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
  const PPB = 64;

  function layoutKeys() {
    const whites = [];
    for (let m = S.lo; m <= S.hi; m++) if (!isBlack(m)) whites.push(m);
    const ww = S.W / whites.length, keyH = Math.min(150, S.H * 0.4);
    S.hitY = S.H - keyH; S.keyH = keyH; S.keys = [];
    let wi = 0;
    for (let m = S.lo; m <= S.hi; m++) {
      if (isBlack(m)) S.keys.push({ m, black: true, x: wi * ww - ww * 0.31, w: ww * 0.62, h: keyH * 0.62 });
      else { S.keys.push({ m, black: false, x: wi * ww, w: ww, h: keyH }); wi++; }
    }
  }
  const keyOf = m => S.keys[m - S.lo];

  function resize() {
    const r = cv.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    S.W = r.width; S.H = r.height;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.song) layoutKeys();
  }

  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function draw(now) {
    const { W, H, hitY } = S, s = S.song;
    const lane = ctx.createLinearGradient(0, 0, 0, hitY);
    lane.addColorStop(0, COL.bg); lane.addColorStop(1, COL.lane);
    ctx.fillStyle = lane; ctx.fillRect(0, 0, W, H);
    // octave guides and bar lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1; ctx.beginPath();
    S.keys.forEach(k => { if (k.m % 12 === 0 && k.x > 0) { ctx.moveTo(k.x, 0); ctx.lineTo(k.x, hitY); } });
    const firstBar = Math.floor((S.view - s.pickup) / s.barLen);
    for (let b = firstBar; b < firstBar + 12; b++) {
      const y = hitY - (s.pickup + b * s.barLen - S.view) * PPB;
      if (y < 0) break;
      if (y <= hitY) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    }
    ctx.stroke();
    // falling notes
    const step = S.steps[S.idx];
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const n of s.notes) {
      const yb = hitY - (n.t - S.view) * PPB, h = Math.max(14, n.d * PPB - 3), yt = yb - h;
      if (yb < 0 || yt > hitY) continue;
      const k = keyOf(n.m); if (!k) continue;
      const active = S.hands === 'B' || n.h === S.hands || !s.notes.some(x => x.h === S.hands);
      const w = Math.max(k.w - 3, 15), x = k.x + k.w / 2 - w / 2;
      ctx.globalAlpha = active ? 1 : 0.3;
      ctx.fillStyle = COL[n.h];
      rr(x, yt, w, h, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.22)'; rr(x + 2, yt + 2, w - 4, Math.min(h - 4, 5), 3); ctx.fill(); // soft highlight
      const showFinger = opts.fingers && n.f && active;
      if (opts.names || showFinger) {
        const label = showFinger ? String(n.f) : NAMES[n.m % 12].replace('#', '\u266f');
        ctx.fillStyle = '#1a1405'; ctx.font = '700 ' + Math.min(13, w * (label.length > 1 ? 0.6 : 0.75)) + 'px sans-serif';
        ctx.fillText(label, x + w / 2, yb - 9);
      }
      ctx.globalAlpha = 1;
    }
    // keyboard
    ctx.fillStyle = '#07080c'; ctx.fillRect(0, hitY, W, H - hitY);
    const targets = new Map();
    if (S.mode === 'learn' && !S.finished && !tooEarly()) step.notes.forEach(n => { if (!S.hit.has(n.m)) targets.set(n.m, n.h); });
    const fillFor = k => {
      const f = S.flashes.get(k.m);
      if (f) { if (f.until > now) return COL[f.kind]; S.flashes.delete(k.m); }
      if (targets.has(k.m)) return COL[targets.get(k.m)];
      return k.black ? COL.black : COL.white;
    };
    for (const pass of [false, true]) {
      for (const k of S.keys) {
        if (k.black !== pass) continue;
        const base = fillFor(k), plain = base === COL.white || base === COL.black;
        if (plain) {
          const g = ctx.createLinearGradient(0, hitY, 0, hitY + k.h);
          if (k.black) { g.addColorStop(0, '#2b2f3d'); g.addColorStop(1, '#14161d'); }
          else { g.addColorStop(0, '#d9d5ca'); g.addColorStop(0.12, COL.white); g.addColorStop(1, '#fffdf6'); }
          ctx.fillStyle = g;
        } else ctx.fillStyle = base;
        rr(k.x + 0.75, hitY + 2, k.w - 1.5, k.h - 3, k.black ? 3 : 5); ctx.fill();
        const lit = targets.has(k.m) || S.flashes.has(k.m);
        if (opts.names && (lit || (!k.black && k.m % 12 === 0)) && k.w >= 11) {
          ctx.fillStyle = k.black && !lit ? COL.dim : '#1a1405';
          ctx.font = (lit ? '700 ' : '500 ') + Math.min(13, k.w * 0.55) + 'px sans-serif';
          ctx.fillText(lit ? NAMES[k.m % 12] : noteName(k.m), k.x + k.w / 2, hitY + k.h - 14);
        }
      }
    }
    const glow = ctx.createLinearGradient(0, hitY - 26, 0, hitY);
    glow.addColorStop(0, 'rgba(242,179,61,0)'); glow.addColorStop(1, 'rgba(242,179,61,0.16)');
    ctx.fillStyle = glow; ctx.fillRect(0, hitY - 26, W, 26);
    ctx.fillStyle = COL.R; ctx.fillRect(0, hitY - 1.5, W, 1.5);
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

  // ---------- Controls ----------
  function updateUI() {
    const st = stats[S.id];
    $('songBtn').innerHTML = '';
    $('songBtn').append(S.song.title);
    const sm = document.createElement('small'); sm.textContent = st && st.best != null ? 'best ' + st.best + '%' : 'tap to change';
    $('songBtn').append(sm);
    $('scrub').max = S.steps.length - 1; $('scrub').value = S.idx;
    $('pos').textContent = `${S.idx + 1} / ${S.steps.length}`;
    const looping = S.loopA != null || S.loopB != null;
    $('loopClear').hidden = !looping;
    $('loopInfo').textContent = looping ? `Repeating notes ${(S.loopA || 0) + 1} to ${(S.loopB != null ? S.loopB : S.steps.length - 1) + 1}.` : 'Move the slider to a spot, then mark where the section starts and ends.';
    $('modeLearn').classList.toggle('on', S.mode === 'learn');
    $('modeListen').classList.toggle('on', S.mode === 'listen');
    $('playBtn').hidden = S.mode !== 'listen'; $('playBtn').textContent = S.playing ? 'Pause' : 'Play';
    $('hearBtn').hidden = S.mode !== 'learn' || S.finished;
  }

  function setMode(mode) {
    S.mode = mode; S.playing = false; S.finished = false; S.hit.clear(); endHold();
    if (mode === 'listen') { S.view = S.steps[S.idx].t - 1; seekListen(); }
    prompt(); updateUI();
  }

  $('modeLearn').onclick = () => setMode('learn');
  $('modeListen').onclick = () => setMode('listen');
  $('restartBtn').onclick = restart;
  $('micBtn').onclick = toggleMic;
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
  $('hands').onchange = e => {
    S.hands = e.target.value;
    const t = S.steps[S.idx].t;
    buildSteps(); setRange();
    S.loopA = S.loopB = null;
    S.idx = Math.max(0, S.steps.findIndex(s => s.t >= t - 1e-6));
    S.hit.clear(); S.misses = []; S.finished = false; endHold();
    prompt(); updateUI();
  };
  $('speed').onchange = e => { S.tempo = +e.target.value; };
  $('scrub').oninput = e => {
    S.idx = +e.target.value; S.hit.clear(); S.finished = false; endHold();
    if (S.mode === 'listen') { S.view = S.steps[S.idx].t - 0.001; seekListen(); }
    prompt(); updateUI();
  };
  $('loopA').onclick = () => { S.loopA = S.idx; if (S.loopB != null && S.loopB < S.loopA) S.loopB = null; updateUI(); };
  $('loopB').onclick = () => { S.loopB = S.idx; if (S.loopA == null || S.loopA > S.loopB) S.loopA = 0; S.idx = S.loopA; S.hit.clear(); endHold(); if (S.mode === 'listen') { S.view = S.steps[S.idx].t - 1; seekListen(); } prompt(); updateUI(); };
  $('loopClear').onclick = () => { S.loopA = S.loopB = null; updateUI(); };

  cv.addEventListener('pointerdown', ev => {
    const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (y < S.hitY) return;
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
  $('reportBtn').onclick = () => {
    const box = $('reportText');
    box.value = mic.log.length ? listeningReport() : 'Turn the microphone on and play a few notes first.';
    box.hidden = false;
    if (!mic.log.length) return;
    box.focus(); box.select();
    const done = ok => { $('reportBtn').textContent = ok ? 'Copied. Paste it to Claude' : 'Select the text below and copy it'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(() => done(true), () => done(false)); else done(false);
  };
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

  // ---------- Offline copy ----------
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });

  // ---------- Start ----------
  new ResizeObserver(resize).observe(cv.parentElement);
  resize();
  selectSong(store.get('pm.last', builtins[0].id));
  requestAnimationFrame(frame);
  window.__pm = { S, noteInput, mic, micProcess, tickHold, listeningReport, setClock(f) { clock = f; } }; // handy for debugging from the console
})();
