"""
Aligns a long surah by cutting it into pieces the aligner is known to handle.

The evidence this is built on: every one of the 84 indexed surahs is 16.8
minutes or shorter, and every failure has been longer - surah 4 at 69.1m placed
159/176 with a tail-fix median confidence of 0.49, surah 2 at 111.3m placed
226/286 twice over 12 hours. The aligner is not wrong about the audio. It
drifts, and drift needs length to do damage.

So nothing here re-implements alignment. Each piece is handed to place_run,
the same windowed loop that produced all 84 good part files, over a region
short enough to be inside the range that already works.

Two rules make the pieces join cleanly:

  context verses  Each piece is aligned with a few verses either side of the
                  ones it owns. The first and last verse of any window absorb
                  audio they do not own - the probe over surah 2 verses 250-259
                  put the interior at ratios 0.93-1.01 while verse 250 was
                  crushed to confidence 0.09 and 259 stretched to 209s. Context
                  verses are the ones spoiled, and they are thrown away.

  core verses     Every verse is *owned* by exactly one piece, decided by where
                  the text proportion predicts it falls. Ownership tiles the
                  surah with no overlap, so no placement ever has to be chosen
                  between two candidates.

Prediction is only used to decide ownership and where to cut, never to place a
boundary. It is good to about +-150s (measured across surah 2: -114s at verse
60, +60s at verse 255), which PAD_AUDIO covers.

Usage:
    python3 scripts/align_sliced.py 4
    PIECE=500 python3 scripts/align_sliced.py 2      shorter pieces
    OUT=/tmp/x python3 scripts/align_sliced.py 14    write elsewhere
"""
import importlib.util, json, os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "align_tamil", os.path.join(ROOT, "scripts", "align_tamil.py"))
at = importlib.util.module_from_spec(spec)
spec.loader.exec_module(at)

PIECE = float(os.environ.get("PIECE", "600"))   # audio a piece owns, seconds
PAD_AUDIO = 150.0        # extra audio each side, to cover prediction error
PAD_VERSES = 3           # context verses each side, aligned then discarded


def plan(total, est):
    """Piece boundaries, and which verse each piece owns."""
    cum, predict = 0.0, []
    for e in est:
        predict.append(total * cum / sum(est))
        cum += e
    n_pieces = max(1, round(total / PIECE))
    edge = [total * p / n_pieces for p in range(n_pieces + 1)]
    owns = [[] for _ in range(n_pieces)]
    for k, p in enumerate(predict):
        i = min(n_pieces - 1, max(0, int(p / total * n_pieces)))
        owns[i].append(k)
    return edge, owns, predict


def place_piece(al, path, ks, groups, labels, est, start, limit, n, atomic_last):
    """place_run over one piece, with align_tamil's tail fix bounded to it.

    The tail fix is why surah 14 has an index at all. Its main chain breaks at
    verse 7 - every verse from 7 to 52 in the known-good file carries tailFix,
    so none of them was ever placed by the first pass. Calling place_run alone
    inherited that break: the 2-piece probe put v7 at 1.9x its length, pushed
    v8-v21 up to 210s late, and dropped v22 for want of audio. repair could not
    clean it up either - the damage spanned 366s against REPAIR_MAX of 200.

    One thing differs from align_tamil's version, and it is the whole reason
    this is not a straight call into it: the re-place is bounded by the piece's
    own limit, never `total`. A piece reaching to the end of the file would
    place verses inside audio another piece owns, and the stitcher would then
    have to choose between two placements of the same verse - exactly the
    ambiguity that tiling the ownership was meant to remove.
    """
    idx_of = {labels[k]: k for k in ks}
    got = at.place_run(al, path, ks, groups, labels, est, start, limit,
                       n=n, atomic_last=atomic_last)

    def solid(pl):
        k = idx_of.get(pl["ayah"])
        if k is None or pl["confidence"] < 0.70:
            return False
        e, a = est[k], pl["end"] - pl["start"]
        return 0.70 <= a / e <= 1.40 if e > 0.3 else True

    if len({pl["ayah"] for pl in got}) < len(ks):
        while len(got) > 1 and not solid(got[-1]):
            got.pop()

        def replan():
            kept = {pl["ayah"] for pl in got}
            todo = [k for k in ks if labels[k] not in kept]
            anchor = got[-1]["end"] if got else start
            return todo, anchor, limit - anchor

        redo, anchor, span = replan()
        while len(got) > 1 and redo and span < 0.70 * sum(est[k] for k in redo):
            got.pop()
            redo, anchor, span = replan()

        if redo and span > 1.0:
            print(f"    tail fix: {len(redo)} groups from {anchor:.0f}s", flush=True)
            got.extend(at.place_run(al, path, redo, groups, labels, est,
                                    anchor, limit, n=n, mark="tailFix",
                                    atomic_last=atomic_last))
    return got


