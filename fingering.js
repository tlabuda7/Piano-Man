// Suggests a finger (1 = thumb … 5 = little finger) for every note.
// It scores each possible finger for each note by standard piano habits and picks the cheapest path:
// neighbouring keys use neighbouring fingers, stretches stay within a comfortable hand span,
// the only crossings are thumb-under / finger-over-thumb, and the thumb avoids black keys.
(function () {
  // Comfortable distance in semitones between two fingers, [min, max].
  const SPAN = { 12: [1, 5], 13: [3, 7], 14: [5, 9], 15: [6, 11], 23: [1, 3], 24: [3, 5], 25: [5, 8], 34: [1, 2], 35: [3, 5], 45: [1, 3] };
  const black = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

  // d: distance moved toward the little-finger side (the left hand is mirrored).
  function move(d, f, g) {
    const c = reach(d, f, g);
    // A leap of a fourth or more can always be played by lifting and moving the whole hand.
    return Math.abs(d) >= 5 ? Math.min(c, 6 + (f === g ? 1 : 0)) : c;
  }
  function reach(d, f, g) {
    if (d === 0) return f === g ? 0 : 1.5;
    if (f === g) return 4 + Math.abs(d);
    const up = d > 0, lo = Math.min(f, g), hi = Math.max(f, g), ad = Math.abs(d);
    if ((g > f) === up) {
      const [mn, mx] = SPAN['' + lo + hi];
      if (ad < mn) return (mn - ad) * 2;
      if (ad > mx) return (ad - mx) * 2 + (ad - mx > 3 ? 20 : 0);
      return 0;
    }
    if (lo === 1 && hi <= 4 && ad <= 3 && ((up && g === 1) || (!up && f === 1))) return 2.5 + (hi === 4 ? 0.5 : 0) + (ad > 2 ? 1 : 0);
    return 30;
  }
  const rest = (g, m) => (black(m) ? (g === 1 ? 2 : g === 5 ? 1 : 0) : 0) + (g === 4 ? 0.2 : g === 5 ? 0.1 : 0);

  function chordFingers(span, k) {
    if (k === 2) return span >= 8 ? [1, 5] : span >= 5 ? [1, 4] : span >= 3 ? [1, 3] : [1, 2];
    if (k === 3) return [1, 3, 5];
    if (k === 4) return [1, 2, 3, 5];
    return [1, 2, 3, 4, 5];
  }

  window.assignFingering = function (song) {
    for (const hand of ['R', 'L']) {
      const sign = hand === 'R' ? 1 : -1;
      const groups = [];
      for (const n of song.notes) {
        if (n.h !== hand) continue;
        const g = groups[groups.length - 1];
        if (g && Math.abs(g.t - n.t) < 0.06) g.notes.push(n); else groups.push({ t: n.t, notes: [n] });
      }
      if (!groups.length) continue;
      // Each group is led by its outermost note (top for the right hand, bottom for the left).
      groups.forEach(g => {
        g.notes.sort((a, b) => sign * (a.m - b.m));
        g.lead = g.notes[g.notes.length - 1];
        g.end = Math.max(...g.notes.map(n => n.t + n.d));
        if (g.notes.length > 1) {
          const fs = chordFingers(Math.abs(g.lead.m - g.notes[0].m), Math.min(5, g.notes.length));
          g.notes.slice(-5).forEach((n, i) => (n.f = fs[i]));
          g.forced = fs[fs.length - 1];
        }
      });
      const N = groups.length, cost = [], back = [];
      for (let i = 0; i < N; i++) {
        cost.push([]); back.push([]);
        const g = groups[i], prev = groups[i - 1];
        for (let f = 1; f <= 5; f++) {
          let best = 0, from = 0;
          if (i > 0) {
            best = Infinity;
            const free = g.t - prev.end >= 2; // a long rest lets the hand move anywhere
            for (let pf = 1; pf <= 5; pf++) {
              const c = cost[i - 1][pf] + (free ? 0 : move(sign * (g.lead.m - prev.lead.m), pf, f));
              if (c < best) { best = c; from = pf; }
            }
          }
          cost[i][f] = best + rest(f, g.lead.m) + (g.forced && g.forced !== f ? 1000 : 0);
          back[i][f] = from;
        }
      }
      let f = 1;
      for (let x = 2; x <= 5; x++) if (cost[N - 1][x] < cost[N - 1][f]) f = x;
      for (let i = N - 1; i >= 0; i--) { groups[i].lead.f = f; f = back[i][f]; }
    }
    return song;
  };
})();
