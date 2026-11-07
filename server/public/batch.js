/**
 * A reel per verse, for scheduling a week of posts.
 *
 * Separate from the single-reel flow rather than a flag on it: the two produce
 * very different things from the same numbers — `3:180-185` is one reel of six
 * verses there and six reels of one verse here — and a checkbox between them is
 * how you end up posting the wrong one.
 *
 * Loaded after tamil.js and leans on it for `$`, `setStatus`, `clock` and the
 * reciter the operator has already chosen, so the two views cannot disagree
 * about which voice is selected.
 */
let plan = null;
let batchPolling = null;
/** Photographs chosen for this batch, as data URLs, in the order picked. */
let photos = [];
/** Per-verse reciter overrides, keyed by ayah; absent means the batch's voice. */
const voices = {};
/**
 * One element for every audition here, so starting a second stops the first.
 *
 * Separate from the single view's sampler rather than shared: that one is tied
 * to its reciter list and re-renders it on every state change, and driving it
 * from a table it knows nothing about would leave its buttons lying.
 */
const rowSampler = new Audio();
/** Which verse is sounding, and how far along. */
let rowPlaying = null;

/* Same shape the single view accepts: "3:180-185", "3:180", "3". */
const parseRange = (text) => {
  const m = String(text).trim().match(/^(\d{1,3})\s*:\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?$/);
  if (!m) return null;
  const surah = Number(m[1]);
  const from = Number(m[2]);
  const to = m[3] ? Number(m[3]) : from;
  if (surah < 1 || surah > 114 || from < 1 || to < from) return null;
  return { surah, from, to };
};

const stopRow = () => {
  rowPlaying = null;
  rowSampler.pause();
  if (plan) renderPlan(plan.surah, plan.verses);
};

/**
 * Play one verse in the voice its row is set to.
 *
 * The verse itself rather than a fixed sample: the point is to hear what this
 * post will sound like, and a voice that suits one verse may not suit the next.
 */
const hearRow = (ayah) => {
  if (rowPlaying?.ayah === ayah) {
    stopRow();
    return;
  }

  // The single view may be sounding on the other tab; two recitations at once
  // is nobody's idea of an audition.
  if (typeof sampler !== "undefined") sampler.pause();

  const id = voices[ayah] || chosen;
  rowPlaying = { ayah, state: "loading" };
  renderPlan(plan.surah, plan.verses);
  rowSampler.src = `/api/clips/sample/${id}?surah=${plan.surah}&from=${ayah}&to=${ayah}`;
  rowSampler.play().catch(() => {
    rowPlaying = null;
    renderPlan(plan.surah, plan.verses);
    setStatus($("batchRunStatus"), "Could not fetch that recitation", "error");
  });
};

rowSampler.addEventListener("playing", () => {
  if (rowPlaying) {
    rowPlaying = { ...rowPlaying, state: "playing" };
    renderPlan(plan.surah, plan.verses);
  }
});
/* An audition that ends, or fails, has to put the button back — otherwise it
   reads "stop" over silence. */
rowSampler.addEventListener("ended", stopRow);
rowSampler.addEventListener("error", stopRow);

