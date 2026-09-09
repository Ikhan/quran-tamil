"""
Builds the verse-timing index for the Tamil translation audio.

The audio is one mp3 per surah with no internal structure — surah 2 is a single
1h51m file holding 286 verses. This locates each verse inside it by forced
alignment: the Tamil text is known, so the model is asked *where* each word
falls rather than what was said, which is far more reliable than open ASR
(Whisper transcribed this audio badly enough to be useless).

Long files cannot go through the model in one pass, so alignment walks the file
in windows, anchoring each window at the end of the last verse it placed.

Output: one part file per surah, each verse carrying its start, its end, a
confidence that doubles as a quality signal — a collapse from ~0.9 to ~0.1 is
how truncated source files announced themselves during development — and the
per-word spans the model produced on the way to the verse boundary.
"""
import json, os, re, subprocess, sys, tempfile, threading, time
import torch, torchaudio
from uroman import Uroman

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TEXT = os.path.join(DATA, "ta.tamil.txt")

# Seconds of speech per Tamil character, measured across the corpus. Used only
# to decide how many verses to fit in a window — never to place a boundary.
RATE = 0.0747
WINDOW = 120.0          # seconds per model pass; 8-core CPU handles this
FILL = 0.80             # fraction of the window a batch's verses may claim
SAMPLE_RATE = 16000
CONF_MIN = 0.50         # below this, a placement is not trusted
REPAIR_MAX = 200.0      # widest span the repair pass will re-align in one go
MERGE_GAP = 6           # verses that may sit between two runs and still merge
LONE_SPAN = 1.35        # widest window a verse with no companion may be given,
                        # as a multiple of its own estimated length

def _clock(sec):
    sec = int(sec)
    return (f"{sec // 3600}:{sec // 60 % 60:02d}:{sec % 60:02d}" if sec >= 3600
            else f"{sec // 60}:{sec % 60:02d}")


class Progress:
    """
    A live progress line for one surah.

    Driven by audio position rather than window count: a window shrinks when a
    batch is retried, so a window counter would jump backwards while
    seconds-placed only ever moves forward.

    A ticker thread redraws once a second, so the clock keeps moving *between*
    windows. A window is a minute or more of compute, and a line that only
    moves when a window lands is nearly as ambiguous as no line at all - the
    whole point here is to tell a slow surah apart from a wedged one.

    Redirected to a file it prints one line per window instead. Four workers
    sharing a log would otherwise interleave thousands of partial redraws into
    something unreadable, and the log is the only record a killed run leaves.
    """

    WIDTH = 22
    TICK = 1.0

    def __init__(self, surah, total, stream=sys.stdout):
        self.surah, self.total, self.stream = surah, max(total, 0.001), stream
        self.tty = hasattr(stream, "isatty") and stream.isatty()
        self.t0 = self.tp = time.time()
        self.frac, self.label, self.note = 0.0, "aligning", ""
        self.lock = threading.RLock()      # _emit re-enters from set/stage
        self.halt = threading.Event()
        self.thread = None

    def start(self):
        if self.tty:
            self.thread = threading.Thread(target=self._tick, daemon=True)
            self.thread.start()
        else:
            self._emit()
        return self

    def set(self, done, note=""):
        """Report absolute audio seconds placed."""
        with self.lock:
            self.frac = min(1.0, max(0.0, done / self.total))
            self.note = note
        self._emit()

    def stage(self, label, frac=0.0, note=""):
        """Enter a new phase. The ETA clock restarts: phases differ in cost."""
        with self.lock:
            self.label, self.note, self.frac = label, note, min(1.0, max(0.0, frac))
            self.tp = time.time()
        self._emit()

    def close(self):
        """Stop the ticker and clear the line before anything else prints."""
        self.halt.set()
        if self.thread:
            self.thread.join(timeout=2 * self.TICK)
        if self.tty:
            self.stream.write("\r\033[K")
            self.stream.flush()

    def _tick(self):
        while not self.halt.wait(self.TICK):
            self._emit()

    def _emit(self):
        with self.lock:
            frac, label, note = self.frac, self.label, self.note
            elapsed, phase_el = time.time() - self.t0, time.time() - self.tp
            filled = int(round(frac * self.WIDTH))
            eta = (phase_el / frac - phase_el) if frac > 0.02 else None
            txt = (f"surah {self.surah:3d}: {label:<9} "
                   f"|{chr(9608) * filled}{'.' * (self.WIDTH - filled)}| {frac * 100:3.0f}%"
                   f"  {_clock(elapsed)} elapsed"
                   + (f"  ~{_clock(eta)} left" if eta else "")
                   + (f"  {note}" if note else ""))
            if self.tty:
                self.stream.write("\r\033[K" + txt)
            else:
                self.stream.write(txt + "\n")
            self.stream.flush()


