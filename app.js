(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = m => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
  const COL = { bg: '#12141c', lane: '#171a26', line: '#2c3246', fg: '#ece8dc', dim: '#9aa0b4', R: '#f2b33d', L: '#4fc3c7', ok: '#5fd38a', bad: '#ff6b6b', white: '#f3efe4', black: '#20232e' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

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
    flashes: new Map(), keys: [], lo: 48, hi: 71, hitY: 0, W: 0, H: 0, muteMicUntil: 0
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
    S.hit.clear(); S.misses = []; S.finished = false; S.playing = false;
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
    c.className = kind || '';
    $('coachBig').textContent = big;
    $('coachMsg').innerHTML = msg;
    const a = $('coachActions'); a.textContent = '';
    (actions || []).forEach(([label, fn, primary]) => {
      const b = document.createElement('button');
      b.textContent = label; if (primary) b.className = 'primary';
      b.onclick = fn; a.appendChild(b);
    });
    clearTimeout(coachTimer);
    if (kind === 'ok') coachTimer = setTimeout(() => { c.className = ''; }, 350);
  }

  function stepNames(step) { return step.notes.map(n => noteName(n.m)).join(' + '); }

  function fingerText(step) {
    if (!opts.fingers) return 'Play the lit key. ';
    const twoHands = S.song.notes.some(n => n.h === 'L');
    const parts = ['R', 'L'].map(h => {
      const fs = step.notes.filter(n => n.h === h && n.f).map(n => n.f);
      if (!fs.length) return '';
      return (twoHands ? (h === 'R' ? 'Right ' : 'Left ') : '') + (fs.length > 1 ? 'fingers ' : 'finger ') + fs.join('+');
    }).filter(Boolean);
    return parts.length ? '<b>' + parts.join(', ') + '.</b> ' : 'Play the lit key. ';
  }

  function prompt(kind) {
    if (S.mode === 'listen') {
      coach('', '', S.playing ? 'Playing. Watch which keys light up.' : 'Press <b>Play</b> to hear the song and watch the keys.');
      return;
    }
    const step = S.steps[S.idx];
    const where = `Note ${S.idx + 1} of ${S.steps.length} · ${barLabel(barOf(step.t))}`;
    coach(kind || '', stepNames(step), (kind === 'ok' ? '<b>Good.</b> ' : '') + fingerText(step) + where);
  }

  // ---------- Learn mode ----------
  function findMatch(m, src) {
    const want = S.steps[S.idx].notes.filter(n => !S.hit.has(n.m));
    const lenient = src === 'mic' && opts.octave;
    return want.find(n => n.m === m) || (lenient && want.find(n => (n.m - m) % 12 === 0)) || null;
  }

  function noteInput(m, src) {
    if (S.mode !== 'learn' || S.finished) return;
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
    coach('bad', stepNames(step), `<b>Try again.</b> That was ${noteName(m)}. Play <b>${want.map(n => noteName(n.m)).join(' + ')}</b>.` + (hint ? ' Listen, this is how it sounds.' : ''));
    if (hint) setTimeout(() => want.forEach(n => tone(n.m, 0.9)), src === 'tap' ? 500 : 150);
  }

  function advance() {
    S.hit.clear();
    S.idx++;
    if (S.loopB != null && S.idx > S.loopB) S.idx = S.loopA || 0;
    else if (S.idx >= S.steps.length) return finish();
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
    coach('ok', pct + '%', `<b>Finished.</b> ${clean} of ${total} notes right first time.` + (worst !== undefined ? ` Hardest spot: ${barLabel(+worst)}.` : ' No mistakes.'), actions);
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
    S.muteMicUntil = Math.max(S.muteMicUntil, performance.now() + (dur + 0.45) * 1000);
  }
  function flash(m, kind, ms) { S.flashes.set(m, { kind, until: performance.now() + (ms || 320) }); }

  // ---------- Microphone pitch detection (YIN) ----------
  const mic = { on: false, an: null, buf: null, d: null, stream: null, cand: null, candN: 0, last: null, armed: true, prevRms: 0, quiet: 0, nextAt: 0 };

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
      mic.on = false; $('micBtn').classList.remove('on'); $('micBtn').textContent = 'Use microphone'; $('micInfo').textContent = ''; $('micLevel').hidden = true;
      return;
    }
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
      const a = audio();
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      mic.an = a.createAnalyser(); mic.an.fftSize = 4096;
      a.createMediaStreamSource(mic.stream).connect(mic.an);
      mic.buf = new Float32Array(4096); mic.d = new Float32Array(2049);
      mic.on = true; mic.last = null; mic.armed = true;
      $('micBtn').classList.add('on'); $('micBtn').textContent = 'Microphone on';
      $('micInfo').textContent = 'Listening for your piano';
      $('micLevel').hidden = false;
    } catch (e) {
      $('micInfo').textContent = e.message === 'unsupported'
        ? 'This browser cannot use the microphone here. Open the app over https in Safari.'
        : 'Microphone blocked. Allow it in your browser settings, then try again.';
    }
  }

  function micTick(now) {
    if (!mic.on || now < mic.nextAt) return;
    mic.nextAt = now + 45;
    mic.an.getFloatTimeDomainData(mic.buf);
    let e = 0;
    for (let i = 0; i < mic.buf.length; i += 2) e += mic.buf[i] * mic.buf[i];
    const rms = Math.sqrt(e / (mic.buf.length / 2));
    $('micLevel').firstElementChild.style.width = Math.min(100, Math.round(rms * 500)) + '%';
    if (now < S.muteMicUntil) { mic.cand = null; mic.prevRms = rms; return; }
    if (rms < 0.012) {
      if (++mic.quiet > 3) { mic.last = null; mic.armed = true; }
      mic.cand = null; mic.prevRms = rms;
      if (mic.quiet === 12) $('micInfo').textContent = 'Listening for your piano';
      return;
    }
    mic.quiet = 0;
    if (rms > mic.prevRms * 1.5 && rms > 0.02) mic.armed = true; // a fresh attack lets the same note count again
    mic.prevRms = mic.prevRms * 0.5 + rms * 0.5;
    const f = yin(mic.buf, ac.sampleRate);
    if (!f) { mic.cand = null; return; }
    const m = Math.round(69 + 12 * Math.log2(f / 440));
    if (m === mic.cand) mic.candN++; else { mic.cand = m; mic.candN = 1; }
    // A right note counts quickly; a wrong one has to hold steady longer, so stray sounds are not marked as mistakes.
    const learning = S.mode === 'learn' && !S.finished;
    const need = learning && !findMatch(m, 'mic') ? 4 : 2;
    if (mic.candN >= need && (m !== mic.last || mic.armed)) {
      mic.last = m; mic.armed = false;
      $('micInfo').textContent = 'Heard ' + noteName(m);
      noteInput(m, 'mic');
    }
  }

  // ---------- MIDI keyboard (browsers that support Web MIDI) ----------
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(acc => {
      const hook = () => {
        let n = 0;
        acc.inputs.forEach(inp => { n++; inp.onmidimessage = ev => { const [s, note, vel] = ev.data; if ((s & 0xf0) === 0x90 && vel > 0) noteInput(note, 'midi'); }; });
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
    ctx.fillStyle = COL.lane; ctx.fillRect(0, 0, W, H);
    // octave guides and bar lines
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1; ctx.beginPath();
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
      rr(x, yt, w, h, 5); ctx.fill();
      const showFinger = opts.fingers && n.f && active;
      if (opts.names || showFinger) {
        const label = showFinger ? String(n.f) : NAMES[n.m % 12].replace('#', '\u266f');
        ctx.fillStyle = '#1a1405'; ctx.font = '700 ' + Math.min(13, w * (label.length > 1 ? 0.6 : 0.75)) + 'px sans-serif';
        ctx.fillText(label, x + w / 2, yb - 9);
      }
      ctx.globalAlpha = 1;
    }
    // keyboard
    ctx.fillStyle = COL.bg; ctx.fillRect(0, hitY, W, H - hitY);
    const targets = new Map();
    if (S.mode === 'learn' && !S.finished) step.notes.forEach(n => { if (!S.hit.has(n.m)) targets.set(n.m, n.h); });
    const fillFor = k => {
      const f = S.flashes.get(k.m);
      if (f) { if (f.until > now) return COL[f.kind]; S.flashes.delete(k.m); }
      if (targets.has(k.m)) return COL[targets.get(k.m)];
      return k.black ? COL.black : COL.white;
    };
    for (const pass of [false, true]) {
      for (const k of S.keys) {
        if (k.black !== pass) continue;
        ctx.fillStyle = fillFor(k);
        rr(k.x + 0.5, hitY + 1, k.w - 1, k.h - 2, k.black ? 3 : 5); ctx.fill();
        const lit = targets.has(k.m) || S.flashes.has(k.m);
        if (opts.names && (lit || (!k.black && k.m % 12 === 0)) && k.w >= 11) {
          ctx.fillStyle = k.black && !lit ? COL.dim : '#1a1405';
          ctx.font = (lit ? '700 ' : '500 ') + Math.min(13, k.w * 0.55) + 'px sans-serif';
          ctx.fillText(lit ? NAMES[k.m % 12] : noteName(k.m), k.x + k.w / 2, hitY + k.h - 14);
        }
      }
    }
    ctx.fillStyle = COL.R; ctx.fillRect(0, hitY - 2, W, 2);
  }

  let lastT = 0;
  function frame(now) {
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
      } else {
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
    const sm = document.createElement('small'); sm.textContent = st && st.best != null ? 'best ' + st.best + '%' : 'change';
    $('songBtn').append(sm);
    $('scrub').max = S.steps.length - 1; $('scrub').value = S.idx;
    const looping = S.loopA != null || S.loopB != null;
    $('loopClear').hidden = !looping;
    $('loopInfo').textContent = looping ? `Loop: notes ${(S.loopA || 0) + 1}–${(S.loopB != null ? S.loopB : S.steps.length - 1) + 1}` : '';
    $('modeLearn').classList.toggle('on', S.mode === 'learn');
    $('modeListen').classList.toggle('on', S.mode === 'listen');
    $('playBtn').hidden = S.mode !== 'listen'; $('playBtn').textContent = S.playing ? 'Pause' : 'Play';
    $('playBtn').classList.toggle('primary', !S.playing);
    $('hearBtn').hidden = S.mode !== 'learn';
    $('speed').hidden = S.mode !== 'listen';
  }

  function setMode(mode) {
    S.mode = mode; S.playing = false; S.finished = false; S.hit.clear();
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
    S.hit.clear(); S.misses = []; S.finished = false;
    prompt(); updateUI();
  };
  $('speed').onchange = e => { S.tempo = +e.target.value; };
  $('scrub').oninput = e => {
    S.idx = +e.target.value; S.hit.clear(); S.finished = false;
    if (S.mode === 'listen') { S.view = S.steps[S.idx].t - 0.001; seekListen(); }
    prompt(); updateUI();
  };
  $('loopA').onclick = () => { S.loopA = S.idx; if (S.loopB != null && S.loopB < S.loopA) S.loopB = null; updateUI(); };
  $('loopB').onclick = () => { S.loopB = S.idx; if (S.loopA == null || S.loopA > S.loopB) S.loopA = 0; S.idx = S.loopA; S.hit.clear(); if (S.mode === 'listen') { S.view = S.steps[S.idx].t - 1; seekListen(); } prompt(); updateUI(); };
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
  window.__pm = { S, noteInput, yin, mic }; // handy for debugging from the console
})();
