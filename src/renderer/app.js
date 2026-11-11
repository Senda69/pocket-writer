/* global MumbleAnalysis, mw */
'use strict';

// `mw` is the bridge exposed by preload.js (window.mw).
const $ = (sel) => document.querySelector(sel);

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

const uid = () => Math.random().toString(36).slice(2, 9);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, kind === 'error' ? 6000 : 2600);
}

// ---------- state ----------
const SCHEMES = ['AABB', 'ABAB', 'ABCB', 'AAAA', 'free'];
let song = blankSong();
const takeBuffers = new Map(); // takeId -> AudioBuffer (runtime only)
let lastLyricInput = null; // { lineId, el }
let audioCtx = null;
const ctx = () => (audioCtx ||= new AudioContext());

function blankSong() {
  return { version: 1, title: '', topic: '', mood: '', genre: '', takes: [], sections: [] };
}

const allLines = () => song.sections.flatMap((s) => s.lines);
const findLine = (id) => allLines().find((l) => l.id === id);
const sectionOf = (id) => song.sections.find((s) => s.lines.some((l) => l.id === id));

function rhymeLetter(section, idx) {
  if (!section.scheme || section.scheme === 'free') return null;
  return section.scheme[idx % section.scheme.length];
}

// ---------- persistence ----------
const LS_KEY = 'pocketwriter.autosave';
const autosave = debounce(() => {
  try {
    let json = JSON.stringify(song);
    if (json.length > 4_000_000) json = JSON.stringify({ ...song, takes: song.takes.map((t) => ({ ...t, dataB64: null })) });
    localStorage.setItem(LS_KEY, json);
  } catch { /* storage full or blocked: the .pocketsong file is the real save */ }
}, 600);

function changed({ rerender = false } = {}) {
  autosave();
  renderSheet();
  if (rerender) render();
}

async function loadSong(obj) {
  song = { ...blankSong(), ...obj };
  takeBuffers.clear();
  for (const t of song.takes) await decodeTake(t);
  $('#title').value = song.title || '';
  $('#topic').value = song.topic || '';
  $('#mood').value = song.mood || '';
  $('#genre').value = song.genre || '';
  render();
}

async function decodeTake(take) {
  if (!take.dataB64) return;
  try {
    const bytes = Uint8Array.from(atob(take.dataB64), (c) => c.charCodeAt(0));
    takeBuffers.set(take.id, await ctx().decodeAudioData(bytes.buffer));
  } catch { /* audio unreadable: lines still work without playback */ }
}

function blobToB64(blob) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.readAsDataURL(blob);
  });
}

// ---------- recording ----------
const rec = { stream: null, recorder: null, chunks: [], analyser: null, start: 0, raf: 0, timer: 0, beat: null };

async function startRecording() {
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    toast('Microphone access was blocked. Allow it in your system settings, then try again.', 'error');
    return;
  }
  const ac = ctx();
  if (ac.state === 'suspended') await ac.resume();
  const src = ac.createMediaStreamSource(rec.stream);
  rec.analyser = ac.createAnalyser();
  rec.analyser.fftSize = 2048;
  src.connect(rec.analyser);

  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  rec.chunks = [];
  rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.recorder.onstop = finishRecording;
  rec.recorder.start(250);
  rec.start = performance.now();
  if (rec.beat) { rec.beat.currentTime = 0; rec.beat.play().catch(() => {}); }

  $('#btn-record').classList.add('on');
  $('#btn-record .label').textContent = 'Stop';
  $('#rec-hint').textContent = 'Recording… mumble away. Pause briefly between lines.';
  rec.timer = setInterval(() => {
    const s = Math.floor((performance.now() - rec.start) / 1000);
    $('#rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 200);
  drawScope();
}

function stopRecording() {
  if (!rec.recorder) return;
  rec.recorder.stop();
  rec.stream.getTracks().forEach((t) => t.stop());
  if (rec.beat) rec.beat.pause();
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  $('#btn-record').classList.remove('on');
  $('#btn-record .label').textContent = 'Record';
  $('#rec-hint').textContent = 'Analysing your take…';
}

async function finishRecording() {
  const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'audio/webm' });
  rec.recorder = null;
  let buffer;
  try {
    buffer = await ctx().decodeAudioData(await blob.arrayBuffer());
  } catch {
    toast("Couldn't read that recording. Try again.", 'error');
    return;
  }
  const take = { id: uid(), name: `Take ${song.takes.length + 1}`, mime: blob.type, dataB64: await blobToB64(blob) };
  takeBuffers.set(take.id, buffer);
  song.takes.push(take);
  addAnalysedTake(take, buffer);
}