_uro = Uroman()


def load_text():
    verses = {}
    with open(TEXT, encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("|")
            if len(parts) >= 3 and parts[0].isdigit():
                verses[(int(parts[0]), int(parts[1]))] = parts[2]
    return verses


def words_of(text):
    """Romanised, punctuation-free tokens — MMS aligns on a-z."""
    rom = _uro.romanize_string(text, lcode="tam").lower()
    return [w for w in (re.sub(r"[^a-z']", "", t) for t in rom.split()) if w]


def duration_of(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def load_window(path, start, length):
    """Decode just the slice we need, so a 2h file never lands in memory."""
    tmp = tempfile.mktemp(suffix=".wav")
    # -nostdin or ffmpeg reads the terminal. Harmless in the foreground; as a
    # background job it earns SIGTTIN, ffmpeg stops, and the aligner blocks on a
    # child that can never run - a wedge that looks exactly like a slow window.
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-ss", f"{start:.3f}", "-t", f"{length:.3f}",
         "-i", path, "-map", "0:a", "-ar", str(SAMPLE_RATE), "-ac", "1", tmp],
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
        """The costly half: depends only on audio, so a retry can reuse it."""
        with torch.inference_mode():
            emission, _ = self.model(wav)
        return emission, wav.size(1) / emission.size(1) / SAMPLE_RATE

    def fits(self, wav, groups):
        """CTC cannot place more tokens than it has frames; check before trying."""
        tokens = sum(len(w) for g in groups for w in g)
        frames = wav.size(1) / SAMPLE_RATE * 50      # model emits ~50 fps
        return frames > tokens * 1.25 + 20

    def align(self, wav, groups, cached=None):
        """
        Returns (start, end, confidence, words) per group, in window-local
        seconds. `words` is (token, start, end) for each word of the group.

        The per-word spans are the model's own output and cost nothing to keep.
        Discarding them was a mistake paid for twice: a translation can only be
        lit line by line without them, and a long verse cannot be cut at a
        clause boundary because nothing says where inside the audio that
        boundary falls. The token is the romanised form actually aligned, not
        the Tamil source word — romanisation does not always split one-for-one,
        so a consumer that needs Tamil words must check the counts agree before
        pairing them by position.
        """
        flat = [w for g in groups for w in g]
        if not flat:
            return []
        emission, ratio = cached if cached else self.emit(wav)
        try:
            spans = self.aligner(emission[0], self.tokenizer(flat))
        except RuntimeError:
            return []                                 # too much text for the audio
        out, i = [], 0
        for g in groups:
            gs = spans[i:i + len(g)]
            i += len(g)
            toks = [t for sp in gs for t in sp]
            score = sum(t.score for t in toks) / max(1, len(toks))
            words = [(w, sp[0].start * ratio, sp[-1].end * ratio)
                     for w, sp in zip(g, gs)]
            out.append((gs[0][0].start * ratio, gs[-1][-1].end * ratio, score,
                        words))
        return out


def word_list(base, words):
    """Word spans moved onto the file's clock and rounded for storage."""
    return [[round(base + st, 3), round(base + en, 3), w] for w, st, en in words]


def idx_of_run(pos, placed, idx):
    """Group index for a placement position, for measuring a run's text."""
    return idx.get(placed[pos]["ayah"], pos)


def repair(al, path, total, placed, groups, labels, est, prog=None):
    """
    Re-aligns verses the first pass got wrong.

    Two signals mark a bad placement, and both are needed. Low confidence
    catches verses crushed together, but misses the opposite failure: in surah
    80 verses 28 and 29 stretched to six times their expected length while
    still reporting 0.81 and 0.74, then starved the nine verses after them.
    Comparing a placement against its text length catches that stretch.

    Each bad run is re-aligned inside the audio between its nearest confident
    neighbours. Bounding it that tightly is what forces a correct distribution:
    the run has nowhere else to spread.
    """
    idx = {lab: k for k, lab in enumerate(labels)}

    def strong(p):
        """A placement solid enough to bound a repair against."""
        k = idx.get(p["ayah"])
        if k is None or p["confidence"] < 0.70:
            return False
        expected, actual = est[k], p["end"] - p["start"]
        return 0.70 <= actual / expected <= 1.40 if expected > 0.3 else True

    def suspect(p):
        k = idx.get(p["ayah"])
        if k is None:
            return False
        if p["confidence"] < CONF_MIN:
            return True
        expected, actual = est[k], p["end"] - p["start"]
        return abs(actual - expected) > max(1.5, 0.6 * expected)

    flags = [suspect(p) for p in placed]

    # A crushed verse is nearly always paying for the one before it, and the
    # thief ends exactly where the victim starts - every healthy verse here has
    # a pause of 0.7s or more before it, these have none. The thief itself
    # usually looks fine: 64:14 ran to 1.52x at 0.89 confidence, inside the 60%
    # the length test allows, so it is never flagged. Repairing the victim
    # alone then re-aligns it inside a region the thief still owns, which
    # cannot help - which is why 49:18, 51:60, 59:20 and 64:15 all survived a
    # repair pass unchanged. Pull the abutting predecessor into the run.
    for z in range(len(placed) - 1, 0, -1):
        if not flags[z] or flags[z - 1]:
            continue
        prev, cur = placed[z - 1], placed[z]
        k = idx.get(prev["ayah"])
        if k is None or est[k] <= 0.3:
            continue
        if (cur["start"] - prev["end"] < 0.25
                and (prev["end"] - prev["start"]) / est[k] > 1.10):
            flags[z - 1] = True

    runs, z = [], 0
    while z < len(placed):
        if flags[z]:
            y = z
            while y + 1 < len(placed) and flags[y + 1]:
                y += 1
            runs.append((z, y))
            z = y + 1
        else:
            z += 1

    # Merge runs separated by only a verse or two. A stretched verse starves the
    # ones after it, and the healthy-looking verse between them is not a usable
    # boundary: repairing either half alone just re-derives the same bad split.
    # A badly stretched verse pushes the ones after it along, so the verses it
    # starves can sit several places further on: in surah 55 verse 68 ran to six
    # times its length and the crushing did not surface until verse 72, with
    # three healthy-looking verses in between. Repairing either half alone just
    # re-derives the same bad split - verse 68 was re-aligned inside the very
    # 34s box that was wrong, and scored no better. Merging has to reach far
    # enough to put the stretch and the crushing in one region.
    #
    # But a merged run that no longer fits REPAIR_MAX is skipped whole, losing
    # the repairs its halves would each have got, so refuse a merge whose text
    # cannot fit the span the repair pass is willing to re-align.
    merged = []
    for run in runs:
        if merged and run[0] - merged[-1][1] <= MERGE_GAP:
            span = sum(est[k] for k in range(idx_of_run(merged[-1][0], placed, idx),
                                             idx_of_run(run[1], placed, idx) + 1))
            if span <= REPAIR_MAX * 0.80:
                merged[-1] = (merged[-1][0], run[1])
                continue
        merged.append(run)
    runs = merged

    repaired = 0
    for r, (a, b) in enumerate(runs, 1):
        if prog:
            prog.stage("repairing", (r - 1) / len(runs), f"run {r}/{len(runs)}")
        # Walk outward past neighbours that are themselves displaced, so the
        # region is bounded by audio we actually trust.
        while a > 0 and not strong(placed[a - 1]):
            a -= 1
        while b + 1 < len(placed) and not strong(placed[b + 1]):
            b += 1
        lo = placed[a - 1]["end"] if a > 0 else 0.0
        hi = placed[b + 1]["start"] if b + 1 < len(placed) else total
        span = hi - lo
        if span <= 1.0 or span > REPAIR_MAX:
            continue
        gs = [groups[idx[placed[z]["ayah"]]] for z in range(a, b + 1)]
        spans = al.align(load_window(path, lo, span), gs)
        if not spans:
            continue
        before = sum(placed[z]["confidence"] for z in range(a, b + 1)) / (b - a + 1)
        after = sum(span[2] for span in spans) / len(spans)
        if after <= before + 0.05:
            continue               # no better: keep the original, flag it instead
        for z, (st, en, sc, ws) in zip(range(a, b + 1), spans):
            placed[z].update(start=round(lo + st, 3), end=round(lo + en, 3),
                             confidence=round(sc, 3), repaired=True,
                             words=word_list(lo, ws))
        repaired += b - a + 1
    return repaired


def place_run(al, path, ks, groups, labels, est, start, limit,
              prog=None, n=None, mark=None, atomic_last=False):
    """
    Place the groups named by `ks`, in order, inside [start, limit] - one
    WINDOW-sized model pass at a time.

    Both the first pass and the tail fix run through here, and they have to:
    the tail fix used to align its whole region in a single pass. That is
    harmless while the region is the handful of trailing verses it was written
    for, but when the first pass stalls early the region is most of the surah,
    and attention cost grows with the square of the window. Surah 2 stalled at
    verse 61 and asked for a 5610s pass - 6.5x the frames of the largest one
    that has ever completed here, so 42x its compute, on a machine that could
    not hold it. Windowing makes the tail fix cost what the first pass costs:
    linear in the audio it covers.

    `atomic_last` puts every verse still to place into the final window
    rather than filling it to FILL. The tail fix needs that and the first pass
    must not have it: aligning a region's verses *together* is what distributes
    them across it, and in a region no bigger than one window there is no next
    window to catch what a partial batch leaves behind. Surah 103's tail was
    21s holding a 2.4s verse and a 15s one; filling to FILL took only the
    first, which then stretched across the whole 21s and starved the second
    into a RuntimeError. Placing both at once is what the single pass this
    replaced did, and it is right for the same reason.

    Returns the placements; the caller decides where they go.
    """
    out, i, offset = [], 0, start
    while i < len(ks):
        room = limit - offset
        if room <= 0.5:
            break
        cap = min(WINDOW, room)

        # Choose the batch from the text first, then size the window to it.
        #
        # A verse aligned with no companion expands to fill whatever window it
        # is given - CTC has no competing transcript to stop it, and it reports
        # high confidence while doing so because every word still matches
        # something. Surah 2 verse 60 is 28.4s of speech; alone in a 120s
        # window it was placed at 107.1s at confidence 0.77, and the offset
        # jumped past 77s of audio belonging to the verses after it. Given
        # verse 61 alongside it, the same model places it at 28.4s.
        #
        # So take a second verse whenever one is left, even where FILL says
        # there is no room: `keep` drops the last of a batch precisely because
        # it is the unreliable one, and a batch of one leaves that rule nothing
        # to drop (`batch[:-1] or batch` hands back the verse it meant to
        # discard).
        last_window = atomic_last and room <= WINDOW
        batch, acc, j = [], 0.0, i
        while j < len(ks) and (j == i or last_window or len(batch) < 2
                               or acc + est[ks[j]] < cap * FILL):
            acc += est[ks[j]]
            batch.append(j)
            j += 1

        # Where no companion exists - the last verse of the run, or one whose
        # text alone outruns the window - bound the stretch with the window
        # instead, since that is the only thing left to bound it with.
        length = cap if len(batch) > 1 else min(cap, max(2.0, acc * LONE_SPAN))
        wav = load_window(path, offset, length)
        cached = al.emit(wav)          # computed once; retries below are free

        # Retry by *shrinking the batch*, never by growing the window. Widening
        # was what killed surah 36: attention cost grows with the square of the
        # window, so a 1.6x widen is a 2.6x memory jump.
        kept, keep = [], []
        while batch:
            spans = al.align(wav, [groups[ks[b]] for b in batch], cached=cached)
            last_is_final = j >= len(ks)
            # A verse against the cut may be clipped, so the next window re-places
            # it - unless the file ends here and there is no next window.
            keep = batch if last_is_final else batch[:-1] or batch
            kept = spans[:len(keep)]
            if (not last_is_final and kept
                    and kept[-1][1] > length - 2.0 and len(batch) > 1):
                batch = batch[:-1]     # too much transcript for this audio
                j -= 1
                continue
            break

        if not kept:
            break

        for b, (st, en, sc, ws) in zip(keep, kept):
            rec = {"ayah": labels[ks[b]], "start": round(offset + st, 3),
                   "end": round(offset + en, 3), "confidence": round(sc, 3),
                   "words": word_list(offset, ws)}
            if mark:
                rec[mark] = True
            out.append(rec)
        new_offset = offset + kept[-1][1]
        if new_offset <= offset + 0.05:      # no progress: bail out, flag it
            break
        offset = new_offset
        i = keep[-1] + 1
        if prog:
            prog.set(offset, f"verse {labels[ks[keep[-1]]]}/{n}")
    return out


def align_surah(al, surah, verses, prog=None):
    path = os.path.join(DATA, f"{surah:03d}.mp3")
    total = duration_of(path)
    n = max(a for (s, a) in verses if s == surah)

    # Label 0 is the bismillah, spoken before verse 1 in every surah but 1 and 9.
    # It is aligned so its audio is consumed rather than bleeding into verse 1.
    groups, labels = [], []
    if surah not in (1, 9):
        groups.append(words_of(verses[(1, 1)]))
        labels.append(0)
    for a in range(1, n + 1):
        groups.append(words_of(verses[(surah, a)]))
        labels.append(a)

    est = [len(" ".join(g)) * RATE for g in groups]
    idx_of = {lab: k for k, lab in enumerate(labels)}
    placed = place_run(al, path, list(range(len(groups))), groups, labels,
                       est, 0.0, total, prog=prog, n=n)

    # Upstream stretching can push the final verses past the end of the file.
    # Re-place them from the last placement we trust — the verses immediately
    # before a gap are typically the displaced ones that caused it.
    done = {p["ayah"] for p in placed}
    if len(done) < len(labels):
        def solid(pl):
            k = idx_of.get(pl["ayah"])
            if k is None or pl["confidence"] < 0.70:
                return False
            e, a = est[k], pl["end"] - pl["start"]
            return 0.70 <= a / e <= 1.40 if e > 0.3 else True

        while len(placed) > 1 and not solid(placed[-1]):
            placed.pop()

        def replan():
            kept = {p["ayah"] for p in placed}
            todo = [k for k, lab in enumerate(labels) if lab not in kept]
            at = placed[-1]["end"] if placed else 0.0
            return todo, at, total - at

        redo, anchor, span = replan()

        # Solidity alone is not enough to trust an anchor. Surah 63 left verse
        # 11 unplaced behind a verse 10 stretched to 1.39x - just inside the
        # 1.40 the test allows - so the anchor was accepted with 2.0s of audio
        # left for 10.9s of text, and the verse was dropped. Audio that cannot
        # plausibly hold the verses still to place means the anchor is wrong
        # however solid it looks, so keep walking back until it can.
        while len(placed) > 1 and redo and span < 0.70 * sum(est[k] for k in redo):
            placed.pop()
            redo, anchor, span = replan()

        if redo and span > 1.0:
            if prog:
                prog.stage("tail fix", note=f"{len(redo)} verses")
            # Bounding the region tightly is what forces a correct distribution,
            # so the anchor walk-back above is left exactly as it was. Only the
            # shape of the pass changes: windowed, not one span-wide pass.
            placed.extend(place_run(al, path, redo, groups, labels, est,
                                    anchor, total, prog=prog, n=n,
                                    mark="tailFix", atomic_last=True))

    repaired = repair(al, path, total, placed, groups, labels, est, prog=prog)
    return {"duration": round(total, 3), "ayahCount": n, "repaired": repaired,
            "placed": placed, "complete": len([p for p in placed if p["ayah"] > 0]) == n}


def main():
    torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "2")))
    verses = load_text()
    targets = [int(a) for a in sys.argv[1:]] or list(range(1, 115))
    al = Aligner()
    out_dir = os.environ.get("OUT", os.path.join(DATA, "timings-parts"))
    os.makedirs(out_dir, exist_ok=True)
    for i, s in enumerate(targets, 1):
        dest = os.path.join(out_dir, f"{s:03d}.json")
        if os.path.exists(dest) and not os.environ.get("FORCE"):
            # Existence is not enough to skip on. A surah whose audio is
            # truncated aligns "successfully" and writes a part file holding
            # only the verses the audio actually contains - surah 75 wrote 31
            # of 40 - and a resume that tests only the path would skip it
            # forever, serving a short sura as though it were whole. Redo
            # anything that did not come out complete.
            try:
                prev = json.load(open(dest))
                if prev.get("complete"):
                    continue
                have = len([p for p in prev.get("placed", []) if p["ayah"] > 0])
                print(f"surah {s:3d}: previous run was incomplete "
                      f"({have}/{prev.get('ayahCount', '?')} verses), redoing", flush=True)
            except (json.JSONDecodeError, OSError, KeyError, TypeError):
                print(f"surah {s:3d}: part file unreadable, redoing", flush=True)
        t0 = time.time()
        # Nothing else is printed until the surah completes, which for surah 2
        # is over two hours. Without this line a healthy run and a wedged one
        # look identical from the terminal, and a killed run leaves no record
        # of what it was working on.
        dur = duration_of(os.path.join(DATA, f"{s:03d}.mp3"))
        print(f"surah {s:3d}: starting ({i}/{len(targets)}), {dur / 60:.1f}m audio",
              flush=True)
        prog = Progress(s, dur).start()
        try:
            res = align_surah(al, s, verses, prog=prog)
        except Exception as exc:                      # noqa: BLE001 - batch must survive
            print(f"surah {s:3d}: FAILED {type(exc).__name__}: {exc}", flush=True)
            with open(dest.replace(".json", ".error"), "w") as fh:
                fh.write(f"{type(exc).__name__}: {exc}\n")
            continue
        finally:
            # Before any other print: the ticker owns the current line until
            # it is stopped, and a summary written into it would be overdrawn.
            prog.close()
        res["surah"] = s
        res["alignedIn"] = round(time.time() - t0, 1)
        # Write then rename. A part file killed mid-write would otherwise be
        # left truncated, and the resume check only tests that the path exists
        # — so a corrupt surah would be skipped forever and silently serve
        # wrong audio. Rename is atomic: the file is either whole or absent.
        tmp = f"{dest}.tmp"
        with open(tmp, "w") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, dest)
        got = [p for p in res["placed"] if p["ayah"] > 0]
        low = [p for p in got if p["confidence"] < 0.5]
        print(f"surah {s:3d}: {len(got)}/{res['ayahCount']} verses, "
              f"{len(low)} low-conf, {res['repaired']} repaired, "
              f"{res['duration']:.0f}s audio, {res['alignedIn']:.0f}s", flush=True)


if __name__ == "__main__":
    main()
