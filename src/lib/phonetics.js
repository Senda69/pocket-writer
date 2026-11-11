// Phonetics engine: syllables, stress, and rhyme finding.
// Built on the CMU Pronouncing Dictionary (ARPAbet phones with stress digits)
// and SUBTLEXus spoken-English frequencies for ranking.
'use strict';

const cmuModule = require('cmu-pronouncing-dictionary');
const CMU = cmuModule.dictionary || cmuModule;
const subtlex = require('subtlex-word-frequencies');
const fs = require('fs');
const path = require('path');

// Dictionary words (no proper nouns or abbreviations), used to keep rhyme
// results to real words. word-list is ESM-only, so read its text file directly.
let REAL_WORDS = null;
try {
  const file = path.join(__dirname, '..', '..', 'node_modules', 'word-list', 'words.txt');
  REAL_WORDS = new Set(fs.readFileSync(file, 'utf8').split('\n'));
} catch { /* fall back to frequency filtering only */ }

const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

// Rough "sounds like" spelling for each vowel, shown in the UI.
const VOWEL_SPELLING = {
  AA: 'ah', AE: 'a', AH: 'uh', AO: 'aw', AW: 'ow', AY: 'eye', EH: 'eh', ER: 'er',
  EY: 'ay', IH: 'ih', IY: 'ee', OW: 'oh', OY: 'oy', UH: 'oo(k)', UW: 'oo',
};

// Vowels that commonly pass for each other in sung slant rhymes.
const VOWEL_NEIGHBORS = {
  AA: ['AO', 'AH'], AO: ['AA', 'OW'], AH: ['AA', 'UH', 'EH'], AE: ['EH', 'AA'],
  EH: ['AE', 'IH', 'EY'], IH: ['IY', 'EH'], IY: ['IH', 'EY'], EY: ['EH', 'IY', 'AY'],
  AY: ['EY', 'AA'], OW: ['AO', 'UW'], UW: ['UH', 'OW'], UH: ['UW', 'AH'],
  AW: ['AA', 'OW'], OY: ['AY', 'OW'], ER: ['AH', 'UH'],
};

// Consonant families, used to score how close two endings sound.
const CONS_FAMILY = {
  P: 'stop', B: 'stop', T: 'stop', D: 'stop', K: 'stop', G: 'stop',
  M: 'nasal', N: 'nasal', NG: 'nasal',
  F: 'fric', V: 'fric', TH: 'fric', DH: 'fric', S: 'sib', Z: 'sib', SH: 'sib', ZH: 'sib', HH: 'fric',
  CH: 'affr', JH: 'affr', L: 'liquid', R: 'liquid', W: 'glide', Y: 'glide',
};

// ---- frequency rank (lower = more common) ----
const RANK = new Map();
subtlex.forEach((d, i) => { if (!RANK.has(d.word.toLowerCase())) RANK.set(d.word.toLowerCase(), i); });
const rankOf = (w) => (RANK.has(w) ? RANK.get(w) : 1e6);

const strip = (p) => p.replace(/\d/g, '');
const isVowel = (p) => VOWELS.has(strip(p));