function addAnalysedTake(take, buffer) {
  // mix to mono
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels;
  }
  const result = MumbleAnalysis.analyze(mono, buffer.sampleRate);
  const nLines = result.sections.reduce((n, s) => n + s.lines.length, 0);
  if (!nLines) {
    $('#rec-hint').textContent = "Didn't hear anything there. Get a bit closer to the mic and try again.";
    return;
  }
  // Keep labels unique across takes (a second "Verse 1" becomes "Verse 2", etc.)
  const verseCount = () => song.sections.filter((s) => /^Verse/.test(s.label)).length;
  for (const sec of result.sections) {
    let label = sec.label;
    if (/^Verse/.test(label)) label = `Verse ${verseCount() + 1}`;
    song.sections.push({
      id: uid(),
      label,
      scheme: sec.lines.length >= 4 ? 'ABAB' : sec.lines.length >= 2 ? 'AABB' : 'free',
      lines: sec.lines.map((ln) => ({
        id: uid(),
        takeId: take.id,
        start: ln.start,
        end: ln.end,
        pattern: ln.pattern,
        syllables: ln.syllables.map((s) => ({
          start: s.start, end: s.end, stressed: s.stressed, midi: s.midi, note: s.note,
          vowel: s.vowel && s.vowel.confidence >= 0.3 ? s.vowel.say : null,
        })),
        anchors: '',
        lyric: '',
        options: [],
      })),
    });
  }
  $('#rec-hint').textContent = `${take.name}: found ${nLines} line${nLines === 1 ? '' : 's'} in ${result.sections.length} section${result.sections.length === 1 ? '' : 's'}. Record again to add more.`;
  changed({ rerender: true });
}

function drawScope() {
  const cv = $('#scope');
  const g = cv.getContext('2d');
  const W = (cv.width = cv.clientWidth * devicePixelRatio);
  const H = (cv.height = 56 * devicePixelRatio);
  const data = new Float32Array(rec.analyser.fftSize);
  const hist = [];
  const loop = () => {
    rec.analyser.getFloatTimeDomainData(data);
    let s = 0;
    for (const v of data) s += v * v;
    hist.push(Math.sqrt(s / data.length));
    const cols = Math.floor(W / (3 * devicePixelRatio));
    while (hist.length > cols) hist.shift();
    g.clearRect(0, 0, W, H);
    g.fillStyle = getComputedStyle(document.body).getPropertyValue('--rec').trim() || '#ff5d6c';
    hist.forEach((v, i) => {
      const bh = Math.max(2, Math.min(1, v * 6) * H);
      g.fillRect(i * 3 * devicePixelRatio, (H - bh) / 2, 2 * devicePixelRatio, bh);
    });
    rec.raf = requestAnimationFrame(loop);
  };
  loop();
}

// ---------- playback ----------
let playing = null;
function playSegment(takeId, start, end, button) {
  if (playing) { try { playing.src.stop(); } catch {} playing.button?.classList.remove('playing'); const same = playing.button === button; playing = null; if (same) return; }
  const buf = takeBuffers.get(takeId);
  if (!buf) { toast('No audio for this line (typed rhythm or audio not saved).'); return; }
  const src = ctx().createBufferSource();
  src.buffer = buf;
  src.connect(ctx().destination);
  const pad = 0.08;
  src.start(0, Math.max(0, start - pad), end - start + pad * 2);
  button?.classList.add('playing');
  playing = { src, button };
  src.onended = () => { button?.classList.remove('playing'); if (playing?.src === src) playing = null; };
}

