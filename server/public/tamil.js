/**
 * Dashboard: paste -> resolve -> cut.
 *
 * Resolve and build are deliberately two steps. A paste resolves by matching
 * Arabic letter-for-letter against the whole Qur'an, and a near-miss resolves
 * to a real but wrong verse — so the verses are shown for confirmation before
 * any audio is produced.
 */
const $ = (id) => document.getElementById(id);

const MODE_KEY = "quranTamil.mode";
const RECITER_KEY = "quranTamil.reciter";

let current = null;
/** The clip file the player is pointing at, so Delete knows what to remove. */
let built = null;
/** When Delete was armed; a second click inside 5s is what actually removes. */
let armedAt = 0;

const disarmDelete = () => {
  armedAt = 0;
  const btn = $("deleteClip");
  btn.textContent = "Delete";
  btn.classList.remove("armed");
  setStatus($("deleteStatus"), "");
};
let reciters = [];
let chosen = null;
/* One element for every audition, so starting a second one stops the first. */
const sampler = new Audio();
/**
 * Which reciter is being auditioned, and how far along.
 *
 * Held here rather than read off the button, because the list is re-rendered
 * whenever the selection changes and any state written into the DOM would be
 * thrown away with it.
 */
let sampling = null;

const read = (key) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key, value) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Private browsing: the choice applies now and is simply not remembered. */
  }
};

const mode = () =>
  document.querySelector('input[name="mode"]:checked')?.value ?? "tamil";

const setStatus = (el, text, kind = "") => {
  el.textContent = text;
  el.className = `status ${kind}`;
};

const showCoverage = async () => {
  try {
    const res = await fetch("/api/clips/coverage");
    const data = await res.json();
    const el = $("coverage");
    el.textContent = `${data.indexed.length}/${data.total} surahs indexed`;
    el.classList.toggle("warn", data.indexed.length < data.total);
  } catch {
    /* the header count is not worth an error message */
  }
};

/**
 * How long the range runs, shown before a build rather than after.
 *
 * Fetched rather than worked out on the page: the Tamil seconds arrive with
 * the resolve, but the Arabic depends on the reciter and lives in 34MB of
 * timing files that stay on the server.
 *
 * Re-run on a reciter or mode change, because both change the answer — a
 * Mujawwad reading can be twice a Murattal one, and interleaving pays for the
 * Arabic as well as the Tamil.
 */
