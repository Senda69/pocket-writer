const assert = require('assert');
const p = require('../src/lib/phonetics');
const claude = require('../src/main/claude');

// syllables & stress
assert.strictEqual(p.lineInfo('I keep on running back to you tonight').syllables, 10);
assert.strictEqual(p.wordInfo('tonight').stress, '01');
assert.strictEqual(p.wordInfo('beautiful').syllables, 3);
// rhymes
const r = p.findRhymes('tonight');
for (const w of ['light', 'right', 'fight']) assert.ok(r.perfect.some((x) => x.word === w), `perfect rhyme ${w}`);
assert.ok(p.findRhymes('home').near.some((x) => x.word === 'alone'), 'slant: home/alone');
assert.strictEqual(p.doRhyme('night', 'light'), 'perfect');
assert.strictEqual(p.doRhyme('home', 'alone'), 'slant');
assert.strictEqual(p.findRhymes('love', { syllables: 1 }).perfect.every((x) => x.syllables === 1), true);
// fit scoring
const good = p.fitScore('I walk the line', '0101');
const bad = p.fitScore('I walk the line tonight with you', '0101');
assert.ok(good.score > bad.score && good.syllables === 4);

// claude: prompt building + ranking with a fake client
let sent = null;
claude._setClientFactory(() => ({ beta: { messages: { create: async (req) => {
  sent = req;
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ lines: [
    { id: 'L1', options: ['this is way too long for the line here', 'I walk the line'] },
  ] }) }] };
} } } }));
(async () => {
  const song = { topic: 'leaving home', sections: [{ label: 'Verse 1', scheme: 'AABB', lines: [
    { id: 'L1', pattern: '0101', vowels: [null, 'ee', null, 'eye'], endVowel: 'eye', anchors: '', lyric: '', rhymeLetter: 'A' },
    { id: 'L2', pattern: '1010', vowels: [], endVowel: null, anchors: 'tonight', lyric: '', rhymeLetter: 'A' },
  ] }] };
  const out = await claude.suggest('k', { song, targetIds: ['L1'], count: 2 });
  assert.strictEqual(out[0].options[0].text, 'I walk the line', 'best fit ranked first');
  const prompt = sent.messages[0].content;
  assert.ok(prompt.includes('da-DUM-da-DUM') && prompt.includes('ends on an "eye" sound') && prompt.includes('anchor words to keep: "tonight"'));
  assert.strictEqual(sent.model, 'claude-opus-5-5');
  assert.strictEqual(sent.output_config.format.type, 'json_schema');
  // refusal surfaces a friendly error
  claude._setClientFactory(() => ({ beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } }));
  await assert.rejects(claude.suggest('k', { song, targetIds: ['L1'] }), /declined/);
  console.log('phonetics + claude tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
