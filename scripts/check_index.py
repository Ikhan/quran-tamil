"""
Audits the verse-timing index.

The aligner's summary line is not enough on its own: during development it
twice reported success while silently dropping verses, and a truncated surah
75 reported "31/40" as though that were a result. So this checks three things
independently, because each catches a failure the others miss:

  verses   - every ayah present, and the part file's own complete flag
  crushed  - placements the model was not confident about
  stretched- placements whose length disagrees with the length of their text.
             A verse spreading across audio that is not its own can still
             report high confidence, so only the ratio test catches it.

  python3 scripts/check_index.py          audit everything indexed
  python3 scripts/check_index.py 47 55    audit particular surahs
  python3 scripts/check_index.py --todo   list what is not indexed yet

Exit status is 1 if anything is BAD, so it can gate a script.
"""
import glob, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PARTS = os.path.join(DATA, "timings-parts")
ALIGNER = os.path.join(ROOT, "scripts", "align_tamil.py")

# Read RATE out of the aligner rather than repeating it. If the two disagreed,
# this would quietly grade placements against a standard the aligner never used.
RATE = float(re.search(r"^RATE = ([\d.]+)", open(ALIGNER).read(), re.M).group(1))
CONF_MIN = 0.50


def tamil_text():
    out = {}
    with open(os.path.join(DATA, "ta.tamil.txt"), encoding="utf-8") as fh:
        for line in fh:
            p = line.rstrip("\n").split("|")
            if len(p) >= 3 and p[0].isdigit():
                out[(int(p[0]), int(p[1]))] = p[2]
    return out


def audit(surah, txt):
    path = os.path.join(PARTS, f"{surah:03d}.json")
    if not os.path.exists(path):
        return "MISSING", "not indexed", {}
    try:
        d = json.load(open(path))
    except (json.JSONDecodeError, OSError) as exc:
        return "BAD", f"unreadable part file ({type(exc).__name__})", {}

    placed = [p for p in d["placed"] if p["ayah"] > 0]
    n = d["ayahCount"]
    missing = [a for a in range(1, n + 1) if a not in {p["ayah"] for p in placed}]
    low = [p["ayah"] for p in placed if p["confidence"] < CONF_MIN]
    odd = []
    for p in placed:
        expected = len(txt.get((surah, p["ayah"]), "")) * RATE
        actual = p["end"] - p["start"]
        if expected > 0.3 and abs(actual - expected) > max(1.5, 0.6 * expected):
            odd.append(p["ayah"])
    # Verses placed out of sequence. A piece-based run puts the first verse a
    # piece owns into the padding ahead of it, so the verse lands *before* ones
    # that precede it - surah 6 verse 33 sat 130s ahead of verse 32, and a clip
    # cut for it would have played verses 29-31. Every other test here passed
    # that file: the ratio was suspicious but the confidence was 0.87, and
    # presence and coverage were perfect. Only comparing a verse against its
    # neighbour finds it.
    order = []
    for a, b in zip(sorted(placed, key=lambda p: p["ayah"]),
                    sorted(placed, key=lambda p: p["ayah"])[1:]):
        if b["start"] < a["end"] - 0.05:
            order.append(b["ayah"])
    span = (max(p["end"] for p in placed) - min(p["start"] for p in placed)) if placed else 0
    stats = {"verses": f"{len(placed)}/{n}", "missing": missing, "low": low,
             "odd": odd, "order": order,
             "coverage": span / d["duration"] if d["duration"] else 0,
             "conf": min((p["confidence"] for p in placed), default=0),
             "duration": d["duration"]}

    if missing or not d.get("complete"):
        return "BAD", f"{len(missing)} verse(s) missing: {missing[:10]}", stats
    if order:
        return "BAD", f"{len(order)} verse(s) out of order: {order[:10]}", stats
    # One verse at ~0.1 is not a rounding error, it is the model saying it
    # could not find that verse at all - it is how the truncated source files
    # announced themselves. Never average that away against 30 good verses.
    floor = min((p["confidence"] for p in placed), default=1.0)
    if floor < 0.25:
        return "CHECK", f"a verse at confidence {floor:.2f}", stats
    if len(odd) > max(2, 0.15 * n) or len(low) > max(2, 0.10 * n):
        return "CHECK", f"{len(low)} low-confidence, {len(odd)} length-suspect", stats
    if low or odd:
        return "OK", f"{len(low)} low-confidence, {len(odd)} length-suspect", stats
    return "OK", "clean", stats


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    txt = tamil_text()
    have = sorted(int(os.path.basename(f)[:3]) for f in glob.glob(os.path.join(PARTS, "*.json")))

    if "--todo" in sys.argv:
        todo = [s for s in range(1, 115) if s not in have]
        print(f"{len(have)}/114 indexed, {len(todo)} to go\n")
        print("  " + " ".join(f"{s:03d}" for s in todo))
        return 0

    targets = [int(a) for a in args] or have
    worst = 0
    for s in targets:
        verdict, note, st = audit(s, txt)
        worst = max(worst, {"OK": 0, "MISSING": 1, "CHECK": 2, "BAD": 3}[verdict])
        extra = ""
        if st:
            extra = (f"  {st['verses']} verses, min conf {st['conf']:.2f}, "
                     f"{st['coverage']*100:.0f}% covered")
        print(f"  surah {s:3d}  {verdict:8} {note}{extra}")
    if len(targets) > 1:
        print(f"\n  {len(targets)} audited")
    return 1 if worst == 3 else 0


if __name__ == "__main__":
    sys.exit(main())
