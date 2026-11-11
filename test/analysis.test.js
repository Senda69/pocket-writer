// Synthesises "da-DUM" style mumbles (pulse train through formant filters)
// and checks the analyzer recovers syllable counts, stress and vowels.
const A = require('../src/lib/analysis');
const assert = require('assert');
const SR = 44100;
const FORM = { ah: [800, 1250], ee: [310, 2500], oo: [350, 1000], eh: [600, 1950], oh: [500, 950] };

function resonate(x, f, bw) {
  const r = Math.exp(-Math.PI * bw / SR), th = 2 * Math.PI * f / SR;
  const a1 = -2 * r * Math.cos(th), a2 = r * r, g = 1 + a1 + a2;
  const y = new Float32Array(x.length); let y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = g * x[i] - a1 * y1 - a2 * y2; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function syllable(dur, f0, vowel, amp) {
  const n = Math.floor(dur * SR), src = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { ph += f0 / SR; if (ph >= 1) { ph -= 1; src[i] = 1; } }
  // cascade formant filters, like a vocal tract
  const y = resonate(resonate(resonate(src, FORM[vowel][0], 80), FORM[vowel][1], 100), 2900, 150);
  let peak = 0; for (const v of y) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) {
    const env = Math.sin(Math.PI * Math.min(1, i / (n * 0.9))) ** 0.6;
    y[i] = (y[i] / peak) * env * amp;
  }
  return y;
}
function song(lines, gap) {
  const parts = [new Float32Array(SR * 0.3)];
  for (const ln of lines) {
    for (const [stress, vowel, f0] of ln) {
      parts.push(syllable(stress ? 0.32 : 0.18, f0, vowel, stress ? 1 : 0.35));
      parts.push(new Float32Array(Math.floor(SR * 0.03)));
    }
    parts.push(new Float32Array(Math.floor(SR * gap)));
  }
  const len = parts.reduce((s, p) => s + p.length, 0), out = new Float32Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  for (let i = 0; i < len; i++) out[i] = out[i] * 0.3 + (Math.random() - 0.5) * 0.002;
  return out;
}

const line1 = [[0, 'ah', 200], [1, 'ee', 220], [0, 'ah', 200], [1, 'oo', 247], [0, 'ah', 220], [1, 'eh', 196]];
const line2 = [[1, 'ah', 262], [0, 'ah', 247], [1, 'ee', 220], [0, 'oo', 196]];
const res = A.analyze(song([line1, line2], 0.8), SR);
const lines = res.sections.flatMap((s) => s.lines);
for (const l of lines) console.log(l.pattern, l.syllables.map((s) => `${s.vowel?.say ?? '?'}@${s.note ?? '-'}`).join(' '));
assert.strictEqual(lines.length, 2, 'two lines');
assert.strictEqual(lines[0].syllables.length, 6);
assert.strictEqual(lines[1].syllables.length, 4);
assert.strictEqual(lines[0].pattern, '010101');
assert.strictEqual(lines[1].pattern, '1010');
const vowelsOk = lines.flatMap((l, li) => l.syllables.map((s, i) => s.vowel?.say === [line1, line2][li][i][1].replace('oo', 'oo'))).filter(Boolean).length;
console.log(`vowels right: ${vowelsOk}/10`);
assert.ok(vowelsOk >= 7, 'most vowels recognised');

// Sections: verse / chorus / verse / chorus detection
const chorus = [[1, 'oh', 330], [1, 'oh', 294], [0, 'ah', 262], [1, 'ee', 330]];
const verse2 = [[0, 'eh', 196], [1, 'ah', 247], [0, 'ee', 196], [0, 'ah', 220], [1, 'oo', 262], [0, 'eh', 220], [1, 'ah', 196]];
const res2 = A.analyze(song([line1, chorus, verse2, chorus], 2.5), SR);
const labels = res2.sections.map((s) => s.label);
console.log(labels.join(' | '));
assert.deepStrictEqual(labels, ['Verse 1', 'Chorus', 'Verse 2', 'Chorus']);
console.log('analysis tests passed');
