// Song format used by the app:
// { title, bpm, barLen, pickup, notes: [{ m: midiNumber, t: startBeat, d: lengthBeats, h: 'R' | 'L' }] }
(function () {
  const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const TONIC_SHARPS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
  const MODE_SHIFT = { maj: 0, ion: 0, mix: -1, dor: -2, min: -3, aeo: -3, m: -3, phr: -4, loc: -5, lyd: 1 };

  function keySignature(k) {
    const m = /^\s*([A-G][#b]?)\s*([A-Za-z]*)/.exec(k || 'C');
    const sig = {};
    if (!m) return sig;
    const mode = m[2].toLowerCase();
    const shift = mode === 'm' ? -3 : (MODE_SHIFT[mode.slice(0, 3)] || 0);
    const n = (TONIC_SHARPS[m[1]] || 0) + shift;
    'FCGDAEB'.split('').slice(0, Math.max(0, n)).forEach(l => (sig[l] = 1));
    'BEADGCF'.split('').slice(0, Math.max(0, -n)).forEach(l => (sig[l] = -1));
    return sig;
  }

  function frac(s, dflt) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(s);
    return m ? m[1] / m[2] : dflt;
  }

  function len(num, slash) {
    let v = num ? parseInt(num, 10) : 1;
    if (slash) {
      const d = slash.replace(/\//g, '');
      v /= d ? parseInt(d, 10) : Math.pow(2, slash.length);
    }
    return v;
  }

  function parseAbc(text) {
    const song = { title: 'Untitled', bpm: 100, barLen: 4, pickup: 0, notes: [] };
    let unit = 0.5, sig = {}, inBody = false, firstBar = null;
    const voices = {}, order = [];
    let v = null;
    const voice = id => {
      if (!voices[id]) { voices[id] = { idx: order.length, t: 0, acc: {}, last: [], tie: false, tuplet: 0, tf: 1, broken: 1 }; order.push(id); }
      v = voices[id];
    };
    const NOTE = /^(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)(\d*)(\/+\d*)?/;

    function pitch(m) {
      const L = m[2].toUpperCase();
      let p = (m[2] === L ? 60 : 72) + BASE[L];
      for (const c of m[3]) p += c === ',' ? -12 : 12;
      const key = m[2] + m[3];
      if (m[1]) v.acc[key] = { '^': 1, '^^': 2, _: -1, __: -2, '=': 0 }[m[1]];
      return p + (key in v.acc ? v.acc[key] : (sig[L] || 0));
    }

    function emit(pitches, units) {
      let d = units * unit * v.broken;
      v.broken = 1;
      if (v.tuplet > 0) { d *= v.tf; v.tuplet--; }
      const made = [];
      for (const p of pitches) {
        const tied = v.tie && v.last.find(n => n.m === p);
        if (tied) { tied.d += d; made.push(tied); }
        else {
          const n = { m: p, t: v.t, d, h: 'R', v: v.idx };
          song.notes.push(n); made.push(n);
        }
      }
      if (pitches.length) { v.last = made; v.tie = false; }
      v.t += d;
    }

    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/%.*$/, '').trim();
      if (!line) continue;
      const h = /^([A-Za-z]):\s*(.*)$/.exec(line);
      if (h) {
        const [, f, val] = h;
        if (f === 'T' && !inBody && song.title === 'Untitled') song.title = val.trim();
        else if (f === 'M') { const c = /^C/.test(val) ? 1 : frac(val, 1); song.barLen = c * 4; }
        else if (f === 'L') unit = frac(val, 1 / 8) * 4;
        else if (f === 'Q') {
          const q = /(\d+)\s*\/\s*(\d+)\s*=\s*(\d+)/.exec(val);
          if (q) song.bpm = Math.round(q[3] * (q[1] / q[2]) * 4);
          else if (/\d+/.test(val)) song.bpm = parseInt(/\d+/.exec(val)[0], 10);
        }
        else if (f === 'K') { sig = keySignature(val); inBody = true; }
        else if (f === 'V' && inBody) voice(val.trim().split(/\s+/)[0]);
        continue;
      }
      if (!inBody) continue;
      if (!v) voice('1');
      let s = line;
      while (s.length) {
        let m;
        if ((m = /^"[^"]*"/.exec(s)) || (m = /^![^!]*!/.exec(s)) || (m = /^\{[^}]*\}/.exec(s)) || (m = /^\[[A-Za-z]:[^\]]*\]/.exec(s))) {
          const iv = /^\[V:\s*([^\]\s]+)/.exec(m[0]);
          if (iv) voice(iv[1]);
          s = s.slice(m[0].length);
        } else if ((m = /^\((\d)/.exec(s))) {
          const p = +m[1];
          v.tuplet = p; v.tf = ({ 2: 3, 3: 2, 4: 3, 6: 2 }[p] || 2) / p;
          s = s.slice(2);
        } else if (s[0] === '[' && /^\[(\^|_|=)*[A-Ga-g]/.test(s)) {
          const end = s.indexOf(']');
          let inner = s.slice(1, end), ps = [], units = 1, first = true, im;
          while (inner.length) {
            if ((im = NOTE.exec(inner))) {
              ps.push(pitch(im));
              if (first) { units = len(im[4], im[5]); first = false; }
              inner = inner.slice(im[0].length);
            } else inner = inner.slice(1);
          }
          s = s.slice(end + 1);
          const lm = /^(\d*)(\/+\d*)?/.exec(s);
          if (lm[0]) { units *= len(lm[1], lm[2]); s = s.slice(lm[0].length); }
          emit(ps, units);
        } else if ((m = NOTE.exec(s))) {
          emit([pitch(m)], len(m[4], m[5]));
          s = s.slice(m[0].length);
        } else if ((m = /^[zx](\d*)(\/+\d*)?/.exec(s))) {
          emit([], len(m[1], m[2]));
          s = s.slice(m[0].length);
        } else if (s[0] === '-') { v.tie = true; s = s.slice(1); }
        else if (s[0] === '>' || s[0] === '<') {
          const up = s[0] === '>' ? 1.5 : 0.5;
          const base = v.last.length ? v.last[0].d : 0;
          v.last.forEach(n => (n.d = base * up));
          v.t += base * (up - 1);
          v.broken = 2 - up;
          s = s.slice(1);
        } else if (s[0] === '|') {
          if (firstBar === null) firstBar = v.t;
          v.acc = {};
          s = s.slice(1);
        } else s = s.slice(1);
      }
    }
    if (firstBar !== null && firstBar > 0 && firstBar < song.barLen - 1e-6) song.pickup = firstBar;
    song.notes.forEach(n => { n.h = n.v > 0 ? 'L' : 'R'; delete n.v; });
    song.notes.sort((a, b) => a.t - b.t || a.m - b.m);
    if (!song.notes.length) throw new Error('No notes found. Is this ABC notation?');
    return song;
  }

  function parseMidi(arrayBuffer, fallbackTitle) {
    const d = new DataView(arrayBuffer);
    let p = 0;
    const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p++)); return s; };
    const u32 = () => { const x = d.getUint32(p); p += 4; return x; };
    const u16 = () => { const x = d.getUint16(p); p += 2; return x; };
    const vlq = () => { let x = 0, b; do { b = d.getUint8(p++); x = (x << 7) | (b & 127); } while (b & 128); return x; };
    if (str(4) !== 'MThd') throw new Error('Not a MIDI file.');
    const hl = u32(); u16(); const ntr = u16(); const div = u16(); p += hl - 6;
    if (div & 0x8000) throw new Error('This MIDI file uses a timing format the app does not support.');
    const song = { title: fallbackTitle || 'Imported song', bpm: 0, barLen: 4, pickup: 0, notes: [] };
    const tracks = [];
    for (let tr = 0; tr < ntr && p < d.byteLength; tr++) {
      if (str(4) !== 'MTrk') break;
      const end = u32() + p;
      let tick = 0, status = 0;
      const open = {}, notes = [];
      while (p < end) {
        tick += vlq();
        let b = d.getUint8(p);
        if (b & 128) { status = b; p++; }
        if (status === 0xff) {
          const type = d.getUint8(p++), l = vlq();
          if (type === 0x51 && !song.bpm) song.bpm = Math.round(6e7 / ((d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2)));
          if (type === 0x58 && tick === 0) song.barLen = d.getUint8(p) * 4 / Math.pow(2, d.getUint8(p + 1));
          p += l;
        } else if (status === 0xf0 || status === 0xf7) { p += vlq(); }
        else {
          const hi = status & 0xf0, ch = status & 15;
          const a = d.getUint8(p++);
          const c = (hi === 0xc0 || hi === 0xd0) ? 0 : d.getUint8(p++);
          if (ch === 9) continue;
          if (hi === 0x90 && c > 0) {
            const n = { m: a, t: tick / div, d: 0.25, h: 'R' };
            open[a] = n; notes.push(n);
          } else if (hi === 0x80 || hi === 0x90) {
            if (open[a]) { open[a].d = Math.max(0.05, tick / div - open[a].t); delete open[a]; }
          }
        }
      }
      p = end;
      if (notes.length) tracks.push(notes);
    }
    if (!tracks.length) throw new Error('No notes found in this MIDI file.');
    if (tracks.length === 1) {
      const lo = Math.min(...tracks[0].map(n => n.m));
      tracks[0].forEach(n => (n.h = lo < 55 && n.m < 60 ? 'L' : 'R'));
    } else tracks.forEach((ns, i) => ns.forEach(n => (n.h = i === 0 ? 'R' : 'L')));
    song.notes = [].concat(...tracks).sort((a, b) => a.t - b.t || a.m - b.m);
    const t0 = song.notes[0].t, shift = Math.floor(t0 / song.barLen) * song.barLen;
    song.notes.forEach(n => (n.t -= shift));
    if (!song.bpm) song.bpm = 100;
    return song;
  }

  window.Parsers = { parseAbc, parseMidi };
})();