def align_surah(al, surah, verses):
    path = os.path.join(at.DATA, f"{surah:03d}.mp3")
    total = at.duration_of(path)
    n = max(a for (s, a) in verses if s == surah)

    groups, labels = [], []
    if surah not in (1, 9):
        groups.append(at.words_of(verses[(1, 1)]))
        labels.append(0)
    for a in range(1, n + 1):
        groups.append(at.words_of(verses[(surah, a)]))
        labels.append(a)
    est = [len(" ".join(g)) * at.RATE for g in groups]

    edge, owns, predict = plan(total, est)
    print(f"surah {surah}: {total/60:.1f}m, {len(groups)} groups, "
          f"{len(owns)} pieces of ~{total/len(owns)/60:.1f}m", flush=True)

    placed = []
    for p, core in enumerate(owns):
        if not core:
            continue
        first = max(0, core[0] - PAD_VERSES)
        last = min(len(groups) - 1, core[-1] + PAD_VERSES)
        ks = list(range(first, last + 1))
        start = max(0.0, edge[p] - PAD_AUDIO)
        limit = min(total, edge[p + 1] + PAD_AUDIO)

        got = place_piece(al, path, ks, groups, labels, est, start, limit,
                          n=n, atomic_last=(last == len(groups) - 1))
        owned = {labels[k] for k in core}
        kept = [x for x in got if x["ayah"] in owned]
        placed.extend(kept)
        print(f"  piece {p+1}/{len(owns)}: audio {start:.0f}-{limit:.0f}s, "
              f"owns {labels[core[0]]}-{labels[core[-1]]} ({len(core)}), "
              f"placed {len(kept)}", flush=True)

    # By ayah, never by start. repair() rebuilds its group list from the
    # order `placed` is in and zips the returned spans back on positionally,
    # so a list out of verse order makes it align the wrong text at the wrong
    # place. Two pieces' audio windows overlap by design (PAD_AUDIO), so a
    # verse the tail fix pushed late can start *after* the first verse of the
    # next piece - sorting by start then puts 23 before 22, and the repair
    # pass swapped exactly that pair on surah 14: it handed back 22.5s then
    # 50.4s, the two verses' own text lengths, in the order the list implied.
    placed.sort(key=lambda x: x["ayah"])
    repaired = at.repair(al, path, total, placed, groups, labels, est)
    got = len([x for x in placed if x["ayah"] > 0])
    return {"duration": round(total, 3), "ayahCount": n, "repaired": repaired,
            "placed": placed, "complete": got == n}


def main():
    # align_tamil sets this inside its own main(), which importing bypasses -
    # left unset torch grabs every core and fights any other run in flight.
    import torch
    torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "2")))

    surah = int(sys.argv[1])
    verses = at.load_text()
    al = at.Aligner()
    t0 = time.time()
    res = align_surah(al, surah, verses)
    res["surah"] = surah
    res["alignedIn"] = round(time.time() - t0, 1)
    res["method"] = "sliced"

    out_dir = os.environ.get("OUT", os.path.join(at.DATA, "timings-parts"))
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, f"{surah:03d}.json")
    tmp = f"{dest}.tmp"
    with open(tmp, "w") as fh:
        json.dump(res, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, dest)
    got = [x for x in res["placed"] if x["ayah"] > 0]
    low = [x for x in got if x["confidence"] < 0.5]
    print(f"surah {surah}: {len(got)}/{res['ayahCount']} verses, {len(low)} low-conf, "
          f"{res['repaired']} repaired, {res['alignedIn']:.0f}s", flush=True)


if __name__ == "__main__":
    main()