// ---------- manual rhythm ----------
async function patternFromText(text) {
  const tokens = text.trim().split(/[\s\-]+/).filter(Boolean);
  if (tokens.length && tokens.every((t) => /^(da|dum|ta|dah)$/i.test(t))) {
    return tokens.map((t) => (/^(dum|DA|TA|DAH)$/.test(t) || t === t.toUpperCase() ? '1' : '0')).join('');
  }
  const info = await mw.lineInfo(text);
  return info.pattern.replace(/2/g, '1').replace(/\?/g, '0');
}

async function addManualLine(text, sectionId) {
  const pattern = await patternFromText(text);
  if (!pattern) return;
  let sec = song.sections.find((s) => s.id === sectionId);
  if (!sec) {
    sec = { id: uid(), label: `Verse ${song.sections.filter((s) => /^Verse/.test(s.label)).length + 1}`, scheme: 'AABB', lines: [] };
    song.sections.push(sec);
  }
  const isWords = !/^(\s*(da|dum|ta|dah)\b[\s\-]*)+$/i.test(text);
  sec.lines.push({
    id: uid(), takeId: null, start: 0, end: 0, pattern,
    syllables: pattern.split('').map((c) => ({ stressed: c === '1', start: 0, end: 0.25 + 0.15 * Number(c), midi: null, vowel: null })),
    anchors: '', lyric: isWords ? text.trim() : '', options: [],
  });
  changed({ rerender: true });
}

// ---------- AI ----------
function songPayload() {
  return {
    title: song.title, topic: song.topic, mood: song.mood, genre: song.genre,
    sections: song.sections.map((s) => ({
      label: s.label,
      scheme: s.scheme,
      lines: s.lines.map((l, i) => ({
        id: l.id,
        pattern: l.pattern,
        vowels: l.syllables.map((q) => q.vowel),
        endVowel: l.syllables[l.syllables.length - 1]?.vowel || null,
        anchors: l.anchors || '',
        lyric: l.lyric || '',
        rhymeLetter: rhymeLetter(s, i),
      })),
    })),
  };
}

async function suggestFor(lineIds, { fillEmpty = false, buttons = [] } = {}) {
  const settings = await mw.getSettings();
  if (!settings.hasKey) { openSettings('Add an API key to get lyric suggestions.'); return; }
  buttons.forEach((b) => { b.disabled = true; b.dataset.label = b.textContent; b.textContent = 'Writing…'; b.classList.add('busy'); });
  lineIds.forEach((id) => document.querySelector(`[data-line="${id}"]`)?.classList.add('thinking'));
  try {
    const results = await mw.suggest({ song: songPayload(), targetIds: lineIds, count: lineIds.length > 6 ? 3 : 4 });
    for (const r of results) {
      const line = findLine(r.id);
      if (!line) continue;
      line.options = r.options;
      if (fillEmpty && !line.lyric && r.options[0]) line.lyric = r.options[0].text;
    }
    changed({ rerender: true });
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    buttons.forEach((b) => { b.disabled = false; b.textContent = b.dataset.label; b.classList.remove('busy'); });
    lineIds.forEach((id) => document.querySelector(`[data-line="${id}"]`)?.classList.remove('thinking'));
  }
}

