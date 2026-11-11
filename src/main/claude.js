// Lyric suggestions from Claude, constrained to the rhythm of the mumble.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const phon = require('../lib/phonetics');

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You are a songwriting partner. The writer mumbled or hummed a melody, and the app measured each line: how many syllables, which ones are stressed (the beats that land hard), and the vowel sound they sang on some syllables.

Your job is to write lyric lines that can be sung over that exact rhythm.

Rules for every line you write:
- Match the syllable count exactly. Count syllables the way they are sung.
- Put naturally stressed syllables on the stressed beats ("DUM"); unstressed syllables (a, the, to, -ing endings) on "da".
- Where a vowel sound is given for the last syllable, prefer an end word with that vowel, because the writer instinctively chose it.
- Keep any anchor words the writer gave, in roughly the position they sang them.
- Follow the rhyme scheme for the section. Lines with the same letter must rhyme (perfect or strong slant rhyme).
- Write like a contemporary songwriter: concrete images, conversational phrasing, no cliches like "heart of gold", no forced archaic inversions.
- Options for one line should be genuinely different from each other, not small rewordings.`;

function stressPicture(pattern) {
  return pattern.split('').map((c) => (c === '1' ? 'DUM' : 'da')).join('-');
}

function describeLine(line) {
  const parts = [`id ${line.id}: ${line.pattern.length} syllables, ${stressPicture(line.pattern)}`];
  const vowels = (line.vowels || []).map((v) => v || '?');
  if (vowels.some((v) => v !== '?')) parts.push(`sung vowels: ${vowels.join(' ')}`);
  if (line.endVowel) parts.push(`ends on an "${line.endVowel}" sound`);
  if (line.anchors) parts.push(`anchor words to keep: "${line.anchors}"`);
  if (line.lyric) parts.push(`current draft: "${line.lyric}"`);
  if (line.rhymeLetter) parts.push(`rhyme letter ${line.rhymeLetter}`);
  return '  - ' + parts.join('; ');
}

function describeSong(song) {
  const head = [
    song.title && `Title: ${song.title}`,
    song.topic && `What it's about: ${song.topic}`,
    song.mood && `Mood: ${song.mood}`,
    song.genre && `Genre/style: ${song.genre}`,
  ].filter(Boolean).join('\n');
  const body = song.sections.map((s) => `${s.label} (rhyme scheme ${s.scheme || 'free'}):\n${s.lines.map(describeLine).join('\n')}`).join('\n\n');
  return `${head || 'No topic given: pick an evocative one that suits the melody.'}\n\n${body}`;
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

class LyricError extends Error {}

let clientFactory = (apiKey) => (apiKey ? new Anthropic({ apiKey }) : new Anthropic());
function makeClient(apiKey) { return clientFactory(apiKey); }
// For tests: swap in a fake client.
function _setClientFactory(fn) { clientFactory = fn; }

async function ask(apiKey, userText, effort) {
  const client = makeClient(apiKey);
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new LyricError('Your Anthropic API key was rejected. Check it in Settings.');
    if (err instanceof Anthropic.RateLimitError) throw new LyricError('Rate limited by the API. Wait a moment and try again.');
    if (err instanceof Anthropic.APIConnectionError) throw new LyricError('Could not reach the Anthropic API. Check your internet connection.');
    if (err instanceof Anthropic.APIError) throw new LyricError(`API error ${err.status}: ${err.message}`);
    throw err;
  }
  if (response.stop_reason === 'refusal') throw new LyricError('The model declined to write this one. Try changing the topic.');
  if (response.stop_reason === 'max_tokens') throw new LyricError('The response was cut off. Try fewer lines at once.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text).lines;
  } catch {
    throw new LyricError('Got an unreadable answer from the model. Try again.');
  }
}

// Score each option against the line's measured rhythm, best fits first.
function rank(lines, targetsById) {
  return lines.map((l) => {
    const target = targetsById.get(l.id);
    const options = (l.options || []).map((text) => ({ text, fit: phon.fitScore(text, target?.pattern || '') }));
    options.sort((a, b) => b.fit.score - a.fit.score);
    return { id: l.id, options };
  });
}

/**
 * Suggest lyrics.
 * payload: { song: {title, topic, mood, genre, sections:[{label, scheme, lines:[{id, pattern, vowels, endVowel, anchors, lyric, rhymeLetter}]}]},
 *            targetIds: [line ids to write], count }
 */
async function suggest(apiKey, payload) {
  const { song, targetIds, count = 4 } = payload;
  const all = song.sections.flatMap((s) => s.lines);
  const targets = new Map(all.filter((l) => targetIds.includes(l.id)).map((l) => [l.id, l]));
  if (!targets.size) return [];
  const which = targets.size === all.length
    ? `Write all ${targets.size} lines so they read as one song.`
    : `Write only these lines: ${[...targets.keys()].join(', ')}. The other lines are context; rhyme with their current drafts where the scheme says so.`;
  const userText = `${describeSong(song)}\n\n${which}\nGive ${count} options for each line you write, best first. Return the line ids exactly as given.`;
  const lines = await ask(apiKey, userText, targets.size > 6 ? 'medium' : 'low');
  return rank(lines.filter((l) => targets.has(l.id)), targets);
}

module.exports = { suggest, describeSong, LyricError, MODEL, _setClientFactory };
