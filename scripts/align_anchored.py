"""
Aligns a surah the ordinary aligner cannot: verify each window before advancing.

align_tamil.py walks a surah as one chain - every window starts where the last
one ended - and takes each result on faith. That is fine for 84 surahs. It is
not fine for surah 2, which failed twice at 5h10m and 6h55m: each verse ran a
few percent long, the chain drifted ~114s off by verse 60, and from there the
model was being handed audio that was not the text it was looking for. Nothing
noticed for hours, because nothing ever checked.

Three things differ here, and all three were measured before this was written:

  packed windows   Verses fill ~FILL of the window, so none can stretch to fit
                   it. Surah 2 verse 60 alone in a 120s window was placed at
                   107.1s (its true length is 28.4s) at confidence 0.77 - the
                   stretch reports high confidence, so only the packing
                   prevents it.

  edges discarded  A probe over verses 250-259 placed the interior at ratios
                   0.93-1.01 while 250-252 were crushed against the window
                   start (conf 0.09-0.17) and 259 stretched to 209s against
                   the end. Only the verified leading run is ever kept.

  re-anchor        When a window yields nothing trustworthy, the next attempt
                   starts from the position the text proportion predicts, not
                   from the placement that just failed. Error cannot accumulate
                   across a reset. Prediction is good to about +-150s across
                   surah 2 (-114s early, +60s by verse 255), which PROBE covers.

Usage:
    python3 scripts/align_anchored.py 2
    PROBE=380 python3 scripts/align_anchored.py 2      smaller windows, faster
    CONF_OK=0.55 python3 scripts/align_anchored.py 16  accept softer placements
    OUT=/tmp/x python3 scripts/align_anchored.py 2     write somewhere else
    ONLY=250-259 python3 scripts/align_anchored.py 2   one stretch, for checking

Writes the same part-file shape align_tamil.py writes, so check_index.py reads
it without knowing the difference.
"""
import importlib.util, json, os, sys, time

T0 = time.time()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "align_tamil", os.path.join(ROOT, "scripts", "align_tamil.py"))
at = importlib.util.module_from_spec(spec)
spec.loader.exec_module(at)

PROBE = float(os.environ.get("PROBE", "360"))   # window seconds; cost is quadratic
FILL = 0.80                  # share of the window the batch's text may claim
# Below this a placement is not trusted to advance on. Deliberately stricter
# than align_tamil's CONF_MIN of 0.50: this tool advances on what it accepts,
# so a soft placement here misplaces everything after it. But it can be too
# strict for audio the model reads poorly throughout - surah 24 spent four
# anchors and ~45 minutes each refusing verses 35 and 36 at 0.58, then a
# bounded pass placed them at the very spans this tool had itself found three
# times over. Lower it for such a surah rather than paying that grind.
CONF_OK = float(os.environ.get("CONF_OK") or 0.70)
RATIO_LO, RATIO_HI = 0.60, 1.40
MAX_TRIES = 4                # re-anchor attempts before a verse is given up on
PAD = 2                      # verses of context ahead of a guessed anchor
NUDGE = (0.0, -90.0, 90.0, -180.0)   # offsets tried around the prediction
BUDGET = float(os.environ.get("BUDGET", "0")) or None    # seconds, 0 = no limit


def acceptable(dur, est, conf):
    if conf < CONF_OK:
        return False
    return RATIO_LO <= dur / est <= RATIO_HI if est > 0.3 else True


