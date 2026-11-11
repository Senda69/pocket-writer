# Pocket Writer

Mumble a melody, get lyrics that fit it. Pocket Writer is a desktop songwriting assistant for Mac and Windows.

1. **Record.** Hit Record (or press Space) and mumble, hum or "da-da" your melody. You can play a beat in your headphones while you record. Leave a short pause between lines and a longer one (2 seconds or more) between sections.
2. **See the rhythm.** Each phrase becomes a line showing every syllable you sang: which ones hit hard (tall gold blocks are stressed beats), how long each one is, its pitch (blocks sit higher or lower), and the vowel you sang (`ee`, `ah`, `oh`…). Sections whose melody repeats are labelled as the chorus.
3. **Get words that fit.** Tell it what the song is about, then use **Suggest** on a line, **Write section**, or **Write whole song**. Claude writes lines that match each line's syllable count and stress pattern, rhyme according to the section's scheme (AABB, ABAB…), and favour the vowel sounds you mumbled. Each option is re-checked locally and labelled with how well it fits.
4. **Rhyme as you write.** Type into any line and you see live syllable and stress fit (green dots land on the beat) plus whether it rhymes with its partner line. The Rhymes panel finds perfect rhymes, slant rhymes, same-vowel words and multi-syllable rhymes, ranked by how common the word is in everyday speech. Click a result to drop it into the line you're editing.
5. **Keep it.** Save the song as a `.pocketsong` file (audio included), or copy or export the lyric sheet as text.

No mic handy? Use **Type a rhythm** to enter a line as `da DUM da DUM`, or paste a line you like to borrow its rhythm.

## Setup

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
npm start
```

Lyric suggestions need an Anthropic API key. Paste it in **Settings** (the gear icon); it's stored encrypted on your computer. Alternatively, set `ANTHROPIC_API_KEY` before launching. Recording, rhythm analysis and rhymes all work offline without a key.

## Building installers

```bash
npm run dist:mac
```

```bash
npm run dist:win
```

Build each platform on that platform (or run Windows builds on Linux with Wine installed). The output goes to `dist/`.

The easiest route is the included GitHub Actions workflow (`.github/workflows/build.yml`). Push this folder to a GitHub repo, then either run the **Build desktop apps** workflow from the Actions tab or push a tag like `v0.1.0`. It builds a `.dmg` (Apple Silicon and Intel) and a Windows `.exe` installer, and attaches them to the run as downloads.

These builds are unsigned:

- **Mac:** the first time, right-click the app and choose **Open**. If macOS says the app is damaged, run `xattr -cr "/Applications/Pocket Writer.app"`.
- **Windows:** SmartScreen may warn you. Click **More info**, then **Run anyway**.

To remove the warnings you need an Apple Developer ID and a Windows code-signing certificate; electron-builder picks them up from `CSC_LINK` / `CSC_KEY_PASSWORD` (plus `APPLE_ID` etc. for notarisation).

## How it works

| Part | File | What it does |
|---|---|---|
| Mumble analysis | `src/lib/analysis.js` | Finds phrases from silences, splits syllables at dips in vowel-band energy, scores stress from loudness, length and pitch, tracks pitch (YIN), and guesses vowels from formants (LPC). Then it clusters sections by melody to label verse and chorus. |
| Phonetics | `src/lib/phonetics.js` | CMU Pronouncing Dictionary for syllables and stress, rhyme search, fit scoring. Uses SUBTLEX spoken-word frequencies for ranking and an English word list to drop names. |
| Lyric writer | `src/main/claude.js` | Describes each line's rhythm to Claude (`claude-opus-5-5`), asks for structured JSON output, then re-ranks the options by measured fit. |
| App | `src/main`, `src/renderer` | An Electron shell. The API key and file access stay in the main process, and the UI talks to them through a small preload bridge. |

## Tests

```bash
npm test
```

The analysis test synthesises vowel sounds with formant filters, mumbles a verse and chorus, and checks that syllable counts, stress patterns, vowels and section labels come back correctly. The phonetics test covers rhymes, stress and fit, and checks the prompt the app builds for Claude using a fake API client.

## Ideas for next steps

- Transcribe any real words you sing (for example with a local Whisper model) and pre-fill them as anchor words.
- Align written lyrics to the recording and play them back with a simple synth voice.
- Detect tempo and bar lines so lines snap to a beat grid.
- Add a "keep my vibe" mode that learns from lyrics you accept.