const clock = (seconds) => {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  return m ? `${m}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
};

/* A reel over 90s is not worth posting — see the note in CLAUDE.md. */
const REEL_MAX_SECONDS = 90;

const showRuntime = async () => {
  const el = $("runtime");
  if (!current) {
    el.textContent = "";
    return;
  }

  const withArabic = mode() === "arabic";
  const params = new URLSearchParams({
    surah: current.surah,
    from: current.from,
    to: current.to,
  });
  if (withArabic && chosen) {
    params.set("reciter", chosen);
  }

  el.textContent = "…";
  el.classList.remove("over");
  let data;
  try {
    const res = await fetch(`/api/clips/duration?${params}`);
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    // A length that cannot be fetched is not worth an error message; the
    // range is still buildable and the figure was only ever advisory.
    el.textContent = "";
    return;
  }

  // A stale answer must not overwrite a newer one: the reciter can be clicked
  // through faster than these come back.
  if (!current || Number(params.get("surah")) !== current.surah ||
      Number(params.get("from")) !== current.from) {
    return;
  }

  const parts = [];
  let total = data.tamilSeconds;
  if (withArabic && data.arabicSeconds !== null) {
    total += data.arabicSeconds;
    parts.push(`Arabic ${clock(data.arabicSeconds)}`);
  }
  parts.push(`Tamil ${clock(data.tamilSeconds)}`);
  el.textContent = parts.length > 1
    ? `${clock(total)} — ${parts.join(" + ")}`
    : clock(total);
  el.classList.toggle("over", total > REEL_MAX_SECONDS);
  el.title = total > REEL_MAX_SECONDS
    ? `Over ${REEL_MAX_SECONDS}s; long for a reel`
    : "";
};

const renderVerses = (data) => {
  current = data;
  $("ref").textContent = `${data.surahName} ${data.surah}:${data.from}` +
    (data.to > data.from ? `-${data.to}` : "");
  $("matched").textContent =
    data.matchedBy === "arabic" ? "matched by Arabic" : "matched by reference";

  $("verses").innerHTML = data.verses
    .map((v) => {
      const flags = [];
      if (!v.hasAudio) flags.push('<span class="flag missing">no audio yet</span>');
      else if (v.doubtful) flags.push('<span class="flag doubt">low confidence</span>');
      const secs = v.seconds ? `<span class="secs">${v.seconds}s</span>` : "";
      return `<div class="verse">
        <div class="vnum">${v.ayah}${secs}</div>
        <div class="arabic" dir="rtl">${v.arabic}</div>
        <div class="tamil">${v.tamil}</div>
        <div class="flags">${flags.join(" ")}</div>
      </div>`;
    })
    .join("");

  const playable = data.verses.some((v) => v.hasAudio);
  $("build").disabled = !playable;
  setStatus(
    $("buildStatus"),
    playable ? "" : "This surah has not been indexed yet.",
    playable ? "" : "warn"
  );
  $("player").style.display = "none";
  $("result").style.display = "block";
  // A reel from the previous reference is not this one's; clear it rather than
  // leave a video that no longer matches what is on the page.
  $("reelPlayer").style.display = "none";
  setStatus($("reelStatus"), "");
  $("reelCard").style.display = "block";
  showRuntime();
  fillCover(data);
};

const stopSample = () => {
  sampling = null;
  sampler.pause();
  renderReciters();
};

const renderReciters = () => {
  $("reciters").innerHTML = reciters
    .map(
      (r) => `<label class="reciter${r.id === chosen ? " is-selected" : ""}" data-id="${r.id}">
        <input type="radio" name="reciter" value="${r.id}"${r.id === chosen ? " checked" : ""}>
        <span class="reciter-body">
          <span class="reciter-name">${r.name} <span class="style">${r.style}</span></span>
          <span class="reciter-character">${r.character}</span>
        </span>
        <button type="button" class="btn btn-ghost play" data-sample="${r.id}">${
          sampling?.id === r.id
            ? sampling.state === "loading"
              ? "⋯ Loading"
              : "■ Stop"
            : "▶ Play"
        }</button>
      </label>`
    )
    .join("");
};

/* The label reads as the promise the button makes; leaving it on "Tamil audio"
   while the Arabic mode is selected is how someone ends up with the wrong file
   and no idea why. */
const syncMode = () => {
  const arabic = mode() === "arabic";
  $("reciters").hidden = !arabic;
  $("build").textContent = arabic ? "Get Arabic → Tamil audio" : "Get Tamil audio";
  write(MODE_KEY, mode());
  showRuntime();
};

const loadReciters = async () => {
  try {
    const res = await fetch("/api/clips/reciters");
    const data = await res.json();
    reciters = data.reciters;
    const remembered = read(RECITER_KEY);
    chosen = reciters.some((r) => r.id === remembered) ? remembered : data.default;
    renderReciters();
  } catch {
    $("reciters").innerHTML =
      '<span class="status error">Could not load the reciter list</span>';
  }
};

$("reciters").addEventListener("click", async (event) => {
  const sample = event.target.closest("[data-sample]");
  if (sample) {
    // Inside a <label>, so without this the click also selects the reciter.
    event.preventDefault();
    const id = sample.dataset.sample;

    // A second click on the one already sounding stops it, which is what the
    // button now says it will do.
    if (sampling?.id === id) {
      stopSample();
      return;
    }

    // Audition on the verse being worked on, so what you hear is what you are
    // about to build. The server falls back to Al-Fatiha 1:1 on its own if that
    // verse cannot be fetched.
    const on = current
      ? `?surah=${current.surah}&from=${current.from}&to=${current.to}`
      : "";
    sampling = { id, state: "loading" };
    renderReciters();
    sampler.src = `/api/clips/sample/${id}${on}`;
    sampler.play().catch(() => {
      sampling = null;
      renderReciters();
      setStatus($("buildStatus"), "Could not fetch that recitation", "error");
    });
    return;
  }

  const row = event.target.closest(".reciter");
  if (row) {
    chosen = row.dataset.id;
    write(RECITER_KEY, chosen);
    renderReciters();
    showRuntime();
    // The caption credits the reciter, so it follows the choice — unless
    // something has been typed into it, which outranks a line it can fix by
    // hand in a second.
    if (current && !captionEdited) writeCaption();
  }
});

/* An audition that reaches its end, or fails, has to put the button back —
   otherwise it reads "Stop" over silence. */
sampler.addEventListener("playing", () => {
  if (sampling) {
    sampling = { ...sampling, state: "playing" };
    renderReciters();
  }
});
sampler.addEventListener("ended", () => {
  sampling = null;
  renderReciters();
});
sampler.addEventListener("error", () => {
  if (!sampling) return;
  sampling = null;
  renderReciters();
  setStatus($("buildStatus"), "Could not fetch that recitation", "error");
});

document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener("change", syncMode);
});

$("resolve").addEventListener("click", async () => {
  const input = $("paste").value.trim();
  if (!input) return;

  setStatus($("status"), "Looking up…");
  $("result").style.display = "none";

  try {
    const res = await fetch("/api/clips/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus($("status"), data.error || "Could not resolve that", "error");
      return;
    }
    setStatus($("status"), "");
    renderVerses(data);
  } catch {
    setStatus($("status"), "Network error", "error");
  }
});

$("build").addEventListener("click", async () => {
  if (!current) return;

  const withArabic = mode() === "arabic";
  setStatus(
    $("buildStatus"),
    withArabic ? "Fetching the recitation and cutting audio…" : "Cutting audio…"
  );
  try {
    const res = await fetch("/api/clips/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        surah: current.surah,
        from: current.from,
        to: current.to,
        reciter: withArabic ? chosen : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus($("buildStatus"), data.error || "Failed", "error");
      return;
    }
    // A clip quietly missing a translation is worse than one that says so.
    const skipped = data.tamilSkipped?.length
      ? ` · no Tamil for ${data.tamilSkipped.map((v) => `${current.surah}:${v}`).join(", ")}`
      : "";
    setStatus(
      $("buildStatus"),
      (data.reciter ? `${data.seconds}s · ${data.reciter}` : `${data.seconds}s`) + skipped,
      skipped ? "warn" : ""
    );
    $("audio").src = data.url;
    $("download").href = data.url;
    $("download").setAttribute("download", data.file);
    built = data.file;
    disarmDelete();
    $("player").style.display = "flex";
  } catch {
    setStatus($("buildStatus"), "Network error", "error");
  }
});

/**
 * Delete the clip just built.
 *
 * Two clicks, not a confirm box: the button sits beside Download, which is
 * clicked often, and a single stray click should not remove a file. Arming
 * says so plainly and lapses on its own, so a click and a walk away leaves
 * nothing primed.
 */
$("deleteClip").addEventListener("click", async () => {
  if (!built) return;

  if (!armedAt || Date.now() - armedAt > 5000) {
    armedAt = Date.now();
    const btn = $("deleteClip");
    btn.textContent = "Delete for good?";
    btn.classList.add("armed");
    setStatus($("deleteStatus"), "click again to confirm", "warn");
    setTimeout(() => {
      if (armedAt && Date.now() - armedAt >= 5000) disarmDelete();
    }, 5200);
    return;
  }

  const name = built;
  disarmDelete();
  try {
    const res = await fetch(`/api/clips/file/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus($("deleteStatus"), data.error || "Could not delete", "error");
      return;
    }
  } catch {
    setStatus($("deleteStatus"), "Network error", "error");
    return;
  }

  // The file is gone, so the player must stop pointing at it — an <audio>
  // left on a deleted src plays nothing and explains nothing.
  $("audio").pause();
  $("audio").removeAttribute("src");
  $("player").style.display = "none";
  built = null;
  setStatus($("buildStatus"), "Deleted. Build again whenever you like.");
});

