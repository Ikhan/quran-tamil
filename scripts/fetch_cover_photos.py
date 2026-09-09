"""
Fetches nature photographs from Pexels for cover images.

The cover is 1080x1920 with `objectFit: cover`, so that is what is asked for:
Pexels crops server-side, which turns a 6336x9504 original into a 400KB file
that needs no resizing here. Five hundred originals would have been gigabytes.

**No people.** The covers carry scripture, and a photograph of a person under
it changes what the post is. Pexels has no "no humans" filter, so two things
stand in for one: queries that are about landscape rather than activity, and
a rejection pass over the description Pexels returns. Neither is proof — the
description is written by a contributor and can omit what is in the frame — so
the run reports how many it rejected and the folder is worth a glance before
a batch uses it.

    PEXELS_API_KEY=... python3 scripts/fetch_cover_photos.py           500 photos
    python3 scripts/fetch_cover_photos.py 200                          fewer
    OUT=/tmp/shots python3 scripts/fetch_cover_photos.py               elsewhere

Resumable: a photograph already on disk is not fetched again, so an interrupted
run costs only the file in flight.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("OUT") or os.path.join(ROOT, "cover-photos")
WANTED = int(sys.argv[1]) if len(sys.argv) > 1 else 500

WIDTH, HEIGHT = 1080, 1920          # the cover composition, exactly

# Landscape and weather rather than places people go: "beach holiday" returns
# holidaymakers, "coastline" returns coastline.
QUERIES = [
    "mountain range", "ocean waves", "forest trees", "waterfall",
    "desert dunes", "lake reflection", "sunset sky", "storm clouds",
    "river valley", "snow mountains", "green hills", "starry night sky",
    "autumn leaves", "sea cliffs", "misty forest", "wildflower field",
    "canyon rock", "glacier ice", "rainforest", "sunrise horizon",
    "calm water", "pine forest", "sand dunes", "northern lights",
    "rolling fog", "mountain lake", "tropical island aerial", "moss rocks",
    "clouds above", "frozen lake",
]

# Anything suggesting a person in the frame. Deliberately broad: a rejected
# landscape costs nothing, a person on a cover costs a post.
PEOPLE = re.compile(
    r"\b(person|people|man|men|woman|women|girl|boy|child|children|kid|kids|"
    r"human|hiker|hiking|climber|tourist|traveler|traveller|couple|family|"
    r"portrait|model|face|hand|hands|selfie|crowd|silhouette|standing|sitting|"
    r"walking|running|swimmer|surfer|fisherman|worker|lady|guy|male|female|"
    r"her |his |their )",
    re.I,
)


# urllib announces itself as Python-urllib, which Pexels answers with 403 on
# both the API and the image host. The same requests succeed under any ordinary
# browser agent.
AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) quran-tamil/1.0"


def fetch(url, headers=None, timeout=30):
    req = urllib.request.Request(
        url, headers={"User-Agent": AGENT, **(headers or {})}
    )
    return urllib.request.urlopen(req, timeout=timeout)


def api(query, page, key):
    url = "https://api.pexels.com/v1/search?" + urllib.parse.urlencode(
        {"query": query, "orientation": "portrait", "per_page": 80, "page": page}
    )
    with fetch(url, {"Authorization": key}) as fh:
        return json.load(fh)


def main():
    key = os.environ.get("PEXELS_API_KEY")
    if not key:
        for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
            if line.startswith("PEXELS_API_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        print("No PEXELS_API_KEY (env or .env)")
        return 1

    os.makedirs(OUT, exist_ok=True)
    have = {f.split("-")[1].split(".")[0] for f in os.listdir(OUT) if f.endswith(".jpg")}
    manifest_path = os.path.join(OUT, "photos.json")
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}

    print(f"{len(have)} already in {OUT}, want {WANTED}")
    kept, rejected, seen = len(have), 0, set(have)

    # A page from every query before a second page from any of them. Taking
    # each query to exhaustion instead filled the first request of 500 from
    # three of the thirty terms - 238 seascapes, 236 mountains, 26 forests -
    # which is a lot of photographs and not much variety.
    for page in (1, 2, 3, 4):
        if kept >= WANTED:
            break
        for query in QUERIES:
            if kept >= WANTED:
                break
            try:
                data = api(query, page, key)
            except Exception as exc:                      # noqa: BLE001
                print(f"  {query} p{page}: {type(exc).__name__}: {exc}")
                time.sleep(3)
                continue

            for photo in data.get("photos", []):
                if kept >= WANTED:
                    break
                pid = str(photo["id"])
                if pid in seen:
                    continue
                seen.add(pid)

                alt = photo.get("alt") or ""
                if PEOPLE.search(alt):
                    rejected += 1
                    continue

                src = photo["src"]["original"]
                url = f"{src}?auto=compress&cs=tinysrgb&fit=crop&w={WIDTH}&h={HEIGHT}"
                name = f"nature-{pid}.jpg"
                dest = os.path.join(OUT, name)
                try:
                    with fetch(url, timeout=60) as fh:
                        body = fh.read()
                    # A truncated download is worse than none: it would sit in
                    # the folder looking usable and render as a broken cover.
                    if len(body) < 10_000:
                        raise ValueError(f"only {len(body)} bytes")
                    tmp = dest + ".part"
                    with open(tmp, "wb") as out:
                        out.write(body)
                    os.replace(tmp, dest)
                except Exception as exc:                  # noqa: BLE001
                    print(f"  {pid}: {type(exc).__name__}: {exc}")
                    continue

                manifest[pid] = {
                    "file": name,
                    "query": query,
                    "alt": alt,
                    "photographer": photo.get("photographer"),
                    "url": photo.get("url"),
                }
                kept += 1
                if kept % 25 == 0:
                    print(f"  {kept}/{WANTED}")

        json.dump(manifest, open(manifest_path, "w"), ensure_ascii=False, indent=1)

    json.dump(manifest, open(manifest_path, "w"), ensure_ascii=False, indent=1)

    total = sum(
        os.path.getsize(os.path.join(OUT, f))
        for f in os.listdir(OUT)
        if f.endswith(".jpg")
    )
    print(f"\n{kept} photographs in {OUT} ({total / 1048576:.0f} MB)")
    print(f"{rejected} skipped as likely to show a person")
    print("photos.json lists what each one is, and who took it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