function clean(word) {
  return String(word || '').toLowerCase().replace(/[^a-z']/g, '').replace(/^'+|'+$/g, '');
}

function lookup(word) {
  const w = clean(word);
  if (!w) return null;
  const p = CMU[w];
  return p ? p.split(' ') : null;
}

// Fallback syllable estimate for words not in the dictionary.
function guessSyllables(word) {
  const w = clean(word).replace(/'/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let s = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = s.match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}

function wordInfo(word) {
  const phones = lookup(word);
  if (!phones) {
    const n = guessSyllables(word);
    return { word: clean(word), known: false, syllables: n, stress: '?'.repeat(n), phones: null };
  }
  const vowels = phones.filter(isVowel);
  return {
    word: clean(word),
    known: true,
    syllables: vowels.length,
    stress: vowels.map((v) => v.slice(-1)).join(''),
    phones,
  };
}

// Syllables + stress of a whole line. Stress per word: 1 = primary, 2 = secondary, 0 = none.
// One-syllable function words are treated as unstressed, content words as stressed.
const FUNCTION_WORDS = new Set(('a an the and or but if of to in on at by for with from as is am are was were be been ' +
  'i you he she it we they me him her us them my your his its our their this that these those do does did ' +
  'not no so than then there here when where what who how can could would should will shall may might must ' +
  'just up out oh im youre its dont cant wont aint gonna wanna').split(' '));

function lineInfo(line) {
  const words = String(line || '').split(/[\s\-—]+/).map(clean).filter(Boolean);
  const out = [];
  for (const w of words) {
    const info = wordInfo(w);
    let stress = info.stress;
    if (info.syllables === 1) stress = FUNCTION_WORDS.has(w.replace(/'/g, '')) ? '0' : '1';
    out.push({ ...info, stress });
  }
  const pattern = out.map((o) => o.stress).join('');
  return { words: out, syllables: pattern.length, pattern };
}

// The rhyming tail: last stressed vowel to the end.
function rhymeTail(phones) {
  let idx = -1;
  for (let i = phones.length - 1; i >= 0; i--) {
    if (isVowel(phones[i]) && /[12]$/.test(phones[i])) { idx = i; break; }
  }
  if (idx < 0) for (let i = phones.length - 1; i >= 0; i--) if (isVowel(phones[i])) { idx = i; break; }
  if (idx < 0) return null;
  return phones.slice(idx).map(strip);
}

// Tail covering the last N vowels (for multi-syllable rhymes).
function vowelTail(phones, n) {
  let count = 0;
  for (let i = phones.length - 1; i >= 0; i--) {
    if (isVowel(phones[i]) && ++count === n) return phones.slice(i).map(strip);
  }
  return null;
}

// ---- indexes, built lazily on first rhyme request ----
let INDEX = null;
function buildIndex() {
  const perfect = new Map(); // tail string -> [words]
  const vowelCoda = new Map(); // last stressed vowel -> [{word, tail}]
  const entries = [];
  for (const [w, pron] of Object.entries(CMU)) {
    if (/[^a-z']/.test(w) || /\(\d\)$/.test(w)) continue;
    const r = rankOf(w);
    if (r > 60000 && w.length > 3) continue; // drop very obscure entries
    if (REAL_WORDS && !REAL_WORDS.has(w) && !(w.includes("'") && r < 20000)) continue; // names, abbreviations
    const phones = pron.split(' ');
    const tail = rhymeTail(phones);
    if (!tail) continue;
    const key = tail.join(' ');
    if (!perfect.has(key)) perfect.set(key, []);
    perfect.get(key).push(w);
    const v = tail[0];
    if (!vowelCoda.has(v)) vowelCoda.set(v, []);
    vowelCoda.get(v).push({ word: w, tail });
    entries.push({ word: w, phones, rank: r });
  }
  INDEX = { perfect, vowelCoda, entries };
  return INDEX;
}

function codaScore(a, b) {
  // a, b: consonant arrays after the vowel. 1 = identical, 0 = unrelated.
  if (a.join(' ') === b.join(' ')) return 1;
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0.35;
  const la = a[a.length - 1], lb = b[b.length - 1];
  let s = 0;
  if (la === lb) s += 0.6;
  else if (CONS_FAMILY[la] && CONS_FAMILY[la] === CONS_FAMILY[lb]) s += 0.45;
  if (a.length === b.length) s += 0.2;
  const shared = a.filter((c) => b.includes(c)).length;
  s += 0.2 * (shared / Math.max(a.length, b.length));
  return Math.min(0.95, s);
}

function byRank(words) {
  return [...new Set(words)].sort((x, y) => rankOf(x) - rankOf(y) || x.length - y.length);
}

function attach(words) {
  return words.map((w) => ({ word: w, syllables: wordInfo(w).syllables }));
}

/**
 * Find rhymes for a word or short phrase (the last word is the target;
 * for phrases, multi-syllable rhymes match the vowels across the phrase end).
 */
function findRhymes(input, { limit = 60, syllables = null } = {}) {
  const idx = INDEX || buildIndex();
  const words = String(input || '').trim().split(/\s+/).map(clean).filter(Boolean);
  if (!words.length) return { input, known: false, perfect: [], near: [], assonance: [], multi: [] };
  const target = words[words.length - 1];
  const phones = lookup(target);
  if (!phones) return { input, target, known: false, perfect: [], near: [], assonance: [], multi: [] };

  const sylOk = (w) => syllables == null || wordInfo(w).syllables === syllables;
  const notSelf = (w) => w !== target && !target.endsWith(w) && !w.endsWith(target);

  const tail = rhymeTail(phones);
  const perfect = byRank((idx.perfect.get(tail.join(' ')) || []).filter(notSelf).filter(sylOk)).slice(0, limit);

  // Near / slant: same stressed vowel (or a neighbor), similar ending consonants.
  const v = tail[0];
  const coda = tail.slice(1).filter((p) => !isVowel(p));
  const near = [];
  const assonance = [];
  const perfectSet = new Set(perfect);
  for (const vv of [v, ...(VOWEL_NEIGHBORS[v] || [])]) {
    for (const { word, tail: t } of idx.vowelCoda.get(vv) || []) {
      if (perfectSet.has(word) || !notSelf(word) || !sylOk(word)) continue;
      if (t.length !== tail.length && Math.abs(t.length - tail.length) > 2) continue;
      const tc = t.slice(1).filter((p) => !isVowel(p));
      let score = codaScore(coda, tc) * (vv === v ? 1 : 0.75);
      if (score >= 0.55) near.push({ word, score, same: vv === v });
      else if (vv === v && t.length <= tail.length + 1) assonance.push({ word, score });
    }
  }
  const rankSort = (a, b) => b.score - a.score || rankOf(a.word) - rankOf(b.word);
  // Same vowel first (true slant rhymes), then neighbor vowels (loose); common words first within each.
  near.sort((a, b) => Number(b.same) - Number(a.same) || rankOf(a.word) - rankOf(b.word));
  assonance.sort(rankSort);

  // Multi-syllable: match the last 2-3 vowel sounds of the whole phrase.
  const phrasePhones = words.flatMap((w) => lookup(w) || []);
  const multi = [];
  const vowelCount = phrasePhones.filter(isVowel).length;
  for (let n = Math.min(3, vowelCount); n >= 2; n--) {
    const mt = vowelTail(phrasePhones, n);
    if (!mt) continue;
    const mv = mt.filter(isVowel).join(' ');
    for (const e of idx.entries) {
      if (multi.length > 400) break;
      if (e.rank > 25000 || !notSelf(e.word) || words.includes(e.word)) continue;
      const et = vowelTail(e.phones, n);
      if (!et || et.filter(isVowel).join(' ') !== mv) continue;
      const ec = et.slice(-1)[0], tc = mt.slice(-1)[0];
      if (isVowel(ec) !== isVowel(tc)) continue;
      if (!isVowel(tc) && ec !== tc && CONS_FAMILY[ec] !== CONS_FAMILY[tc]) continue;
      multi.push({ word: e.word, vowels: n, exact: et.join(' ') === mt.join(' ') });
    }
    if (multi.length >= 10) break;
  }
  multi.sort((a, b) => b.vowels - a.vowels || Number(b.exact) - Number(a.exact) || rankOf(a.word) - rankOf(b.word));

  return {
    input,
    target,
    known: true,
    sound: tail.map((p) => VOWEL_SPELLING[p] || p.toLowerCase()).join('-'),
    perfect: attach(perfect),
    near: attach([...new Set(near.map((n) => n.word))].slice(0, limit)),
    assonance: attach(assonance.slice(0, limit).map((a) => a.word)),
    multi: attach([...new Set(multi.map((m) => m.word))].slice(0, 30)),
  };
}

// How well a written line fits a target stress pattern like "0101" (1 = stressed beat).
function fitScore(line, target) {
  const info = lineInfo(line);
  const p = info.pattern.replace(/2/g, '1').replace(/\?/g, 'x');
  const t = String(target || '');
  const sylDiff = Math.abs(p.length - t.length);
  let stressHits = 0, stressSlots = 0;
  for (let i = 0; i < Math.min(p.length, t.length); i++) {
    if (t[i] === '1') { stressSlots++; if (p[i] === '1' || p[i] === 'x') stressHits++; }
  }
  const stressMatch = stressSlots ? stressHits / stressSlots : 1;
  const score = Math.max(0, 1 - sylDiff * 0.2) * (0.5 + 0.5 * stressMatch);
  return { syllables: info.syllables, target: t.length, pattern: info.pattern, stressMatch, score };
}

function doRhyme(a, b) {
  const pa = lookup(a), pb = lookup(b);
  if (!pa || !pb) return null;
  const ta = rhymeTail(pa), tb = rhymeTail(pb);
  if (ta.join(' ') === tb.join(' ')) return 'perfect';
  if (ta[0] === tb[0]) return 'slant';
  if ((VOWEL_NEIGHBORS[ta[0]] || []).includes(tb[0])) return 'loose';
  return null;
}

module.exports = { wordInfo, lineInfo, findRhymes, fitScore, doRhyme, rhymeTail, lookup, VOWEL_SPELLING };
