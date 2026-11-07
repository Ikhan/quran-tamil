"""
Word timings for an everyayah reciter that quran-align does not cover.

    python3 scripts/align_arabic.py <reciter> [surah | surah:from-to] ...
    FORCE=1 python3 scripts/align_arabic.py <reciter> 36
    ALIGN_OUT=/tmp/check python3 scripts/align_arabic.py Alafasy_128kbps 1 36
    RECHECK=1 python3 scripts/align_arabic.py <reciter>   # re-judge stored tails

Output: `data/timings-<reciter>.json`, the same shape the server reads for
quran-align reciters — `[wordStart, wordEnd, startMs, endMs]` per word, word
indices into `quran-uthmani.txt` split on spaces with the Basmala stripped
from verse 1. Work is kept per surah in `data/arabic-timings-parts/<reciter>/`
so an interrupted run loses only the surah in flight; the merged file is
rewritten after every surah, so a partial run is usable as it goes.

Same method as align_tamil.py (torchaudio MMS_FA, the text is known and only
its position is asked for), but far simpler: everyayah serves one file per
verse, so the verse boundaries are given and only words have to be placed.
Checked against quran-align on Alafasy before being trusted for anyone else.

A verse that fails a check is kept in the part file with its reason and left
out of the merged file. The reel builder then refuses it by name, which is the
right outcome: a missing verse is an error message, a misplaced one is the
wrong word of scripture lit on screen.
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request
import torch, torchaudio
from uroman import Uroman

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TEXT = os.path.join(DATA, "quran-uthmani.txt")
# Where parts and the merged file go. Overridden only to check the method on a
# reciter quran-align already covers without overwriting that reciter's file.
OUT = os.environ.get("ALIGN_OUT", DATA)
SAMPLE_RATE = 16000
MIN_BYTES = 2048            # below this a "download" is an error body
WORD_GAP_MS = 10            # quran-align's gap between one word and the next

# The words must reach the end of the speech. A placement that leaves more than
# this much recitation after the last word has put the verse somewhere it is
# not — what "ys" did with Ya-Sin's Basmala before the letters were spelled
# out, leaving ~7s. A held final vowel legitimately leaves up to ~3s: the
# model closes the word when its letters end, not when the voice does (70:11,
# "bibaniih" placed to 8.9s, voice level until 10.7s).
TAIL_SLACK_S = 3.0
# Speech ends at the last frame within this many dB of the verse's typical
# level. A fixed floor counted room echo as recitation: Ajamy's 66:8 trails
# 2.5s of echo at -24 to -36 dB, and his files end in 2-5s of silence.
SPEECH_DROP_DB = 12
# One word may hold a long madd or a pause, but not this long.
MAX_WORD_S = 8.0
MIN_WORD_S = 0.06

BASMALA = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ".split()
DIACRITICS = re.compile(r"[\u064B-\u0655\u0670\u06D6-\u06ED]")   # incl. maddah, U+0653

# The disjointed letters are recited by their names. Romanised as written they
# collapse — Ya-Sin becomes "ys", two characters for two seconds of audio.
LETTER_NAMES = {
    "ا": "alif", "ل": "laam", "م": "miim", "ص": "saad", "ر": "raa",
    "ك": "kaaf", "ه": "haa", "ي": "yaa", "ع": "ayn", "ط": "taa",
    "س": "siin", "ح": "haa", "ق": "qaaf", "ن": "nuun",
}
MUQATTAAT = {
    "الٓمٓ", "الٓمٓصٓ", "الٓر", "الٓمٓر", "كٓهيعٓصٓ", "طه", "طسٓمٓ", "طسٓ",
    "يسٓ", "صٓ", "حمٓ", "عٓسٓقٓ", "قٓ", "نٓ",
}

_uro = Uroman()
# One thread per process: run as several workers, each torch defaulting to every
# core oversubscribed eight cores to a load of ~75 and ran ten times slower.
torch.set_num_threads(1)


def skeleton(word):
    return DIACRITICS.sub("", word)


def load_text():
    verses = {}
    with open(TEXT, encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("|")
            if len(parts) == 3 and parts[0].isdigit():
                verses[(int(parts[0]), int(parts[1]))] = parts[2].split()
    return verses


def verse_words(surah, ayah, words):
    """The words the timings index into: Basmala stripped, as the server does."""
    if ayah == 1 and surah != 1 and \
            [skeleton(w) for w in words[:4]] == [skeleton(w) for w in BASMALA]:
        return words[4:], True
    return words, False


def token(word, opening):
    """One a-z token per Arabic word, so indices stay one-for-one."""
    if opening and word in MUQATTAAT:
        return "".join(LETTER_NAMES[c] for c in skeleton(word))
    return re.sub(r"[^a-z']", "", _uro.romanize_string(word, lcode="ara").lower())


def fetch(reciter, surah, ayah):
    """Shares the dashboard's cache, data/recitations/<reciter>/SSSAAA.mp3."""
    name = f"{surah:03d}{ayah:03d}.mp3"
    dest = os.path.join(DATA, "recitations", reciter, name)
    if os.path.exists(dest):
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    url = f"https://everyayah.com/data/{reciter}/{name}"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                body = resp.read()
            break
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    is_mp3 = body[:3] == b"ID3" or (body[0] == 0xFF and body[1] & 0xE0 == 0xE0)
    if len(body) < MIN_BYTES or not is_mp3:
        raise RuntimeError(f"{url}: not an mp3 ({len(body)} bytes)")
    tmp = dest + ".part"
    with open(tmp, "wb") as fh:
        fh.write(body)
    os.replace(tmp, dest)
    return dest