$("paste").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") $("resolve").click();
});

/* ------------------------------------------------------------------ *
 * Reels
 *
 * A render takes minutes and runs one at a time on the server, so the page
 * starts it and then polls. Polling rather than holding the request open means
 * a refresh mid-render rejoins the same job instead of losing it.
 * ------------------------------------------------------------------ */

let polling = null;


/* Reels and covers are addressed by their path under `output/` — the sura
   folder, the range folder, then the name. A download attribute has to be the
   name alone: a browser refuses one carrying separators. */
const basename = (file) => file.slice(file.lastIndexOf("/") + 1);

const showReel = (file) => {
  $("reelVideo").src = `/api/reels/file/${file}`;
  $("reelDownload").href = `/api/reels/file/${file}`;
  $("reelDownload").setAttribute("download", basename(file));
  $("reelPlayer").style.display = "flex";
  // schedule.js offers to post it; it reads the caption box when asked.
  window.dispatchEvent(new CustomEvent("reel:ready", { detail: { file } }));
};

const poll = async () => {
  const res = await fetch("/api/reels/progress");
  const p = await res.json();

  // A batch holds the same single-render slot, so this view must stay disabled
  // while one runs — but it has no single reel to show at the end, and
  // `p.file` would be undefined. The batch view reports its own progress.
  if (p.batch) {
    const running = p.status === "preparing" || p.status === "rendering";
    setStatus(
      $("reelStatus"),
      running ? `${p.step}… (a reel per verse is running)` : "",
      running ? "working" : ""
    );
    if (running) return;
    clearInterval(polling);
    polling = null;
    $("makeReel").disabled = false;
    return;
  }

  if (p.status === "preparing" || p.status === "rendering") {
    setStatus($("reelStatus"), `${p.step}…`, "working");
    return;
  }

  clearInterval(polling);
  polling = null;
  $("makeReel").disabled = false;

  if (p.status === "completed") {
    setStatus($("reelStatus"), p.file);
    showReel(p.file);
  } else if (p.status === "error") {
    setStatus($("reelStatus"), p.error || "Render failed", "error");
  }
};