const renderPlan = (surah, verses) => {
  const usable = verses.filter((v) => !v.missing);
  const todo = usable.filter((v) => !v.rendered);
  // Measured at ~3x the reel's length, with almost no fixed cost per render.
  const estimate = todo.reduce((sum, v) => sum + v.totalSeconds * 3, 0);

  $("batchRef").textContent =
    `${surah}:${verses[0].ayah}` +
    (verses.length > 1 ? `-${verses[verses.length - 1].ayah}` : "");
  $("batchSummary").textContent = todo.length
    ? `${todo.length} to render · about ${clock(estimate)}`
    : "all of them are already rendered";

  const voiceOptions = (ayah) =>
    reciters
      .map(
        (r) =>
          `<option value="${r.id}"${
            (voices[ayah] || chosen) === r.id ? " selected" : ""
          }>${r.name}</option>`
      )
      .join("");

  $("batchPlan").innerHTML =
    `<table class="plan"><thead><tr>
       <th>Verse</th><th>Type</th><th>Length</th><th>Voice</th><th></th>
     </tr></thead><tbody>` +
    verses
      .map((v) => {
        const cls = v.missing
          ? "gone"
          : v.rendered
            ? "done"
            : v.warnings.length
              ? "warn"
              : "";
        const note = v.missing
          ? "not indexed — cannot render"
          : v.rendered
            ? "already rendered, will skip"
            : v.warnings
                .map((w) =>
                  w === "small" ? "type is small" : "long for a reel"
                )
                .join(", ");
        return `<tr class="${cls}">
          <td class="num">${surah}:${v.ayah}</td>
          <td class="num">${v.missing ? "—" : v.tamilSize + "px"}</td>
          <td class="num">${v.missing ? "—" : clock(v.totalSeconds)}</td>
          <td class="voicecell">${
            v.missing
              ? "—"
              : `<select data-voice="${v.ayah}">${voiceOptions(v.ayah)}</select>` +
                `<button type="button" class="btn btn-ghost play" data-hear="${v.ayah}">${
                  rowPlaying?.ayah === v.ayah
                    ? rowPlaying.state === "loading"
                      ? "⋯"
                      : "■"
                    : "▶"
                }</button>`
          }</td>
          <td>${note}</td>
        </tr>`;
      })
      .join("") +
    "</tbody></table>";

  $("batchPlan")
    .querySelectorAll("select[data-voice]")
    .forEach((select) => {
      select.addEventListener("change", () => {
        voices[select.dataset.voice] = select.value;
        // The button beside it now means a different voice; if that verse is
        // sounding, what you are hearing is no longer what it would render.
        if (rowPlaying?.ayah === Number(select.dataset.voice)) stopRow();
      });
    });

  $("batchPlan")
    .querySelectorAll("button[data-hear]")
    .forEach((button) => {
      button.addEventListener("click", () => hearRow(Number(button.dataset.hear)));
    });

  $("batchStart").disabled = todo.length === 0;
  $("batchPlanCard").style.display = "block";
  // Captions from a previous range are not this one's.
  $("batchCaptionsCard").style.display = "none";
};

$("batchCheck").addEventListener("click", async () => {
  const range = parseRange($("batchRange").value);
  if (!range) {
    setStatus($("batchStatus"), "Write it as 3:180-185", "error");
    return;
  }

  setStatus($("batchStatus"), "checking…");
  const params = new URLSearchParams({
    surah: range.surah,
    from: range.from,
    to: range.to,
  });
  if (chosen) params.set("reciter", chosen);
  // Which palette decides which file name, and so whether a verse counts as
  // already rendered.
  if ($("batchDark").checked) params.set("dark", "1");

  try {
    const res = await fetch(`/api/reels/preflight?${params}`);
    const data = await res.json();
    if (!res.ok) {
      setStatus($("batchStatus"), data.error || "Could not check that", "error");
      return;
    }
    if (!data.verses.length) {
      setStatus($("batchStatus"), "No verses in that range", "error");
      return;
    }
    setStatus($("batchStatus"), "");
    plan = { surah: data.surah, verses: data.verses };
    renderPlan(data.surah, data.verses);
  } catch {
    setStatus($("batchStatus"), "Network error", "error");
  }
});

$("batchRange").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("batchCheck").click();
});

$("batchDark").addEventListener("change", () => {
  if (plan) $("batchCheck").click();
});

/**
 * The batch's captions, each behind a copy button.
 *
 * Pasting these is the slowest part of scheduling a week, and a file per verse
 * makes it slower: open, select all, copy, close, repeat. Shown here because
 * the destination is a browser tab already.
 */
