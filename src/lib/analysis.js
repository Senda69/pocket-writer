// Mumble analysis: turns a recording into lines of syllables with
// timing, stress, pitch and a vowel-sound guess. Pure JS, no dependencies,
// so it runs in the app window and in Node tests.
(function (root) {
  'use strict';

  const SR = 16000; // analysis sample rate
  const HOP = 160; // 10 ms
  const WIN = 512; // 32 ms

  // ---------- helpers ----------
  function resample(input, fromRate, toRate) {
    if (fromRate === toRate) return Float32Array.from(input);
    const ratio = fromRate / toRate;
    const n = Math.floor(input.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let j = start; j < end; j++) s += input[j];
      out[i] = s / Math.max(1, end - start);
    }
    return out;
  }

  // RBJ biquad band-pass, run in place on a copy.
  function bandpass(x, sr, f0, q) {
    const w0 = (2 * Math.PI * f0) / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0, b2 = -alpha / a0;
    const a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const percentile = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
  };
  const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))) || 1; };

  function smooth(arr, radius) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, n = 0;
      for (let j = i - radius; j <= i + radius; j++) if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
      out[i] = s / n;
    }
    return out;
  }

  // ---------- pitch (YIN) ----------
  function yin(frame, sr, fmin = 70, fmax = 1000, threshold = 0.15) {
    const tauMin = Math.floor(sr / fmax), tauMax = Math.min(Math.floor(sr / fmin), frame.length >> 1);
    const d = new Float32Array(tauMax + 1);
    const W = frame.length - tauMax;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) { const v = frame[i] - frame[i + tau]; s += v * v; }
      d[tau] = s;
    }
    let running = 0;
    const cmnd = new Float32Array(tauMax + 1); cmnd[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { running += d[tau]; cmnd[tau] = running ? (d[tau] * tau) / running : 1; }
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        best = tau; break;
      }
    }
    if (best < 0) return null;
    // parabolic interpolation
    const a = cmnd[best - 1] ?? cmnd[best], b = cmnd[best], c = cmnd[best + 1] ?? cmnd[best];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    return { f0: sr / (best + (Number.isFinite(shift) ? shift : 0)), clarity: 1 - b };
  }

  const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const midiToName = (m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

  // ---------- formants via LPC envelope ----------
  function lpc(frame, order) {
    const r = new Float64Array(order + 1);
    for (let k = 0; k <= order; k++) { let s = 0; for (let i = k; i < frame.length; i++) s += frame[i] * frame[i - k]; r[k] = s; }
    if (r[0] <= 0) return null;
    r[0] *= 1.0001;
    const a = new Float64Array(order + 1); a[0] = 1;
    let e = r[0];
    for (let i = 1; i <= order; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k = -acc / e;
      const prev = a.slice();
      for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
      a[i] = k;
      e *= 1 - k * k;
      if (e <= 0) return null;
    }
    return a;
  }

  function formants(frame, sr) {
    // pre-emphasis + Hamming
    const x = new Float64Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] - 0.95 * (i ? frame[i - 1] : 0);
      x[i] = v * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (frame.length - 1)));
    }
    const a = lpc(x, 12);
    if (!a) return null;
    const step = 10, peaks = [];
    let prev2 = -Infinity, prev1 = -Infinity;
    for (let f = 150; f <= 3500; f += step) {
      const w = (2 * Math.PI * f) / sr;
      let re = 0, im = 0;
      for (let k = 0; k < a.length; k++) { re += a[k] * Math.cos(-w * k); im += a[k] * Math.sin(-w * k); }
      const mag = -10 * Math.log10(re * re + im * im + 1e-12);
      if (prev1 > prev2 && prev1 > mag) peaks.push(f - step);
      prev2 = prev1; prev1 = mag;
    }
    const f1 = peaks.find((f) => f >= 220 && f <= 1100);
    if (!f1) return null;
    const f2 = peaks.find((f) => f > f1 + 250 && f <= 3200);
    if (!f2) return null;
    return { f1, f2 };
  }

  // Reference vowel formants (rough averages across voices), ARPAbet label + sung spelling.
  const VOWEL_REF = [
    { v: 'IY', say: 'ee', f1: 310, f2: 2500 },
    { v: 'IH', say: 'ih', f1: 430, f2: 2100 },
    { v: 'EY', say: 'ay', f1: 480, f2: 2250 },
    { v: 'EH', say: 'eh', f1: 600, f2: 1950 },
    { v: 'AE', say: 'a', f1: 760, f2: 1850 },
    { v: 'AH', say: 'uh', f1: 650, f2: 1350 },
    { v: 'AA', say: 'ah', f1: 800, f2: 1250 },
    { v: 'AO', say: 'aw', f1: 650, f2: 1000 },
    { v: 'OW', say: 'oh', f1: 500, f2: 950 },
    { v: 'UH', say: 'oo', f1: 470, f2: 1200 },
    { v: 'UW', say: 'oo', f1: 350, f2: 1000 },
    { v: 'ER', say: 'er', f1: 500, f2: 1450 },
  ];

  function guessVowel(fm) {
    if (!fm) return null;
    let best = null, second = null;
    for (const r of VOWEL_REF) {
      const d = Math.hypot(Math.log(fm.f1 / r.f1) * 1.4, Math.log(fm.f2 / r.f2));
      if (!best || d < best.d) { second = best; best = { ...r, d }; } else if (!second || d < second.d) second = { ...r, d };
    }
    const confidence = Math.max(0, Math.min(1, 1 - best.d / 0.45)) * (second ? Math.min(1, (second.d - best.d) / 0.1 + 0.4) : 1);
    return { vowel: best.v, say: best.say, f1: fm.f1, f2: fm.f2, confidence: +confidence.toFixed(2) };
  }

  // ---------- main ----------
  /**
   * analyze(samples, sampleRate, opts) -> { duration, sections:[{lines:[{start,end,syllables:[...], pattern}]}] }
   */
  function analyze(samples, sampleRate, opts = {}) {
    const lineGap = opts.lineGap ?? 0.45; // silence (s) that ends a line
    const sectionGap = opts.sectionGap ?? 2.0; // silence (s) that ends a section
    const x = resample(samples, sampleRate, SR);
    const duration = x.length / SR;
    const voiceBand = bandpass(x, SR, 900, 0.6); // emphasise vowel energy over hiss/plosives
    const nFrames = Math.max(0, Math.floor((x.length - WIN) / HOP) + 1);
    if (nFrames < 5) return { duration, sections: [], frames: { rmsDb: [], hop: HOP / SR } };

    const rms = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      let s = 0;
      const o = f * HOP;
      for (let i = 0; i < WIN; i++) s += voiceBand[o + i] ** 2;
      rms[f] = Math.sqrt(s / WIN);
    }
    const env = smooth(rms, 3); // ~70 ms smoothing
    const db = Array.from(env, (v) => 20 * Math.log10(v + 1e-7));
    const floor = percentile(db, 10), top = percentile(db, 97);
    const gate = floor + Math.max(6, 0.3 * (top - floor));

    // Voiced regions -> phrases
    const regions = [];
    let start = -1;
    for (let f = 0; f <= nFrames; f++) {
      const on = f < nFrames && db[f] > gate;
      if (on && start < 0) start = f;
      if (!on && start >= 0) { regions.push([start, f - 1]); start = -1; }
    }
    const t = (f) => (f * HOP + WIN / 2) / SR;
    const merged = [];
    for (const r of regions) {
      const last = merged[merged.length - 1];
      if (last && t(r[0]) - t(last[1]) < lineGap) last[1] = r[1];
      else merged.push([...r]);
    }
    const phrases = merged.filter(([a, b]) => t(b) - t(a) >= 0.12);

    // Syllables inside a phrase: envelope peaks with enough dip between them.
    const lines = [];
    for (const [a, b] of phrases) {
      const peaks = [];
      for (let f = a + 1; f < b; f++) if (env[f] >= env[f - 1] && env[f] > env[f + 1] && db[f] > gate) peaks.push(f);
      if (!peaks.length) peaks.push(a + ((b - a) >> 1));
      // merge peaks closer than 100 ms or without a 2 dB valley between them
      const kept = [peaks[0]];
      for (let i = 1; i < peaks.length; i++) {
        const p = peaks[i], q = kept[kept.length - 1];
        let minDb = Infinity;
        for (let f = q; f <= p; f++) minDb = Math.min(minDb, db[f]);
        const dip = Math.min(db[p], db[q]) - minDb;
        if ((p - q) * HOP / SR < 0.1 || dip < 2) { if (db[p] > db[q]) kept[kept.length - 1] = p; }
        else kept.push(p);
      }
      // boundaries at valleys
      const bounds = [a];
      for (let i = 1; i < kept.length; i++) {
        let mf = kept[i - 1];
        for (let f = kept[i - 1]; f <= kept[i]; f++) if (env[f] < env[mf]) mf = f;
        bounds.push(mf);
      }
      bounds.push(b);

      const syls = kept.map((pk, i) => {
        const s0 = bounds[i], s1 = bounds[i + 1];
        // pitch: median over the middle of the syllable
        const pitches = [];
        const m0 = Math.round(s0 + (s1 - s0) * 0.2), m1 = Math.round(s0 + (s1 - s0) * 0.8);
        for (let f = m0; f <= m1; f += 2) {
          const o = f * HOP;
          if (o + 1024 > x.length) break;
          const r = yin(x.subarray(o, o + 1024), SR);
          if (r && r.clarity > 0.6) pitches.push(r.f0);
        }
        const hz = median(pitches);
        // vowel: formants around the energy peak
        const o = Math.max(0, pk * HOP - 128);
        const fm = formants(x.subarray(o, Math.min(x.length, o + 512)), SR);
        return {
          start: +t(s0).toFixed(3),
          end: +t(s1).toFixed(3),
          peak: +t(pk).toFixed(3),
          loudness: +db[pk].toFixed(1),
          pitchHz: hz ? +hz.toFixed(1) : null,
          note: hz ? midiToName(hzToMidi(hz)) : null,
          midi: hz ? +hzToMidi(hz).toFixed(2) : null,
          vowel: guessVowel(fm),
        };
      });

      // Stress: loudness + length + pitch, relative to the rest of the line.
      const L = syls.map((s) => s.loudness), D = syls.map((s) => s.end - s.start);
      const P = syls.map((s) => s.midi ?? mean(syls.filter((q) => q.midi).map((q) => q.midi)) ?? 0);
      const mL = mean(L), sL = std(L), mD = mean(D), sD = std(D), mP = mean(P), sP = std(P);
      syls.forEach((s, i) => {
        s.weight = +(0.55 * ((L[i] - mL) / sL) + 0.3 * ((D[i] - mD) / sD) + 0.15 * ((P[i] - mP) / sP)).toFixed(2);
      });
      syls.forEach((s, i) => {
        const prev = syls[i - 1]?.weight ?? -Infinity, next = syls[i + 1]?.weight ?? -Infinity;
        s.stressed = syls.length === 1 || s.weight > 0.35 || (s.weight > -0.1 && s.weight >= prev && s.weight >= next);
      });
      if (!syls.some((s) => s.stressed)) syls.reduce((m, s) => (s.weight > m.weight ? s : m)).stressed = true;

      lines.push({
        start: syls[0].start,
        end: syls[syls.length - 1].end,
        syllables: syls,
        pattern: syls.map((s) => (s.stressed ? '1' : '0')).join(''),
        endVowel: syls[syls.length - 1].vowel,
      });
    }

    // Group lines into sections by long silences.
    const sections = [];
    for (const ln of lines) {
      const cur = sections[sections.length - 1];
      if (!cur || ln.start - cur.lines[cur.lines.length - 1].end >= sectionGap) sections.push({ lines: [ln] });
      else cur.lines.push(ln);
    }
    labelSections(sections);
    return { duration: +duration.toFixed(2), sections, frames: { rmsDb: db.map((v) => +v.toFixed(1)), hop: HOP / SR, gate } };
  }

  // Melodic contour of a line, as semitone steps between syllables (null-safe).
  function contour(line) {
    const m = line.syllables.map((s) => s.midi).filter((v) => v != null);
    return m.slice(1).map((v, i) => Math.sign(Math.round(v - m[i])));
  }

  function lineSimilarity(a, b) {
    const sylSim = 1 - Math.min(1, Math.abs(a.syllables.length - b.syllables.length) / Math.max(a.syllables.length, b.syllables.length));
    const ca = contour(a), cb = contour(b);
    const n = Math.min(ca.length, cb.length);
    let agree = 0;
    for (let i = 0; i < n; i++) if (ca[i] === cb[i]) agree++;
    const contourSim = n ? agree / Math.max(ca.length, cb.length) : 0.5;
    return 0.5 * sylSim + 0.5 * contourSim;
  }

  function sectionSimilarity(a, b) {
    const n = Math.min(a.lines.length, b.lines.length);
    if (!n) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) s += lineSimilarity(a.lines[i], b.lines[i]);
    return (s / n) * (n / Math.max(a.lines.length, b.lines.length));
  }

  const sectionPitch = (s) => mean(s.lines.flatMap((l) => l.syllables.map((q) => q.midi)).filter((v) => v != null));

  // Cluster sections by melody. The first cluster is the verse melody; the
  // biggest other repeated cluster (ties: higher pitch) is the chorus; one-off
  // sections later in the song are bridges.
  function labelSections(sections) {
    if (!sections.length) return sections;
    const clusters = [];
    sections.forEach((s, i) => {
      let best = null, bestSim = 0;
      for (const c of clusters) {
        const sim = sectionSimilarity(s, sections[c.members[0]]) - Math.min(0.3, Math.abs(sectionPitch(s) - c.pitch) / 20);
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      if (best && bestSim >= 0.7) best.members.push(i);
      else clusters.push({ members: [i], pitch: sectionPitch(s) || 0 });
    });
    const verse = clusters[0];
    const others = clusters.slice(1).filter((c) => c.members.length > 1)
      .sort((a, b) => b.members.length - a.members.length || b.pitch - a.pitch);
    const chorus = others[0] || null;
    let v = 0;
    clusters.forEach((c) => c.members.forEach((i) => {
      const s = sections[i];
      s.melodyGroup = clusters.indexOf(c);
      if (c === chorus) s.label = 'Chorus';
      else if (c === verse) s.label = `Verse ${++v}`;
      else if (c.members.length === 1 && i > 1) s.label = 'Bridge';
      else s.label = `Verse ${++v}`;
    }));
    // renumber verses in time order
    let n = 0;
    sections.forEach((s) => { if (s.label.startsWith('Verse')) s.label = `Verse ${++n}`; });
    return sections;
  }

  const api = { analyze, labelSections, lineSimilarity, yin, formants, guessVowel, midiToName, hzToMidi };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MumbleAnalysis = api;
})(typeof self !== 'undefined' ? self : this);