def align_surah(al, surah, verses, only=None):
    global T0
    path = os.path.join(at.DATA, f"{surah:03d}.mp3")
    total = at.duration_of(path)
    n = max(a for (s, a) in verses if s == surah)

    groups, labels = [], []
    if surah not in (1, 9):
        groups.append(at.words_of(verses[(1, 1)]))     # bismillah, as label 0
        labels.append(0)
    for a in range(1, n + 1):
        groups.append(at.words_of(verses[(surah, a)]))
        labels.append(a)
    est = [len(" ".join(g)) * at.RATE for g in groups]

    # Where the text proportion says each verse begins. Never used to set a
    # boundary - only to re-anchor a window that produced nothing usable.
    cum, predict = 0.0, []
    for e in est:
        predict.append(total * cum / sum(est))
        cum += e

    lo, hi = (0, len(groups) - 1) if not only else only
    placed, i, tries = [], lo, 0
    t = 0.0 if not only else predict[lo]
    anchored = not only          # is `t` a boundary we verified, or a guess?

    while i <= hi:
        if BUDGET and time.time() - T0 > BUDGET:
            print(f"  budget reached, stopping at verse {labels[i]}", flush=True)
            break

        # Ahead of a guessed anchor, put a couple of already-known verses in
        # front of the one we want. Whatever audio sits between the window's
        # start and the first verse's true beginning is absorbed by that first
        # verse - it stretches backwards over sound it does not own and fails
        # its own ratio check. That is what rejected a perfectly good anchor at
        # 5381.2s: verse 250 began 24s into the window and was blamed for the
        # 24s in front of it. Padding gives the window an edge verse to spoil
        # that we were not going to keep anyway.
        pad = 0 if anchored else min(PAD, i - lo)
        first = i - pad
        t_win = t if anchored else max(0.0, t - sum(est[first:i]) - 15.0)
        length = min(PROBE, total - t_win)
        if length <= 1.0:
            break

        batch, acc, j = [], 0.0, first
        while j <= hi and (j == first or acc + est[j] < length * FILL):
            acc += est[j]
            batch.append(j)
            j += 1

        wav = at.load_window(path, t_win, length)
        spans = al.align(wav, [groups[k] for k in batch])

        # the last verse always stretches into whatever is left of the window,
        # and the padding verses are context we already have - neither is kept
        keep = batch if batch[-1] == hi else batch[:-1]
        good, why = [], ""
        for k, sp in zip(keep, spans[:len(keep)]):
            if k < i:
                continue                    # padding: aligned for context only
            st, en, sc, ws = sp
            if labels[k] == 0 and not acceptable(en - st, est[k], sc):
                # The bismillah is not a verse anyone cuts, its text is
                # borrowed from surah 1, and the audio in front of it often
                # carries a lead-in it gets blamed for - surah 14 put it at
                # ratio 1.47 against a limit of 1.40 and spent four anchors and
                # twenty minutes refusing to start. It is allowed to fail
                # without stopping the run.
                continue
            if not acceptable(en - st, est[k], sc):
                # Say which test failed and by how much. A rejection with no
                # numbers is unreadable: the run that prompted this printed
                # "nothing trustworthy" four times and left nothing to reason
                # from.
                why = (f"verse {labels[k]} ratio {(en - st) / est[k]:.2f}"
                       f" ({en - st:.1f}s vs est {est[k]:.1f}s) conf {sc:.2f}")
                break                       # stop at the first doubtful one
            good.append((k, st, en, sc, ws))

        if not good:
            tries += 1
            if tries >= MAX_TRIES:
                print(f"  verse {labels[i]}: no anchor held after {tries}, skipping",
                      flush=True)
                i += 1
                tries = 0
                anchored = False
                continue
            seen = set()
            for nud in NUDGE[tries - 1:]:
                cand = max(0.0, min(total - 5.0, predict[i] + nud))
                if round(cand, 1) != round(t_win, 1) and round(cand, 1) not in seen:
                    t = cand
                    break
                seen.add(round(cand, 1))
            else:
                t = min(total - 5.0, t_win + 45.0)   # nothing new: step forward
            anchored = False
            print(f"  window {t_win:.1f}+{length:.0f}s rejected: {why or 'no spans'}"
                  f" -> re-anchor {t:.1f}s (attempt {tries})", flush=True)
            continue

        tries = 0
        for k, st, en, sc, ws in good:
            placed.append({"ayah": labels[k], "start": round(t_win + st, 3),
                           "end": round(t_win + en, 3), "confidence": round(sc, 3),
                           "words": at.word_list(t_win, ws)})
        i = good[-1][0] + 1
        t = t_win + good[-1][2]
        anchored = True
        print(f"  verses {labels[good[0][0]]}-{labels[good[-1][0]]} placed"
              f" ({len(good)}), now {t:.1f}s of {total:.0f}s"
              f" [{len(placed)}/{len(groups)}]", flush=True)

    repaired = at.repair(al, path, total, placed, groups, labels, est)
    got = len([p for p in placed if p["ayah"] > 0])
    return {"duration": round(total, 3), "ayahCount": n, "repaired": repaired,
            "placed": placed, "complete": got == n}


def main():
    surah = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    only = None
    if os.environ.get("ONLY"):
        a, b = os.environ["ONLY"].split("-")
        only = (int(a), int(b))          # group indices == ayah numbers here
    verses = at.load_text()
    al = at.Aligner()
    t0 = time.time()
    globals()['T0'] = t0
    print(f"surah {surah}: anchored alignment, PROBE={PROBE:.0f}s", flush=True)
    res = align_surah(al, surah, verses, only=only)
    res["surah"] = surah
    res["alignedIn"] = round(time.time() - t0, 1)
    res["method"] = "anchored"

    out_dir = os.environ.get("OUT", os.path.join(at.DATA, "timings-parts"))
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, f"{surah:03d}.json")
    tmp = f"{dest}.tmp"
    with open(tmp, "w") as fh:
        json.dump(res, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, dest)
    got = [p for p in res["placed"] if p["ayah"] > 0]
    low = [p for p in got if p["confidence"] < 0.5]
    print(f"surah {surah}: {len(got)}/{res['ayahCount']} verses, {len(low)} low-conf, "
          f"{res['repaired']} repaired, {res['alignedIn']:.0f}s", flush=True)


if __name__ == "__main__":
    main()