const watch = () => {
  if (polling) return;
  $("makeReel").disabled = true;
  // Two seconds: fast enough that the step text feels live, slow enough that a
  // render lasting minutes is not a few hundred requests.
  polling = setInterval(poll, 2000);
  poll();
};

$("makeReel").addEventListener("click", async () => {
  if (!current) return;

  setStatus($("reelStatus"), "Starting…", "working");
  $("reelPlayer").style.display = "none";
  $("reelPost").hidden = true;

  try {
    const res = await fetch("/api/reels/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        surah: current.surah,
        from: current.from,
        to: current.to,
        reciter: chosen,
        dark: $("darkReel").checked,
        cover: $("reelCover").checked,
        // The same name the cover card shows, so both paths print the same one.
        surahTamil: $("coverTamil").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus($("reelStatus"), data.error || "Could not start", "error");
      return;
    }
    watch();
  } catch {
    setStatus($("reelStatus"), "Network error", "error");
  }
});

/* ------------------------------------------------------------------ *
 * Cover image
 *
 * The surah and verse come from whatever was resolved above, so the only thing
 * to supply is the Tamil name of the surah and a photograph. The Tamil name is
 * typed because there is no vendored list of them — and it is remembered, so
 * each surah is typed once.
 * ------------------------------------------------------------------ */

const fillCover = async (data) => {
  $("coverFrom").value = data.from;
  $("coverTo").value = data.to;
  $("coverCard").style.display = "block";
  $("coverResult").style.display = "none";
  setStatus($("coverStatus"), "");

  try {
    const res = await fetch(`/api/cover/names/${data.surah}`);
    const names = await res.json();
    $("coverEnglish").value = names.english;
    $("coverTamil").value = names.tamil;
  } catch {
    $("coverEnglish").value = data.surahName;
  }

  // The caption carries the same Tamil name, so it is built once that has
  // arrived rather than twice with the English name in between.
  fillCaption();
};

/**
 * Reads the chosen photograph, downscaled, as a data URL.
 *
 * Sent as a data URL rather than multipart, which keeps the server free of an
 * upload dependency for something sent once per cover. Downscaled first because
 * a phone photo is around 4000px and 5MB, base64 inflates it by a third, and
 * the cover is 1080 wide — so the full-size original is several megabytes of
 * detail that is thrown away on arrival, and enough to overrun the body limit.
 */
const COVER_MAX_EDGE = 1920;