// ---------- rhymes ----------
let sylFilter = null;
async function showRhymes(query) {
  query = String(query || '').trim();
  $('#rhyme-input').value = query;
  if (!query) return;
  switchTab('rhymes');
  const box = $('#rhyme-results');
  box.replaceChildren(h('p', { class: 'muted small' }, 'Looking…'));
  const r = await mw.findRhymes(query, { syllables: sylFilter });
  if (!r.known) {
    box.replaceChildren(h('p', { class: 'muted small' }, `"${r.target || query}" isn't in the pronunciation dictionary. Try a more common spelling.`));
    return;
  }
  const group = (title, hint, items) => items.length ? h('div', { class: 'rgroup' },
    h('div', { class: 'rgroup-head' }, h('b', {}, title), h('span', { class: 'muted small' }, hint)),
    h('div', { class: 'rwords' }, items.map((w) => h('button', {
      class: `rword s${Math.min(w.syllables, 4)}`, title: `${w.syllables} syllable${w.syllables === 1 ? '' : 's'}`,
      onclick: () => insertWord(w.word),
    }, w.word)))) : null;
  box.replaceChildren(
    h('div', { class: 'rhyme-sound' }, 'Rhyming sound ', h('b', {}, r.sound), ' in ', h('i', {}, r.target)),
    group('Perfect', 'same ending sound', r.perfect),
    group('Slant', 'close enough to sing', r.near),
    group('Same vowel', 'assonance', r.assonance),
    group('Multi-syllable', 'matches more than the last vowel', r.multi),
  );
  if (![r.perfect, r.near, r.assonance, r.multi].some((a) => a.length)) box.append(h('p', { class: 'muted small' }, 'Nothing found with that syllable filter.'));
}

function insertWord(word) {
  const target = lastLyricInput?.el;
  if (target && document.body.contains(target)) {
    const v = target.value;
    const s = target.selectionStart ?? v.length, e = target.selectionEnd ?? v.length;
    const before = v.slice(0, s), after = v.slice(e);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    target.value = before + sep + word + after;
    target.focus();
    const pos = (before + sep + word).length;
    target.setSelectionRange(pos, pos);
    target.dispatchEvent(new Event('input'));
    toast(`Added "${word}"`);
  } else {
    navigator.clipboard?.writeText(word);
    toast(`Copied "${word}". Click into a lyric line first to insert directly.`);
  }
}

// ---------- rendering ----------
function stressText(pattern) {
  return pattern.split('').map((c) => (c === '1' ? 'DUM' : 'da')).join(' ');
}

function syllableStrip(line) {
  const sy = line.syllables;
  const midis = sy.map((s) => s.midi).filter((m) => m != null);
  const avg = midis.length ? midis.reduce((a, b) => a + b, 0) / midis.length : null;
  return h('div', { class: 'strip' }, sy.map((s, i) => {
    const dur = Math.max(0.12, (s.end - s.start) || 0.25);
    const lift = s.midi != null && avg != null ? Math.max(-10, Math.min(10, (s.midi - avg) * 1.6)) : 0;
    return h('div', {
      class: `syl ${s.stressed ? 'stressed' : ''}`,
      style: { flexGrow: String(dur), transform: `translateY(${-lift}px)` },
      title: [s.stressed ? 'Stressed' : 'Unstressed', s.note && `note ${s.note}`, s.vowel && `sounds like "${s.vowel}"`].filter(Boolean).join(' · '),
      'data-i': i,
    }, h('span', { class: 'v' }, s.vowel || (s.stressed ? 'DUM' : 'da')));
  }));
}

function fitBadge(fit, line) {
  if (!fit) return h('span', { class: 'fit muted' }, `${line.pattern.length} syllables`);
  const diff = fit.syllables - fit.target;
  const good = diff === 0 && fit.stressMatch >= 0.75;
  const ok = Math.abs(diff) <= 1 && fit.stressMatch >= 0.5;
  const txt = diff === 0 ? `${fit.syllables}/${fit.target} syllables` : `${fit.syllables}/${fit.target} syllables (${diff > 0 ? '+' : ''}${diff})`;
  return h('span', { class: `fit ${good ? 'good' : ok ? 'ok' : 'bad'}`, title: `Your line: ${stressText(fit.pattern.replace(/2/g, '1').replace(/\?/g, '0'))}` },
    txt, ' · ', `beats ${Math.round(fit.stressMatch * 100)}%`);
}