const showCaptions = (surah, captions) => {
  const rows = Object.entries(captions).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (!rows.length) {
    $("batchCaptionsCard").style.display = "none";
    return;
  }

  $("batchCaptions").innerHTML = rows
    .map(
      ([ayah, text]) => `<div class="capitem" data-ayah="${ayah}">
        <span class="ref">${surah}:${ayah}</span>
        <span class="peek">${text.split("\n")[0]}</span>
        <button type="button" class="btn btn-ghost cap-copy">Copy</button>
      </div>`
    )
    .join("");

  $("batchCaptions")
    .querySelectorAll(".cap-copy")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const row = button.closest(".capitem");
        try {
          await navigator.clipboard.writeText(captions[row.dataset.ayah]);
        } catch {
          setStatus($("batchRunStatus"), "Could not reach the clipboard", "error");
          return;
        }
        // Marked rather than reset: working down a list of twelve, the useful
        // thing to see is which ones are already done.
        row.classList.add("copied");
        button.textContent = "Copied";
      });
    });

  $("batchCaptionsCard").style.display = "block";
};

const showBatchProgress = (p) => {
  const box = $("batchProgress");
  const b = p.batch;
  if (!b) {
    box.hidden = true;
    return;
  }

  const finished = b.done + b.skipped;
  const pct = b.total ? Math.round((finished / b.total) * 100) : 0;
  const line =
    p.status === "error"
      ? `stopped at verse ${b.failedAt} — ${p.error}`
      : p.status === "completed"
        ? p.step
        : `${finished} of ${b.total} · ${p.step}`;

  box.hidden = false;
  box.innerHTML =
    `<div>${line}</div><div class="batch-bar"><span style="width:${pct}%"></span></div>`;
};

const pollBatch = async () => {
  try {
    const res = await fetch("/api/reels/progress");
    const p = await res.json();
    showBatchProgress(p);

    if (p.status === "completed" || p.status === "error") {
      clearInterval(batchPolling);
      batchPolling = null;
      $("batchStart").disabled = false;
      setStatus(
        $("batchRunStatus"),
        p.status === "error" ? "stopped" : "done",
        p.status === "error" ? "error" : ""
      );
      // The plan is stale now — verses just rendered should read as rendered.
      $("batchCheck").click();
      if (p.status === "completed" && p.batch?.files?.length) {
        window.dispatchEvent(new CustomEvent("batch:done", { detail: { files: p.batch.files } }));
      }
    }
  } catch {
    /* a dropped poll is not worth reporting; the next one will do */
  }
};

const asDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });

$("batchPhotos").addEventListener("change", async (event) => {
  const files = [...event.target.files];
  if (!files.length) return;
  try {
    photos = await Promise.all(files.map(asDataUrl));
    const n = plan ? plan.verses.filter((v) => !v.missing).length : 0;
    $("batchPhotoCount").textContent =
      `${photos.length} chosen` +
      (n && photos.length < n ? ` — they will repeat across ${n} verses` : "");
  } catch (error) {
    photos = [];
    setStatus($("batchRunStatus"), error.message, "error");
  }
});

/**
 * The caption for one verse, built with the same function the single view uses.
 *
 * Made here and sent with the batch rather than on the server: a second
 * implementation of the caption would drift from this one, and everything it
 * needs is known before the first render starts — so the tab can be closed
 * straight afterwards without costing the captions.
 */
const captionsFor = async (surah, verses, names) => {
  const resolved = await fetch("/api/clips/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: `${surah}:${verses[0].ayah}-${verses[verses.length - 1].ayah}`,
    }),
  }).then((r) => r.json());

  const byAyah = new Map((resolved.verses ?? []).map((v) => [v.ayah, v]));
  const out = {};
  for (const v of verses) {
    const verse = byAyah.get(v.ayah);
    if (!verse) continue;
    const id = voices[v.ayah] || chosen;
    out[v.ayah] = buildCaption({
      verses: [verse],
      surah,
      from: v.ayah,
      to: v.ayah,
      tamilName: names.tamil,
      englishName: names.english,
      reciterName: reciters.find((r) => r.id === id)?.name,
    });
  }
  return out;
};