def decode(path):
    tmp = tempfile.mktemp(suffix=".wav")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", path,
                    "-map", "0:a", "-ar", str(SAMPLE_RATE), "-ac", "1", tmp],
                   check=True)
    wav, _ = torchaudio.load(tmp)
    os.remove(tmp)
    return wav


class Aligner:
    def __init__(self):
        bundle = torchaudio.pipelines.MMS_FA
        self.model = bundle.get_model()
        self.tokenizer = bundle.get_tokenizer()
        self.aligner = bundle.get_aligner()

    def emit(self, wav):
        """The costly half: depends only on the audio, so both readings share it."""
        with torch.inference_mode():
            emission, _ = self.model(wav)
        return emission, wav.size(1) / emission.size(1) / SAMPLE_RATE

    def place(self, emitted, tokens):
        """(start_s, end_s) per token and the mean token confidence."""
        emission, ratio = emitted
        spans = self.aligner(emission[0], self.tokenizer(tokens))
        scores = [t.score for sp in spans for t in sp]
        placed = [(sp[0].start * ratio, sp[-1].end * ratio) for sp in spans]
        return placed, sum(scores) / len(scores)


def align_verse(al, reciter, surah, ayah, words):
    """
    Everyayah is not consistent about the Basmala: some reciters open verse 1
    with it, some do not. Both readings are aligned and the one the model
    fits better is kept.
    """
    wav = decode(fetch(reciter, surah, ayah))
    tokens = [token(w, ayah <= 2) for w in words]
    readings = [(tokens, 0)]
    if ayah == 1 and surah not in (1, 9):
        readings.append(([token(w, False) for w in BASMALA] + tokens, 4))

    emitted = al.emit(wav)
    best = None
    for toks, skip in readings:
        try:
            placed, score = al.place(emitted, toks)
        except RuntimeError:
            continue                    # more text than the audio has frames
        if best is None or score > best[1]:
            best = (placed[skip:], score, skip > 0)
    if best is None:
        return {"surah": surah, "ayah": ayah, "segments": [],
                "flag": "text does not fit the audio"}

    placed, score, basmala = best
    segments = [[i, i + 1, round(s * 1000), round(e * 1000)]
                for i, (s, e) in enumerate(placed)]
    for cur, nxt in zip(segments, segments[1:]):
        cur[3] = max(cur[3], nxt[2] - WORD_GAP_MS)

    entry = {"surah": surah, "ayah": ayah, "segments": segments,
             "score": round(score, 3), "basmala": basmala,
             "aligned_end": segments[-1][3], "flag": check(placed)}
    return settle_tail(entry, speech_end(wav))


def settle_tail(entry, spoken_until):
    """
    Judges the gap after the last word, and closes it if it is a held vowel.

    `aligned_end` is where the model put the last word's end and is never
    overwritten, so this can be rerun over a finished part (RECHECK=1) without
    judging its own extension.
    """
    raw = entry["aligned_end"] / 1000
    tail = spoken_until - raw
    if entry["flag"] is None and tail > TAIL_SLACK_S:
        entry["flag"] = f"last word ends {tail:.1f}s before the recitation does"
    if entry["flag"] is None:
        entry["segments"][-1][3] = max(entry["aligned_end"],
                                       round(spoken_until * 1000))
    return entry


