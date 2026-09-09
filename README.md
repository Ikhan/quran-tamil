# Quran Tamil

Paste a Qur'an verse in Arabic (or a reference like `55:13-18`), get the Tamil
translation audio for exactly that verse — and, from the same page, an
Instagram reel, a cover image and a caption for it.

## Why this is not trivial

The Tamil source audio is **one mp3 per surah**, with nothing marking where
verses begin. Surah 2 is a single 1h51m file holding 286 verses. Nothing in the
file says verse 255 starts at 01:23:47, so that has to be derived before a
single verse can be addressed at all.

That derived information is the **verse-timing index** (`data/timings-parts/`),
built offline by `scripts/align_tamil.py` with forced alignment (torchaudio
`MMS_FA`). Everything else in this repo is small by comparison.

A partial index is fully usable: indexed surahs work, the rest report
themselves as not yet indexed rather than failing.

## Requirements

- **Node 20+** (developed on 24) and **Python 3.11+**
- **ffmpeg / ffprobe** on `PATH` — every clip is cut and re-encoded, never
  stream-copied
- Python packages for the aligner only: `torch`, `torchaudio`, `uroman`
- The Tamil surah audio in `data/001.mp3 … 114.mp3` (~25h, not in git — see
  [What is not in git](#what-is-not-in-git))

## Setup

```bash
cp .env.example .env     # then fill it in
npm install
npm run server           # http://localhost:3005
```

`.env`:

| Variable | Meaning |
| --- | --- |
| `PORT` | dashboard port (3005; 3004 is quran-reels, 3003 the hadith app) |
| `SESSION_SECRET` | session signing key — `openssl rand -hex 32` |
| `NODE_ENV` | `development` or `production` |
| `APP_USERNAME` / `APP_PASSWORD` | the single dashboard login |
| `PEXELS_API_KEY` | only for `npm run photos`, the cover-photo fetcher |

`SESSION_SECRET`, `APP_USERNAME` and `APP_PASSWORD` are required at startup —
the server throws rather than fall back to a committed default, because the
dashboard can be exposed through a tunnel. `PORT` and `NODE_ENV` have defaults.

## What you can do from the dashboard

1. **Resolve a verse** — paste Arabic, or type `2:255`, or `55:13-18`. The
   paste is matched against the Tanzil Uthmani text in `data/quran-uthmani.txt`.
2. **Cut the Tamil audio** for that range, optionally **interleaved with Arabic
   recitation** — Arabic 1, Tamil 1, Arabic 2, Tamil 2 — from any of seventeen
   reciters, fetched from everyayah on first use and cached thereafter.
3. **Make a reel** — the Arabic above, the Tamil below, both on screen the whole
   time, the recitation lighting the Arabic word by word. Rendering takes
   minutes, so the page starts the job and polls; a refresh mid-render rejoins
   the same job rather than losing it. One render at a time — a render saturates
   every core.
4. **Make a cover** — Arabic, English and Tamil sura names and the verse range
   over an uploaded photograph.
5. **Copy the caption** — the passage with each Arabic line paired to its Tamil,
   then the attribution and twenty-nine tags. The count is read off the text as
   it stands, so hand-typed tags are counted too.

## From the CLI

```bash
npm run reel -- 110:3                one verse, built and rendered
npm run reel -- 55:13-18 --dark      a passage, dark palette
npm run build:reel -- 112            stage only; then `npm run studio`
```

| Script | Does |
| --- | --- |
| `npm run server` | the dashboard, with reload |
| `npm run start` | the dashboard, without |
| `npm run align` | build the Tamil index (`-- 36 55` for specific surahs) |
| `npm run check` | verify an index: verse count, confidence, duration ratio |
| `npm run photos` | fetch cover photographs from Pexels |
| `npm run studio` | Remotion studio over the staged job |
| `npm run typecheck` | `tsc --noEmit` |

## Building the index

```bash
npm run align                  # all 114 surahs, resumable
npm run align -- 36 55         # specific surahs
FORCE=1 npm run align -- 36    # redo one that already has a part file
```

Resumable by design — it skips surahs that already have a part file, so an
interrupted run costs only the surah in flight. Roughly **1.2x real time on
CPU**, about 30h single-process for the full corpus, so run it with several
workers or overnight. There is no GPU path on an Intel Mac.

Two failure modes are checked for, and both must be, because either alone
misses half the problem:

- **Crushed** — verses jammed end to end, confidence collapsing to ~0.1. Caught
  by the confidence score.
- **Stretched** — a verse spreading across audio that is not its own *while
  still reporting high confidence*, starving every verse after it. Caught only
  by comparing a placement against the length of its text.

Flagged runs are re-aligned between their nearest trusted neighbours. **Never
trust the summary line** — check verse count, confidence, *and* the ratio of
actual to expected duration.

## Layout

```
data/
  001.mp3 … 114.mp3        Tamil surah audio (~25h)
  quran-uthmani.txt        Tanzil Arabic — what a paste is matched against
  ta.tamil.txt             Tanzil Tamil — shown beside the audio, and what
                           the aligner aligns against
  timings-<reciter>.json   Arabic word timings (cpfair/quran-align)
  timings-parts/NNN.json   the Tamil index, one file per surah
  recitations/<reciter>/   Arabic mp3s cached from everyayah
scripts/align_tamil.py     builds the Tamil index
scripts/buildReel.ts       stages (and optionally renders) a reel
src/                       the Remotion composition
server/                    the express app and dashboard
public/audio/              audio staged for a render
output/NNN-<sura>/<range>/ finished reels and their covers, one folder per post
cover-photos/              photographs for covers
backup-truncated-originals/, backup-32kbps-set/   superseded audio, kept
```

Output is one folder per post, so what gets posted together is found together:

```
output/001-al-faatiha/full/reel-001-001-007.mp4
output/001-al-faatiha/full/cover-001-001-007.png
output/055-ar-rahmaan/13-18/reel-055-013-018.mp4
```

A whole sura is `full` rather than `1-286`. Everything rendered before this
layout sits flat in `output/`, and is left there — the history view walks both.

## What is not in git

The audio corpus and everything derived from it stay out: `data/*.mp3` (1.3G),
the `backup-*` sets, `data/timings-parts/`, `data/recitations/`, `cover-photos/`,
`public/audio/`, `public/covers/`, and `output/`. The text sources
(`quran-uthmani.txt`, `ta.tamil.txt`) and the Arabic word timings are tracked —
they are what the code is written against.

The Tamil audio came from truemuslims.net (mirrored at quranplayermp3.com), ten
files of which are truncated and were replaced from
`archive.org/details/tamilquranmp3` — the same recording, complete. There is a
*different* Tamil item on archive.org, `QuranTamilTranslationAudioMp3`, which is
verse **plus tafsir commentary**; do not mix it in.

## Conventions

- `data/quran-uthmani.txt` stays the Tanzil Uthmani edition, unmodified — it is
  what pastes are matched against, and quran-reels resolves against the same file.
- Clips are re-encoded, never stream-copied: a stream copy can only cut on a
  frame boundary and carries the original encoder delay, which is audible.
- Pieces are decoded to common PCM before being joined and encoded once at the
  end — the Arabic arrives at 40–192kbps depending on the reciter, and
  concatenating streams that disagree on rate plays at the wrong speed.
- A reciter id reaches both a URL and a file path, so it is only used after
  `findReciter` has matched it against the list. An unknown one is rejected, not
  replaced with the default.
- The whole verse is always on one frame, sized down if it must be, never
  continued on a second card.
- Off-white, not dark: Tamil carries its meaning in fine strokes — ண against ன,
  ற against ர — and light type on a dark ground blooms at reading size.

`CLAUDE.md` carries the longer reasoning behind these — why the index is shaped
as it is, what was tried and abandoned, and where the audio itself is at fault.