$("batchStart").addEventListener("click", async () => {
  if (!plan) return;

  $("batchStart").disabled = true;
  setStatus($("batchRunStatus"), "starting…");

  const usable = plan.verses.filter((v) => !v.missing);

  try {
    // The cover prints the Tamil sura name and the caption credits it, so both
    // want this. Empty would put a nameless cover on every post in the batch.
    const names = await fetch(`/api/cover/names/${plan.surah}`).then((r) =>
      r.json()
    );
    // Photographs first: a cover made before its image is on disk would fall
    // back to the sura's old one, and the batch would be half-right.
    if (photos.length && $("batchCover").checked) {
      setStatus($("batchRunStatus"), "uploading photographs…");
      const res = await fetch("/api/cover/pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surah: plan.surah,
          verses: usable.map((v) => v.ayah),
          images: photos,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus($("batchRunStatus"), data.error || "Upload failed", "error");
        $("batchStart").disabled = false;
        return;
      }
    }

    let captions = {};
    if ($("batchCaption").checked) {
      setStatus($("batchRunStatus"), "writing captions…");
      captions = await captionsFor(plan.surah, usable, names);
      // Kept so they can be handed over one click at a time when the run
      // finishes: the captions are pasted into a browser, so a browser is
      // where they should be — not twelve files in twelve folders.
      showCaptions(plan.surah, captions);
    }

    const perVerse = {};
    for (const v of usable) {
      perVerse[v.ayah] = {
        reciter: voices[v.ayah] || undefined,
        caption: captions[v.ayah],
      };
    }

    setStatus($("batchRunStatus"), "starting…");
    const res = await fetch("/api/reels/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        surah: plan.surah,
        from: plan.verses[0].ayah,
        to: plan.verses[plan.verses.length - 1].ayah,
        reciter: chosen,
        dark: $("batchDark").checked,
        cover: $("batchCover").checked,
        surahTamil: names.tamil ?? "",
        perVerse,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus($("batchRunStatus"), data.error || "Could not start", "error");
      $("batchStart").disabled = false;
      return;
    }
    setStatus($("batchRunStatus"), "");
    if (!batchPolling) batchPolling = setInterval(pollBatch, 2000);
    pollBatch();
  } catch {
    setStatus($("batchRunStatus"), "Network error", "error");
    $("batchStart").disabled = false;
  }
});

/* Switching views. The batch runs on the server, so leaving this tab does not
   stop it — and coming back rejoins it, the same way a refresh rejoins a
   single render. */
document.querySelectorAll(".viewtab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const view = tab.dataset.view;
    document
      .querySelectorAll(".viewtab")
      .forEach((t) => t.classList.toggle("is-active", t === tab));
    $("viewSingle").hidden = view !== "single";
    $("viewBatch").hidden = view !== "batch";
    $("viewSchedule").hidden = view !== "schedule";
    // schedule.js keeps to itself; it learns it is on screen from this.
    if (view === "schedule") window.dispatchEvent(new CustomEvent("view:schedule"));
    if (view !== "batch" && rowPlaying) stopRow();
    write("quranTamil.view", view);

    if (view === "batch" && !batchPolling) {
      // A batch may have been started before this tab was opened, or before a
      // refresh; pick it up rather than showing an idle panel over a live run.
      fetch("/api/reels/progress")
        .then((r) => r.json())
        .then((p) => {
          if (p.batch && (p.status === "preparing" || p.status === "rendering")) {
            $("batchPlanCard").style.display = "block";
            $("batchStart").disabled = true;
            batchPolling = setInterval(pollBatch, 2000);
            showBatchProgress(p);
          }
        })
        .catch(() => {});
    }
  });
});

{
  const saved = read("quranTamil.view");
  if (saved === "batch" || saved === "schedule") {
    document.querySelector(`.viewtab[data-view="${saved}"]`).click();
  }
}