const readImage = (input) =>
  new Promise((resolve, reject) => {
    const file = input.files?.[0];
    if (!file) return resolve(null);

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.onload = () => {
      const image = new Image();
      // If anything about the resize fails, send the original rather than
      // nothing — the server limit is generous enough for most photographs.
      image.onerror = () => resolve(reader.result);
      image.onload = () => {
        const scale = Math.min(
          1,
          COVER_MAX_EDGE / Math.max(image.width, image.height)
        );
        if (scale === 1 && reader.result.length < 4_000_000) {
          return resolve(reader.result);
        }

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

$("makeCover").addEventListener("click", async () => {
  if (!current) return;

  const tamil = $("coverTamil").value.trim();
  if (!tamil) {
    setStatus($("coverStatus"), "Type the surah name in Tamil first", "error");
    $("coverTamil").focus();
    return;
  }

  setStatus($("coverStatus"), "Rendering…", "working");
  $("makeCover").disabled = true;

  try {
    const image = await readImage($("coverImage"));
    const res = await fetch("/api/cover/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        surah: current.surah,
        from: Number($("coverFrom").value) || current.from,
        to: Number($("coverTo").value) || current.to,
        surahTamil: tamil,
        image,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus($("coverStatus"), data.error || "Failed", "error");
      return;
    }

    setStatus($("coverStatus"), data.file);
    // Cache-busted: the same surah and verse renders to the same name, and the
    // browser would otherwise show the previous attempt.
    $("coverPreview").src = `${data.url}?t=${Date.now()}`;
    $("coverDownload").href = data.url;
    $("coverDownload").setAttribute("download", basename(data.file));
    $("coverResult").style.display = "flex";
  } catch {
    setStatus($("coverStatus"), "Network error", "error");
  } finally {
    $("makeCover").disabled = false;
  }
});

/* ------------------------------------------------------------------ *
 * Instagram caption
 *
 * Built here rather than on the server because the page already holds every
 * part of one: the verses came back with the resolve, the reciter list is
 * loaded, and the Tamil sura name was fetched for the cover. A route for this
 * would be a round trip to reassemble what is already in the room.
 *
 * The caption itself is assembled in caption.js, which knows nothing about
 * the DOM.
 * ------------------------------------------------------------------ */

/* Whether the box has been typed in since it was last built, so a rebuild
   triggered by something else does not throw away a line someone wrote. */
let captionEdited = false;

const captionContext = () => ({
  surah: current.surah,
  from: current.from,
  to: current.to,
  verses: current.verses,
  englishName: $("coverEnglish").value || current.surahName,
  tamilName: $("coverTamil").value,
  reciterName: reciters.find((r) => r.id === chosen)?.name ?? "",
});

/** Rebuilds the box from what is resolved, discarding any edits. */
const writeCaption = () => {
  if (!current) return;
  $("captionText").value = buildCaption(captionContext());
  captionEdited = false;
  setStatus($("captionStatus"), "");
};

const fillCaption = () => {
  if (!current) return;
  $("captionCard").style.display = "block";
  writeCaption();
};

$("rebuildCaption").addEventListener("click", writeCaption);
$("captionText").addEventListener("input", () => {
  captionEdited = true;
});

$("copyCaption").addEventListener("click", async () => {
  const text = $("captionText").value;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers, and any context the clipboard API is not allowed in.
    $("captionText").select();
    document.execCommand("copy");
  }
  // Counted on the text as it stands rather than on the list, so tags pasted
  // in by hand are counted too. Over thirty Instagram refuses the post
  // outright, which is worth knowing before the paste rather than after.
  const tags = captionTagCount(text);
  const over = tags > CAPTION_TAG_LIMIT;
  setStatus(
    $("captionStatus"),
    over
      ? `Copied · ${tags} hashtags — Instagram allows ${CAPTION_TAG_LIMIT}`
      : `Copied · ${tags} hashtags`,
    over ? "warn" : ""
  );
});

$("logout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  window.location.href = "/login";
});

const storedMode = read(MODE_KEY);
if (storedMode === "arabic") {
  document.querySelector('input[name="mode"][value="arabic"]').checked = true;
}

syncMode();
loadReciters();
showCoverage();

/* A render started before a refresh is still running on the server; rejoin it
   rather than leaving the page looking idle while a core is pinned. */
fetch("/api/reels/progress")
  .then((res) => res.json())
  .then((p) => {
    if (p.status === "preparing" || p.status === "rendering") watch();
  })
  .catch(() => {});