function lyricDots(line, fit) {
  // Under the strip: one dot per syllable of what you've written, coloured by whether its stress lands on the beat.
  const wrap = h('div', { class: 'dots' });
  if (!fit || !line.lyric) return wrap;
  const p = fit.pattern.replace(/2/g, '1');
  for (let i = 0; i < Math.max(p.length, line.pattern.length); i++) {
    const mine = p[i], target = line.pattern[i];
    let cls = 'dot';
    if (mine == null) cls += ' missing';
    else if (target == null) cls += ' extra';
    else if (target === '1' && mine === '0') cls += ' off';
    else cls += ' on';
    wrap.append(h('span', { class: cls }));
  }
  return wrap;
}

function lastWord(text) {
  const m = String(text || '').trim().match(/([A-Za-z']+)[^A-Za-z']*$/);
  return m ? m[1] : '';
}

function renderLine(section, line, idx) {
  const letter = rhymeLetter(section, idx);
  const fitHolder = h('span', {});
  const dotsHolder = h('div', {});
  const rhymeTag = h('span', { class: 'rhyme-tag', title: 'Rhyme letter from the section scheme' }, letter || '');
  const lw = h('button', { class: 'lastword link small', title: 'Find rhymes for this word', onclick: () => showRhymes(lastWord(line.lyric)) });

  const refreshFit = async () => {
    lw.textContent = lastWord(line.lyric) ? `rhymes for "${lastWord(line.lyric)}"` : '';
    if (!line.lyric.trim()) { fitHolder.replaceChildren(fitBadge(null, line)); dotsHolder.replaceChildren(); return; }
    const fit = await mw.fit(line.lyric, line.pattern);
    fitHolder.replaceChildren(fitBadge(fit, line));
    dotsHolder.replaceChildren(lyricDots(line, fit));
    updateRhymeChecks(section);
  };

  const lyricInput = h('input', {
    class: 'lyric', value: line.lyric, placeholder: line.options.length ? 'Pick an option below, or write your own' : 'Write the line, or hit Suggest',
    spellcheck: 'true',
    oninput: debounce((e) => { line.lyric = e.target.value; changed(); refreshFit(); }, 150),
    onfocus: (e) => { lastLyricInput = { lineId: line.id, el: e.target }; },
  });
  const anchorInput = h('input', {
    class: 'anchors', value: line.anchors, placeholder: 'words you half-sang or want to keep (optional)',
    oninput: (e) => { line.anchors = e.target.value; changed(); },
  });

  const playBtn = h('button', {
    class: 'play icon', title: line.takeId ? 'Play this phrase' : 'Typed rhythm (no audio)', 'aria-label': 'Play',
    disabled: !line.takeId, onclick: (e) => playSegment(line.takeId, line.start, line.end, e.currentTarget),
  }, h('span', { class: 'tri' }));

  const suggestBtn = h('button', { class: 'small suggest', onclick: (e) => suggestFor([line.id], { buttons: [e.currentTarget] }) }, '✨ Suggest');

  const del = h('button', {
    class: 'ghost icon small del', title: 'Delete line', 'aria-label': 'Delete line',
    onclick: () => { section.lines = section.lines.filter((l) => l !== line); if (!section.lines.length) song.sections = song.sections.filter((s) => s !== section); changed({ rerender: true }); },
  }, '×');

  const options = line.options.length ? h('div', { class: 'options' }, line.options.map((o) => h('button', {
    class: `option ${o.text === line.lyric ? 'chosen' : ''}`,
    onclick: () => { line.lyric = o.text; lyricInput.value = o.text; changed(); refreshFit(); render(); },
  }, h('span', {}, o.text), fitBadge(o.fit, line)))) : null;

  const el = h('div', { class: 'line', 'data-line': line.id },
    h('div', { class: 'line-head' },
      playBtn,
      rhymeTag,
      h('div', { class: 'rhythm' }, syllableStrip(line), dotsHolder),
      h('div', { class: 'line-tools' }, suggestBtn, del),
    ),
    h('div', { class: 'line-body' },
      h('div', { class: 'pattern', title: 'Stress pattern of what you sang' }, stressText(line.pattern)),
      lyricInput,
      h('div', { class: 'line-foot' }, fitHolder, h('span', { class: 'rhyme-check' }), lw, anchorInput),
      options,
    ),
  );
  el._refresh = refreshFit;
  refreshFit();
  return el;
}

async function updateRhymeChecks(section) {
  const groups = {};
  section.lines.forEach((l, i) => {
    const L = rhymeLetter(section, i);
    if (L) (groups[L] ||= []).push(l);
  });
  for (const lines of Object.values(groups)) {
    for (let i = 0; i < lines.length; i++) {
      const el = document.querySelector(`[data-line="${lines[i].id}"] .rhyme-check`);
      if (!el) continue;
      const partner = lines[i === 0 ? 1 : i - 1];
      const a = lastWord(lines[i].lyric), b = partner && lastWord(partner.lyric);
      if (!a || !b) { el.textContent = ''; el.className = 'rhyme-check'; continue; }
      const kind = await mw.doRhyme(a, b);
      el.textContent = kind ? `${kind} rhyme with "${b}"` : `doesn't rhyme with "${b}"`;
      el.className = `rhyme-check ${kind === 'perfect' ? 'good' : kind ? 'ok' : 'bad'}`;
    }
  }
}

function renderSection(section) {
  const labelInput = h('input', {
    class: 'section-label', value: section.label, list: 'section-names', spellcheck: 'false',
    oninput: (e) => { section.label = e.target.value; changed(); },
  });
  const scheme = h('select', {
    class: 'scheme', title: 'Rhyme scheme',
    onchange: (e) => { section.scheme = e.target.value; changed({ rerender: true }); },
  }, SCHEMES.map((s) => h('option', { value: s, selected: s === section.scheme ? 'selected' : null }, s === 'free' ? 'No scheme' : s)));
  const writeBtn = h('button', {
    class: 'small', onclick: (e) => suggestFor(section.lines.map((l) => l.id), { fillEmpty: true, buttons: [e.currentTarget] }),
  }, '✨ Write section');
  const moveUp = h('button', {
    class: 'ghost icon small', title: 'Move section up', 'aria-label': 'Move section up',
    onclick: () => { const i = song.sections.indexOf(section); if (i > 0) { song.sections.splice(i, 1); song.sections.splice(i - 1, 0, section); changed({ rerender: true }); } },
  }, '↑');
  const addLine = h('button', { class: 'ghost small', onclick: () => openManual(section.id) }, '+ line');
  return h('div', { class: 'section card', 'data-section': section.id },
    h('div', { class: 'section-head' }, labelInput, scheme, h('span', { class: 'spacer' }), addLine, moveUp, writeBtn),
    section.lines.map((l, i) => renderLine(section, l, i)),
  );
}

function render() {
  const box = $('#sections');
  box.replaceChildren(
    h('datalist', { id: 'section-names' }, ['Intro', 'Verse 1', 'Verse 2', 'Verse 3', 'Pre-Chorus', 'Chorus', 'Bridge', 'Outro'].map((n) => h('option', { value: n }))),
    ...song.sections.map(renderSection),
  );
  $('#empty').classList.toggle('hidden', song.sections.length > 0);
  $('#btn-write-all').disabled = !song.sections.length;
  song.sections.forEach(updateRhymeChecks);
  renderSheet();
}

function sheetText() {
  const lines = [];
  if (song.title) lines.push(song.title.toUpperCase(), '');
  for (const s of song.sections) {
    lines.push(`[${s.label}]`);
    for (const l of s.lines) lines.push(l.lyric || `(${stressText(l.pattern)})`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}
function renderSheet() { $('#sheet').textContent = song.sections.length ? sheetText() : 'Your lyrics will collect here.'; }

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#panel-rhymes').classList.toggle('hidden', name !== 'rhymes');
  $('#panel-sheet').classList.toggle('hidden', name !== 'sheet');
}

// ---------- dialogs ----------
async function openSettings(message) {
  const s = await mw.getSettings();
  $('#api-key').value = '';
  $('#key-status').textContent = message || (s.hasKey ? (s.fromEnv ? 'Using the key from the ANTHROPIC_API_KEY environment variable.' : 'A key is saved. Paste a new one to replace it, or save empty to remove it.') : 'No key saved yet.');
  $('#settings').showModal();
}

function openManual(sectionId) {
  const sel = $('#manual-section');
  sel.replaceChildren(
    ...song.sections.map((s) => h('option', { value: s.id, selected: s.id === sectionId ? 'selected' : null }, s.label)),
    h('option', { value: '' }, '+ New section'),
  );
  $('#manual-input').value = '';
  $('#manual').showModal();
}

// ---------- wiring ----------
function bind() {
  $('#btn-record').addEventListener('click', () => (rec.recorder ? stopRecording() : startRecording()));
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      rec.recorder ? stopRecording() : startRecording();
    }
  });

  $('#btn-beat').addEventListener('click', () => $('#beat-file').click());
  $('#beat-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (rec.beat) URL.revokeObjectURL(rec.beat.src);
    rec.beat = new Audio(URL.createObjectURL(f));
    rec.beat.loop = true;
    $('#beat-name').textContent = `${f.name} (plays while recording; use headphones)`;
  });

  for (const k of ['title', 'topic', 'mood', 'genre']) {
    $(`#${k}`).addEventListener('input', (e) => { song[k] = e.target.value; changed(); });
  }

  $('#btn-write-all').addEventListener('click', (e) => suggestFor(allLines().map((l) => l.id), { fillEmpty: true, buttons: [e.currentTarget] }));

  $('#btn-new').addEventListener('click', () => {
    if (song.sections.length && !confirm('Start a new song? Unsaved changes in this one will be lost.')) return;
    loadSong(blankSong());
  });
  $('#btn-save').addEventListener('click', async () => {
    const p = await mw.saveProject(JSON.stringify(song), song.title || 'Untitled');
    if (p) toast('Saved');
  });
  $('#btn-open').addEventListener('click', async () => {
    try {
      const json = await mw.openProject();
      if (json) await loadSong(JSON.parse(json));
    } catch (err) { toast(`Couldn't open that file: ${err.message}`, 'error'); }
  });

  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#settings').addEventListener('close', async () => {
    if ($('#settings').returnValue !== 'save') return;
    const r = await mw.setApiKey($('#api-key').value);
    toast(r.hasKey ? 'API key saved' : 'API key removed');
  });

  $('#btn-add-manual').addEventListener('click', () => openManual(null));
  $('#manual').addEventListener('close', () => {
    if ($('#manual').returnValue !== 'add') return;
    const text = $('#manual-input').value;
    if (text.trim()) addManualLine(text, $('#manual-section').value);
  });

  $('#rhyme-form').addEventListener('submit', (e) => { e.preventDefault(); showRhymes($('#rhyme-input').value); });
  $('#syl-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-syl]');
    if (!b) return;
    sylFilter = b.dataset.syl ? Number(b.dataset.syl) : null;
    document.querySelectorAll('#syl-filter .chip').forEach((c) => c.classList.toggle('active', c === b));
    if ($('#rhyme-input').value) showRhymes($('#rhyme-input').value);
  });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#btn-copy-sheet').addEventListener('click', () => { navigator.clipboard.writeText(sheetText()); toast('Lyrics copied'); });
  $('#btn-export-sheet').addEventListener('click', async () => { if (await mw.exportText(sheetText(), song.title || 'lyrics')) toast('Exported'); });
}

(async function init() {
  if (mw.platform === 'darwin') document.body.classList.add('mac');
  bind();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { /* ignore */ }
  await loadSong(saved || blankSong());
})();

// exposed for automated UI tests
window.__mumble = { addAnalysedTake, song: () => song, loadSong, takeBuffers };
