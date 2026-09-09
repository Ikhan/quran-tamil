# Quran Tamil

Paste a Qur'an verse in Arabic (or a reference), get the Tamil translation audio
for exactly that verse.

## Why this is not trivial

The source audio is **one mp3 per surah** with nothing marking where verses
begin. Surah 2 is a single 1h51m file containing 286 verses. Nothing in the file
says verse 255 starts at 01:23:47, so that information has to be derived before a
single verse can be addressed at all.

That derived information is the **verse-timing index** (`data/timings-parts/`),
built offline by `scripts/align_tamil.py`. Everything else here is small.

## Layout

```
data/
  001.mp3 … 114.mp3     surah audio (Tamil translation, ~25h total)
  quran-uthmani.txt     Tanzil Arabic — what a paste is matched against
  ta.tamil.txt          Tanzil Tamil — shown beside the audio, and the
                        transcript the aligner aligns against
  timings-<reciter>.json  Arabic word timings (cpfair/quran-align), one per
                        reciter — what lights a word as it is recited
  timings-parts/NNN.json  the Tamil index, one file per surah (gitignored)
  recitations/<reciter>/  Arabic mp3s cached from everyayah (gitignored)
scripts/align_tamil.py  builds the Tamil index
scripts/buildReel.ts    stages (and optionally renders) a reel
src/                    the Remotion composition
public/audio/           audio staged for a render (gitignored, regenerable)
output/NNN-<sura>/<range>/  finished reels and their covers, one folder per post
server/                 express app (same shape as ../quran-reels)
backup-truncated-originals/  the 10 damaged files this project replaced
```

## Running

```bash
cp .env.example .env     # set SESSION_SECRET, APP_USERNAME, APP_PASSWORD
npm install
npm run server           # http://localhost:3005
```

## Building the index

```bash
npm run align            # all 114 surahs, resumable
npm run align -- 36 55   # specific surahs
FORCE=1 npm run align -- 36   # redo one that already has a part file
```

Resumable by design: it skips surahs that already have a part file, so an
interrupted run costs only the surah in flight. Roughly **1.2x real time on
CPU** — about 30h single-process for the full 25h corpus, so run it with several
workers or overnight. There is no GPU path on an Intel Mac.

A partial index is fully usable. Surahs that are indexed work; the rest report
themselves as not yet indexed rather than failing.

## How the index is built, and how it fails

Forced alignment (torchaudio `MMS_FA`): the Tamil text is known, so the model is
asked *where* each word falls rather than what was said. Open ASR was tried
first and was far too poor on this audio to use.

Two failure modes matter, and **both are detected, because either alone misses
half the problem**:

- **Crushed** — verses jammed end to end with confidence collapsing to ~0.1.
  Caught by the confidence score.
- **Stretched** — a verse spreading across audio that is not its own while
  *still reporting high confidence*, starving every verse after it. Surah 80
  verse 37 did exactly this at 0.909. Caught only by comparing a placement
  against the length of its text.

Flagged runs are re-aligned inside the audio between their nearest trusted
neighbours; bounding the region tightly is what forces a correct distribution.

Each placement also carries `words`: `[start, end, token]` for every word,
where the token is the **romanised** form that was aligned rather than the
Tamil source word. Romanisation does not always split one for one — about one
verse in six comes out with a different token count from a naive split of the
Tamil — so anything pairing spans with Tamil words must check the counts agree
first and fall back to the verse boundary when they do not.

The spans cost nothing to keep: the model produces them on the way to the verse
boundary, and they were being thrown away. Two things need them — cutting a long
verse at a clause boundary, which requires knowing where inside the audio that
clause falls, and lighting a translation word by word rather than line by line.

**When reviewing alignment output, never trust the summary line.** During
development it twice reported success while silently dropping verses or leaving
a verse misplaced. Check verse count, confidence, *and* the ratio of actual to
expected duration.

## Arabic recitation alongside the Tamil

The dashboard can pair each verse with its Arabic recitation, alternating one
verse at a time: Arabic 1, Tamil 1, Arabic 2, Tamil 2. Interleaving is the
whole point of having an index — appending a Tamil surah after an Arabic one
would need no timings at all.

The seventeen reciters are ported from `../quran-reels/src/lib/reciters.ts`,
minus that project's `coverage` field: coverage records whether a reciter has
word-level timings, and nothing here lights words. Audio comes from everyayah
on first use and is then cached.

A reciter id reaches both a URL and a file path, so it is only ever used after
`findReciter` has matched it against the list. An unknown one is rejected
rather than replaced with the default — quietly substituting a voice hands back
a clip the operator did not ask for.

Pieces are decoded to a common PCM format before being joined. The Arabic
arrives at whatever rate that reciter was encoded at (40–192kbps) and the Tamil
is cut live from a surah mp3; concatenating streams that disagree on rate plays
at the wrong speed. Joining as PCM and encoding once at the end also keeps the
Tamil from being encoded twice.

Interleaving needs a boundary for **every** verse, not just the two ends of the
range. A plain Tamil cut only reads the first and last, so a hole in the middle
of the index passes unnoticed there; here it would silently drop a verse out of
the alternation, so the build refuses instead.

## Reels

From the dashboard: resolve a verse, pick a reciter, press **Make a reel**.
Rendering takes minutes, so the page starts the job and polls `/api/reels/progress`
— a refresh mid-render rejoins the same job rather than losing it. Only one
render runs at a time: a render saturates every core, so two at once would take
longer than the same two in sequence, and would fight over the single staged
job file.

A finished reel and its cover land in the same folder — `output/`, then the
sura, then the range:

```
output/001-al-faatiha/full/reel-001-001-007.mp4
output/001-al-faatiha/full/cover-001-001-007.png
output/055-ar-rahmaan/13-18/reel-055-013-018.mp4
```

A whole sura is `full` rather than `1-7`: it is the case you want to recognise
at a glance, and `1-286` says nothing that `full` does not say better. One verse
is its own number. The sura folder keeps its number so the directory sorts into
mushaf order and two suras that slug alike stay apart, and the file names keep
carrying the range as well — a file dragged out into a scheduler still says what
it is.

Everything rendered before this layout sits flat in `output/`. It is left there:
the dashboard's history walks both, and moving files under someone would break
whatever already points at them.

From the CLI, over the same builder:

```bash
npm run reel -- 110:3                 one verse, built and rendered
npm run reel -- 55:13-18 --dark       a passage, dark palette
npm run build:reel -- 112             stage only; then `npm run studio`
```

The card is the form Tamil Qur'an posts already take: the Arabic above, the
Tamil below, both on screen the whole time. The recitation lights the Arabic
word by word from the vendored `quran-align` timings; the translation lights a
line at a time, each line given the share of the verse's audio its length
implies.

**The whole verse is always on one frame**, sized down if it must be, never
continued on a second card — a split would put the highlight on a page the
viewer is not looking at. `layoutVerse` sizes both scripts on one parameter so
they shrink in proportion; fitting them one after the other left the Arabic at
its floor and crushed the Tamil while a third of the card stayed empty.

That function is called by both the composition and the build script, and it
has to be: the script gives each line its share of the audio, the composition
draws the lines, and if they disagreed about where the text breaks then every
highlight after the first would light the wrong line.

A verse under 30px or a reel over 90s is not worth posting — 97% of the Qur'an
clears both. The rest want splitting at a clause boundary, which is a judgement
call about Arabic-to-Tamil correspondence and belongs to a person, not to a
proportional cut.

Off-white, not dark: Tamil carries its meaning in fine strokes — ண against ன,
ற against ர — and light type on a dark ground blooms just enough at reading
size to blur them.

## Captions

The dashboard builds the Instagram caption for a resolved range, in
`server/public/caption.js`. Built on the page rather than the server: the
verses came back with the resolve, the reciter list is loaded, and the Tamil
sura name was already fetched for the cover — a route for this would be a round
trip to reassemble what is already in the room.

The caption is the passage and its attribution, and nothing else. Each Arabic
line carries its Tamil directly beneath it — paired rather than one Arabic block
then one Tamil block, because a reader following along needs the translation
under the line it translates. Then the sura, the range, the reciter, and the
tags. Both texts come through verbatim; nothing reformats scripture.

An earlier version offered three composed openings — a word gloss, a question,
a held clause — each scaffolding a hook and leaving `[[ ... ]]` markers for the
lines only a person can write. The markers were the part that had to be deleted
every time, so the whole apparatus went. Anything wanted above the verses is
typed into the box, which is editable until the next resolve.

Nothing is prefixed to the Tamil sura name: the vendored names already carry
ஸூரத்துல், so "சூரா ஸூரத்துல் பகரா" is what a prefix would produce. Nor is
there a per-sura tag — one built from the name lands on `#surahalfaatiha`,
which nobody searches for and which spends one of the thirty Instagram allows.

Twenty-nine tags, fixed, with one slot spare. The copy button reports the count
off the text as it stands, so a tag pasted in by hand is counted too and an edit
that goes over thirty is caught before the paste rather than after.

## Cover images

The still that fronts a reel: the Arabic name of the sura, the English name, the
Tamil name, the verse range, over an uploaded photograph. Made from the
dashboard once a verse is resolved — everything but the photograph is filled in
from what was found.

Tamil sura names are vendored in `server/services/surahNamesTamil.ts`, taken
once from tamililquran.org's index. No API serves them: quran.com lists Tamil as
a language but falls back to English names, Wikidata has one of the 114, and
Tamil Wikipedia spells its own convention two ways. They are also a
transliteration (ஸூரத்துல் பகரா), not a translation ("The Cow") — which is what
the APIs would have given.

Corrections typed into the dashboard are stored in
`data/surah-names-tamil.json` and win over the vendored name. Typing a name back
to what the vendored list says removes the override rather than storing a
duplicate.

The cover is written beside the reel for the same range — one folder per post,
so what gets posted together is found together. The cover is set in the same
off-white, ink and crimson as the verse card. The green-and-yellow this genre
is full of was deliberately not used: that
combination is the most recognisable thing several established Tamil accounts
have, and borrowing it makes this look like their output rather than its own.

## The source audio was incomplete

Ten files from the original source (truemuslims.net, mirrored identically at
quranplayermp3.com) are truncated — surah 94 was 1.1 seconds, surah 15 held
about a quarter of its verses. They were replaced from
`archive.org/details/tamilquranmp3`, which is the **same recording, complete**
(surah 36 matches to 0.03s; surah 15 came in at 846.1s against 846.2s predicted
from text length).

The originals are kept in `backup-truncated-originals/`.

Note there is a *different* Tamil item on archive.org
(`QuranTamilTranslationAudioMp3`) which is verse **plus tafsir commentary**.
Do not mix it in — clips cut from it contain commentary.

## Conventions

- The Arabic text file must stay the Tanzil Uthmani edition, unmodified — it is
  what pastes are matched against, and quran-reels resolves against the same file.
- Clips are re-encoded, never stream-copied: a stream copy can only cut on a
  frame boundary and carries the original encoder delay, which is audible.
- `RATE` in the aligner (seconds per Tamil character) plans windows and flags
  suspects. It never sets a boundary. It runs slightly hot, so it over-flags
  rather than under-flags.