def speech_end(wav):
    """Seconds to the last 20ms frame within SPEECH_DROP_DB of the voice."""
    frame = SAMPLE_RATE // 50
    usable = wav[0, : wav.size(1) // frame * frame].reshape(-1, frame)
    db = 20 * usable.pow(2).mean(dim=1).sqrt().clamp(min=1e-6).log10()
    voiced = db[db > -50]
    if len(voiced) == 0:
        return 0.0
    loud = (db > voiced.median() - SPEECH_DROP_DB).nonzero()
    return (loud[-1].item() + 1) / 50


def check(placed):
    """The reason a word placement cannot be trusted, or None."""
    for i, (s, e) in enumerate(placed):
        if e - s > MAX_WORD_S:
            return f"word {i} spans {e - s:.1f}s"
        if e - s < MIN_WORD_S:
            return f"word {i} crushed to {(e - s) * 1000:.0f}ms"
    return None


def part_path(reciter, surah):
    return os.path.join(OUT, "arabic-timings-parts", reciter, f"{surah:03d}.json")


def load_part(reciter, surah):
    try:
        with open(part_path(reciter, surah), encoding="utf-8") as fh:
            return {e["ayah"]: e for e in json.load(fh)}
    except FileNotFoundError:
        return {}


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, path)


def merge(reciter):
    """Every unflagged verse from every part, in mushaf order."""
    out, flagged = [], 0
    for surah in range(1, 115):
        for ayah, entry in sorted(load_part(reciter, surah).items()):
            if entry.get("flag"):
                flagged += 1
                continue
            out.append({"surah": surah, "ayah": ayah,
                        "segments": entry["segments"]})
    save_json(os.path.join(OUT, f"timings-{reciter}.json"), out)
    return len(out), flagged


def parse_targets(args, text):
    """'2' -> all of surah 2; '2:40-50' -> those verses only."""
    counts = {}
    for s, a in text:
        counts[s] = max(counts.get(s, 0), a)
    targets = []
    for arg in args or [str(s) for s in range(1, 115)]:
        m = re.fullmatch(r"(\d+)(?::(\d+)(?:-(\d+))?)?", arg)
        if not m or not 1 <= int(m[1]) <= 114:
            sys.exit(f"bad target: {arg}")
        surah = int(m[1])
        lo = int(m[2]) if m[2] else 1
        hi = int(m[3]) if m[3] else (lo if m[2] else counts[surah])
        targets.append((surah, range(lo, min(hi, counts[surah]) + 1)))
    return targets


def recheck(reciter, targets):
    """
    Re-judges the tail of every stored verse with the current check, without
    the model: only the audio is read again. For parts written before the
    check changed. A verse flagged for anything other than its tail keeps it.
    """
    for surah, _ in targets:
        part = load_part(reciter, surah)
        if not part:
            continue
        before = sum(1 for e in part.values() if e.get("flag"))
        for ayah, entry in part.items():
            flag = entry.get("flag")
            if not entry["segments"] or (flag and not flag.startswith("last word")):
                continue
            entry["flag"] = None
            entry.setdefault("aligned_end", entry["segments"][-1][3])
            wav = decode(fetch(reciter, surah, ayah))
            settle_tail(entry, speech_end(wav))
        save_json(part_path(reciter, surah), [part[a] for a in sorted(part)])
        after = [f"{a}: {e['flag']}" for a, e in sorted(part.items()) if e.get("flag")]
        print(f"{surah:3d}  flagged {before} -> {len(after)}", flush=True)
        for line in after:
            print(f"       {line}", flush=True)
    kept, flagged = merge(reciter)
    print(f"timings-{reciter}.json: {kept} verses, {flagged} flagged and left out")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    reciter = sys.argv[1]
    if not re.fullmatch(r"[A-Za-z0-9_.\-]+", reciter):
        sys.exit(f"bad reciter id: {reciter}")
    text = load_text()
    if os.environ.get("RECHECK") == "1":
        recheck(reciter, parse_targets(sys.argv[2:], text))
        return
    force = os.environ.get("FORCE") == "1"
    al = Aligner()

    for surah, ayahs in parse_targets(sys.argv[2:], text):
        part = load_part(reciter, surah)
        todo = [a for a in ayahs if force or a not in part]
        if not todo:
            print(f"{surah:3d}  done already", flush=True)
            continue
        started = time.time()
        for ayah in todo:
            words, _ = verse_words(surah, ayah, text[(surah, ayah)])
            part[ayah] = align_verse(al, reciter, surah, ayah, words)
            # Saved per verse: surah 2 alone is hours, too much to lose to a crash.
            save_json(part_path(reciter, surah),
                      [part[a] for a in sorted(part)])
        bad = [f"{a}: {part[a]['flag']}" for a in todo if part[a].get("flag")]
        print(f"{surah:3d}  {len(todo)} verses in {time.time() - started:.0f}s"
              f"  flagged {len(bad)}", flush=True)
        for line in bad:
            print(f"       {line}", flush=True)
        kept, flagged = merge(reciter)

    kept, flagged = merge(reciter)
    print(f"timings-{reciter}.json: {kept} verses, {flagged} flagged and left out")


if __name__ == "__main__":
    main()
