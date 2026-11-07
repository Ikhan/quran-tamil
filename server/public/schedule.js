/**
 * Posting to Instagram from the dashboard: the Schedule tab, the bar under a
 * finished reel, and "Schedule these" after a batch.
 *
 * The queue itself lives on the server (output/schedule.json) and is worked
 * through there once a minute, so nothing here has to stay open for a post to
 * go out. This file only shows the queue and asks for changes.
 *
 * Wrapped in a function: the dashboard's scripts are classic scripts sharing
 * one global scope, and a top-level name here that matched one in tamil.js or
 * batch.js would stop both from running. It talks to them through window
 * events — "reel:ready", "batch:done", "view:schedule" — and by reading
 * #captionText, which is the caption the single view has built.
 */
(() => {
  const byId = (id) => document.getElementById(id);

  const say = (el, text, kind = "") => {
    el.textContent = text;
    el.className = `status ${kind}`;
  };

  /** Builds an element. Text always goes in as text, never as markup. */
  const make = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key === "className") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  };

  const api = async (url, options = {}) => {
    const res = await fetch(url, {
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
    if (res.status === 401) {
      window.location.href = "/login";
      throw new Error("Logged out");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };
  const send = (url, method, body) =>
    api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  /** Posting times are the settings' zone, which need not be the browser's. */
  let zone = "Asia/Kolkata";
  const when = (iso) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));

  /** A datetime-local value (the browser's own time) as an ISO instant, or null. */
  const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);
  const toLocalInput = (iso) => {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const STATUS_LABEL = {
    scheduled: "scheduled",
    publishing: "posting now…",
    posted: "posted",
    failed: "failed",
    canceled: "canceled",
  };

  const thumb = (cover) =>
    cover
      ? make("img", { className: "postthumb", src: `/api/cover/file/${cover}`, alt: "", loading: "lazy" })
      : make("div", { className: "postthumb empty", text: "no cover" });

  /**
   * A destructive button that needs a second click within five seconds — the
   * same arming the clip Delete uses, so an accidental click costs nothing.
   */
  const armed = (label, onConfirm) => {
    let at = 0;
    const btn = make("button", { className: "btn btn-ghost danger", text: label });
    btn.addEventListener("click", () => {
      if (Date.now() - at < 5000) {
        at = 0;
        onConfirm();
        return;
      }
      at = Date.now();
      btn.textContent = "Sure?";
      btn.classList.add("armed");
      setTimeout(() => {
        if (Date.now() - at >= 5000) {
          btn.textContent = label;
          btn.classList.remove("armed");
        }
      }, 5100);
    });
    return btn;
  };

  /* ---------------------------------------------------------------- *
   * The Schedule tab
   * ---------------------------------------------------------------- */

  let view = null;
  let reels = [];
  let polling = null;

  const WHERE = {
    aws: "Posts go out from AWS (Mumbai) at their time — this Mac can be shut. Each reel and its cover are copied to a private S3 bucket when scheduled, and deleted once posted or unscheduled.",
    local: "Posts go out from this Mac while the server is running. Stopped, nothing is lost: the queue is kept in output/schedule.json, and a post missed by more than a few hours moves to the next free slot instead of going out late.",
  };

  const showConnection = ({ instagram, connected, backend }) => {
    byId("schedWhere").textContent = WHERE[backend] || WHERE.local;
    const el = byId("igStatus");
    if (!instagram.configured) {
      say(el, "Not connected — set INSTAGRAM_ACCESS_TOKEN in .env and restart. Posts can still be queued; they wait.", "warn");
    } else if (instagram.error) {
      say(el, `Token problem: ${instagram.error}`, "error");
    } else {
      const quota = instagram.quota ? ` · ${instagram.quota.used}/${instagram.quota.total} posts in the last 24h` : "";
      say(el, `Connected as @${instagram.username}${quota}`, connected ? "" : "warn");
    }
  };

  const showSettings = (settings) => {
    // Not while someone is typing in them — a poll must not undo an edit.
    if ([byId("schedTimes"), byId("schedZone")].includes(document.activeElement)) return;
    byId("schedTimes").value = settings.times.join(", ");
    byId("schedZone").value = settings.timezone;
    byId("schedPaused").checked = settings.paused;
  };

  const act = async (statusEl, work, done = "Done") => {
    say(statusEl, "Working…", "working");
    try {
      await work();
      say(statusEl, done);
      await refresh();
    } catch (error) {
      say(statusEl, error.message, "error");
    }
  };

  /** One queued post: when, what, and everything that can be done to it. */
  const postRow = (post) => {
    const status = make("span", { className: "status" });
    const editable = post.status === "scheduled" || post.status === "failed";

    const caption = make("textarea", { className: "postcaption", rows: "8", dir: "auto", spellcheck: "false" });
    caption.value = post.caption;
    const captionBox = make("div", { className: "postedit", hidden: true }, [
      caption,
      make("div", { className: "row" }, [
        make("button", {
          className: "btn btn-primary",
          text: "Save caption",
          onclick: () =>
            act(status, () => send(`/api/schedule/${post.id}`, "PATCH", { caption: caption.value }), "Caption saved"),
        }),
      ]),
    ]);

    const at = make("input", { type: "datetime-local", className: "whenbox", "aria-label": "New time (your time)" });
    at.value = toLocalInput(post.scheduled_at);
    const timeBox = make("div", { className: "postedit", hidden: true }, [
      make("div", { className: "row wrap-row" }, [
        at,
        make("button", {
          className: "btn btn-primary",
          text: post.status === "failed" ? "Put back in the queue" : "Move",
          onclick: () => {
            const iso = fromLocalInput(at.value);
            if (!iso) return say(status, "Pick a time", "error");
            act(status, () => send(`/api/schedule/${post.id}`, "PATCH", { scheduledAt: iso }), "Moved");
          },
        }),
      ]),
    ]);

    const actions = editable
      ? [
          make("button", { className: "btn btn-ghost", text: "Caption", onclick: () => (captionBox.hidden = !captionBox.hidden) }),
          make("button", { className: "btn btn-ghost", text: "Time", onclick: () => (timeBox.hidden = !timeBox.hidden) }),
          make("button", {
            className: "btn btn-ghost",
            text: post.status === "failed" ? "Retry now" : "Post now",
            onclick: () => act(status, () => send(`/api/schedule/${post.id}/publish`, "POST"), "Posting…"),
          }),
          armed("Unschedule", () => act(status, () => send(`/api/schedule/${post.id}/cancel`, "POST"), "Unscheduled")),
        ]
      : [];

    return make("div", { className: `postrow is-${post.status}` }, [
      thumb(post.cover_file),
      make("div", { className: "postbody" }, [
        make("div", { className: "posthead" }, [
          make("span", { className: "postref", text: post.reference }),
          make("span", { className: "postwhen", text: when(post.posted_at ?? post.scheduled_at) }),
          make("span", { className: `chip chip-${post.status}`, text: STATUS_LABEL[post.status] }),
          post.permalink ? make("a", { href: post.permalink, target: "_blank", rel: "noopener", text: "View on Instagram" }) : null,
        ]),
        make("div", { className: "postpeek", text: post.caption.split("\n")[0] }),
        post.error ? make("div", { className: `posterror ${post.status === "failed" ? "error" : "warn"}`, text: post.error }) : null,
        make("div", { className: "row wrap-row" }, [...actions, status]),
        captionBox,
        timeBox,
      ]),
    ]);
  };

  /** A rendered reel nobody has queued. */
  const reelRow = (reel) => {
    const status = make("span", { className: "status" });
    const caption = make("textarea", { className: "postcaption", rows: "8", dir: "auto", spellcheck: "false", placeholder: "The caption for this post" });
    caption.value = reel.caption ?? "";
    const box = make("div", { className: "postedit", hidden: Boolean(reel.caption) }, [caption]);

    const queue = (body, done) =>
      act(status, async () => {
        if (!caption.value.trim()) {
          box.hidden = false;
          throw new Error("Write a caption first");
        }
        await send("/api/schedule", "POST", { reel: reel.file, caption: caption.value, ...body });
      }, done);

    return make("div", { className: "postrow" }, [
      thumb(reel.cover),
      make("div", { className: "postbody" }, [
        make("div", { className: "posthead" }, [
          make("span", { className: "postref", text: reel.reference }),
          make("span", { className: "postwhen", text: reel.file.slice(reel.file.lastIndexOf("/") + 1) }),
          make("span", { className: `chip ${reel.caption ? "chip-ready" : "chip-missing"}`, text: reel.caption ? "caption ready" : "no caption" }),
        ]),
        make("div", { className: "row wrap-row" }, [
          make("button", { className: "btn btn-primary", text: "Schedule", onclick: () => queue({}, "Scheduled") }),
          make("button", { className: "btn btn-ghost", text: "Post now", onclick: () => queue({ now: true }, "Posting…") }),
          make("button", { className: "btn btn-ghost", text: "Caption", onclick: () => (box.hidden = !box.hidden) }),
          make("a", { className: "btn btn-ghost", href: `/api/reels/file/${reel.file}`, target: "_blank", rel: "noopener", text: "Watch" }),
          status,
        ]),
        box,
      ]),
    ]);
  };

  const render = () => {
    const posts = view.posts;
    const upcoming = posts.filter((p) => p.status === "scheduled" || p.status === "publishing" || p.status === "failed");
    const posted = posts.filter((p) => p.status === "posted").reverse().slice(0, 30);
    const waiting = reels.filter((r) => !r.post);

    byId("queueList").replaceChildren(
      ...(upcoming.length ? upcoming.map(postRow) : [make("p", { className: "hint", text: "Nothing queued." })])
    );
    const failed = upcoming.filter((p) => p.status === "failed").length;
    byId("queueSummary").textContent = upcoming.length
      ? `${upcoming.length - failed} waiting${failed ? ` · ${failed} failed` : ""}${view.settings.paused ? " · paused" : ""}`
      : "";

    byId("unqueuedList").replaceChildren(
      ...(waiting.length ? waiting.map(reelRow) : [make("p", { className: "hint", text: "Every rendered reel is queued or posted." })])
    );
    const ready = waiting.filter((r) => r.caption).length;
    byId("unqueuedSummary").textContent = waiting.length ? `${waiting.length} · ${ready} with a caption` : "";
    byId("queueAllReady").disabled = ready === 0;

    byId("postedCard").hidden = posted.length === 0;
    byId("postedList").replaceChildren(...posted.map(postRow));

    const count = byId("queueCount");
    const live = upcoming.length - failed;
    count.hidden = live === 0 && failed === 0;
    count.textContent = failed ? `${live} · ${failed}!` : String(live);
    count.classList.toggle("has-failed", failed > 0);
  };

  /** Fetches and redraws; while a post is going out, keeps checking until it lands. */
  const refresh = async () => {
    const [state, listing] = await Promise.all([api("/api/schedule"), api("/api/schedule/reels")]);
    view = state;
    reels = listing.reels;
    zone = state.settings.timezone;
    showConnection(state);
    showSettings(state.settings);
    render();

    const busy = state.posts.some((p) => p.status === "publishing");
    if (busy && !polling) polling = setInterval(() => refresh().catch(() => {}), 5000);
    if (!busy && polling) {
      clearInterval(polling);
      polling = null;
    }
  };

  byId("schedSave").addEventListener("click", () => {
    const times = byId("schedTimes").value.split(/[,\s]+/).filter(Boolean);
    act(
      byId("schedSaveStatus"),
      () =>
        send("/api/schedule/settings", "PUT", {
          times,
          timezone: byId("schedZone").value.trim(),
          paused: byId("schedPaused").checked,
        }),
      "Saved"
    );
  });

  byId("queueAllReady").addEventListener("click", () => {
    const items = reels
      .filter((r) => !r.post && r.caption)
      // Oldest reference first: posts go out in mushaf order.
      .sort((a, b) => a.file.localeCompare(b.file))
      .map((r) => ({ reel: r.file }));
    act(byId("queueAllStatus"), () => send("/api/schedule/many", "POST", { items }), `${items.length} scheduled`);
  });

  window.addEventListener("view:schedule", () => {
    refresh().catch((error) => say(byId("igStatus"), error.message, "error"));
  });

  /* ---------------------------------------------------------------- *
   * Under a finished reel, in the single view
   * ---------------------------------------------------------------- */

  let readyReel = null;

  window.addEventListener("reel:ready", (event) => {
    readyReel = event.detail.file;
    byId("reelPost").hidden = false;
    say(byId("postStatus"), "");
  });

  const postReady = async (extra, done) => {
    const status = byId("postStatus");
    const caption = byId("captionText")?.value ?? "";
    if (!readyReel) return;
    if (!caption.trim()) return say(status, "The caption box is empty — build or write one first", "error");
    say(status, "Working…", "working");
    try {
      const post = await send("/api/schedule", "POST", { reel: readyReel, caption, ...extra });
      if (view) zone = view.settings.timezone;
      say(status, done(post));
      refreshCount();
    } catch (error) {
      say(status, error.message, "error");
    }
  };

  byId("postNextSlot").addEventListener("click", () =>
    postReady({}, (p) => `Scheduled for ${when(p.scheduled_at)}`)
  );
  byId("postAtTime").addEventListener("click", () => {
    const iso = fromLocalInput(byId("postAt").value);
    if (!iso) return say(byId("postStatus"), "Pick a time first", "error");
    postReady({ scheduledAt: iso }, (p) => `Scheduled for ${when(p.scheduled_at)}`);
  });
  byId("postNow").addEventListener("click", () =>
    postReady({ now: true }, () => "Posting — follow it on the Schedule tab")
  );

  /* ---------------------------------------------------------------- *
   * After a batch
   * ---------------------------------------------------------------- */

  let batchFiles = [];

  window.addEventListener("batch:done", (event) => {
    batchFiles = event.detail.files;
    byId("batchPost").hidden = false;
    byId("batchSchedule").textContent = `Schedule these ${batchFiles.length}`;
    say(byId("batchScheduleStatus"), "");
  });

  byId("batchSchedule").addEventListener("click", async () => {
    const status = byId("batchScheduleStatus");
    say(status, "Working…", "working");
    try {
      const { scheduled, skipped } = await send("/api/schedule/many", "POST", {
        items: batchFiles.map((reel) => ({ reel })),
      });
      const first = scheduled[0] ? ` — first ${when(scheduled[0].scheduled_at)}` : "";
      const why = skipped.length ? ` · ${skipped.length} skipped: ${skipped.map((s) => s.reason).join("; ")}` : "";
      say(status, `${scheduled.length} scheduled${first}${why}`, skipped.length ? "warn" : "");
      refreshCount();
    } catch (error) {
      say(status, error.message, "error");
    }
  });

  /* The tab's count, kept current from whichever view is showing. */
  const refreshCount = () =>
    api("/api/schedule")
      .then((state) => {
        view = state;
        zone = state.settings.timezone;
        if (!byId("viewSchedule").hidden) return refresh();
        const live = state.posts.filter((p) => p.status === "scheduled" || p.status === "publishing").length;
        const failed = state.posts.filter((p) => p.status === "failed").length;
        const count = byId("queueCount");
        count.hidden = live === 0 && failed === 0;
        count.textContent = failed ? `${live} · ${failed}!` : String(live);
        count.classList.toggle("has-failed", failed > 0);
      })
      .catch(() => {});

  refreshCount();
  if (!byId("viewSchedule").hidden) window.dispatchEvent(new CustomEvent("view:schedule"));
})();
