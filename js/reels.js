/* BELLORA — reels screen
 * One full-screen player: reels autoplay (muted), advance when each one ends and
 * loop forever. Sources come from /api/reels (Instagram API, local video files, or
 * — as a tap-to-play fallback — Instagram embeds). Remote values are only ever
 * inserted with DOM APIs, never innerHTML. */
(function () {
  "use strict";

  const stage = document.getElementById("reelsStage");
  const section = document.getElementById("reels");
  if (!stage || !section) return;

  const prevBtn = document.getElementById("reelsPrev");
  const nextBtn = document.getElementById("reelsNext");
  const soundBtn = document.getElementById("reelsSound");
  const countEl = document.getElementById("reelsCount");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NS = "http://www.w3.org/2000/svg";
  const PROFILE = "https://www.instagram.com/bellora.elegantly/";

  let items = [];
  let idx = 0;
  let soundOn = false;
  let visible = true;      // start playing as soon as the page loads – don't wait for the section to scroll into view
  let userPaused = false;
  let swiped = false;
  let progress = null;
  let igLink = null;

  const safeMedia = (u) => (/^https:\/\//.test(u || "") || /^\/assets\/[\w.%\-\/]+$/.test(u || "") ? u : "");
  const safeLink = (u) => (/^https:\/\/www\.instagram\.com\//.test(u || "") ? u : PROFILE);

  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function svg(paths, size) {
    const s = document.createElementNS(NS, "svg");
    [["viewBox", "0 0 24 24"], ["width", size || 18], ["height", size || 18], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.5"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]
      .forEach(([k, v]) => s.setAttribute(k, v));
    paths.forEach((d) => { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.appendChild(p); });
    return s;
  }

  /* ── nodes ────────────────────────────────────────────── */
  function makeVideo(r, n) {
    const v = document.createElement("video");
    v.className = "rv";
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("muted", "");
    v.preload = n === 0 ? "auto" : "metadata";
    v.setAttribute("aria-label", r.caption || "Bellora reel " + (n + 1));
    if (safeMedia(r.poster)) v.poster = r.poster;
    v.src = safeMedia(r.src);
    v.loop = items.length === 1;
    v.addEventListener("ended", () => go(1));
    v.addEventListener("timeupdate", () => {
      if (items[idx] === r && v.duration) r.fill.style.width = (v.currentTime / v.duration) * 100 + "%";
    });
    v.addEventListener("play", syncState);
    v.addEventListener("pause", syncState);
    v.addEventListener("error", () => fail(r));
    return v;
  }

  function makeEmbed(r) {
    return el("iframe", "rv", {
      src: r.embedUrl, title: "Bellora reel on Instagram", allowfullscreen: "", scrolling: "no",
      referrerpolicy: "strict-origin-when-cross-origin",
    });
  }

  function showFollow() {
    stage.classList.remove("is-loading", "is-embed", "is-playing");
    section.classList.add("is-empty");
    stage.replaceChildren();
    const box = el("div", "reel__cta");
    const p = el("p");
    p.textContent = "Our reels live on Instagram.";
    const a = el("a", "btn btn--ghost", { href: PROFILE, target: "_blank", rel: "noopener" });
    const s = el("span");
    s.textContent = "Watch @bellora.elegantly";
    a.appendChild(s);
    box.append(p, a);
    stage.appendChild(box);
  }

  /* ── playback ─────────────────────────────────────────── */
  const cur = () => items[idx];
  const curVideo = () => (cur() && cur().video ? cur().node : null);

  function syncState() {
    const v = curVideo();
    stage.classList.toggle("is-playing", !!v && !v.paused);
  }

  function syncSound() {
    soundBtn.setAttribute("aria-pressed", String(soundOn));
    soundBtn.setAttribute("aria-label", soundOn ? "Turn sound off" : "Turn sound on");
    const v = curVideo();
    if (v) v.muted = !soundOn;
  }

  function playCurrent(force) {
    const v = curVideo();
    if (!v) return;
    if (!force && (!visible || document.hidden || reduced || userPaused)) { v.pause(); return; }
    v.muted = !soundOn;
    const p = v.play();
    if (p && p.catch) p.catch(() => {            // browser refused (e.g. sound without a gesture) → retry muted
      if (!v.muted) { soundOn = false; syncSound(); v.play().catch(() => {}); }
    });
  }

  function show(i) {
    const leaving = items[idx];
    idx = i;
    const r = items[idx];
    if (!r.node) { r.node = makeEmbed(r); stage.appendChild(r.node); }

    items.forEach((it, j) => {
      if (it.node) it.node.classList.toggle("is-active", j === idx);
      it.seg.classList.toggle("is-done", j < idx);
      it.fill.style.width = j < idx ? "100%" : "0%";
    });

    if (leaving && leaving !== r && leaving.video && leaving.node) {
      setTimeout(() => { if (cur() !== leaving) { leaving.node.pause(); leaving.node.currentTime = 0; } }, 750);
    }

    stage.classList.toggle("is-embed", !!r.embed);
    soundBtn.hidden = !!r.embed;
    igLink.href = safeLink(r.permalink);
    countEl.textContent = String(idx + 1).padStart(2, "0") + " / " + String(items.length).padStart(2, "0");

    const nx = items[(idx + 1) % items.length];
    if (nx && nx.video && nx.node) nx.node.preload = "auto";   // warm up the next reel

    if (r.video) {
      r.node.currentTime = 0;
      userPaused = false;
      syncSound();
      playCurrent();
      syncState();
    } else {
      stage.classList.remove("is-playing");
    }
  }

  function go(dir) {
    if (items.length < 2) return;
    show((idx + dir + items.length) % items.length);
  }

  function fail(r) {                                 // dead/blocked file: drop it from the loop
    const k = items.indexOf(r);
    if (k < 0) return;
    items.splice(k, 1);
    if (r.node) r.node.remove();
    r.seg.remove();
    if (!items.length) return showFollow();
    items.forEach((it) => { if (it.node && it.video) it.node.loop = items.length === 1; });
    if (k <= idx) idx = Math.max(0, idx - (k < idx ? 1 : 0));
    show(Math.min(idx, items.length - 1));
  }

  /* ── controls ─────────────────────────────────────────── */
  prevBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));
  soundBtn.addEventListener("click", () => { soundOn = !soundOn; syncSound(); if (soundOn) playCurrent(true); });

  stage.addEventListener("click", () => {
    if (swiped) { swiped = false; return; }
    const v = curVideo();
    if (!v) return;
    if (v.paused) { userPaused = false; playCurrent(true); } else { userPaused = true; v.pause(); }
  });
  stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
  });
  let sx = 0, sy = 0;
  stage.addEventListener("pointerdown", (e) => { sx = e.clientX; sy = e.clientY; });
  stage.addEventListener("pointerup", (e) => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = true; go(dx < 0 ? 1 : -1); }
  });

  document.addEventListener("visibilitychange", () => playCurrent());

  /* ── load ─────────────────────────────────────────────── */
  fetch("/api/reels", { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
    .then((data) => {
      const list = ((data && data.reels) || []).filter((r) =>
        (r.video && safeMedia(r.video)) || (r.embedUrl && /^https:\/\/www\.instagram\.com\//.test(r.embedUrl)));
      // autoplaying videos and tap-to-play embeds don't mix: if any real video exists, use only videos
      const vids = list.filter((r) => r.video);
      const chosen = vids.length ? vids : list;
      stage.classList.remove("is-loading");
      stage.replaceChildren();
      if (!chosen.length) return showFollow();

      progress = el("div", "reels__progress", { "aria-hidden": "true" });
      items = chosen.map((r) => {
        const seg = el("i");
        const fill = el("b");
        seg.appendChild(fill);
        progress.appendChild(seg);
        return { video: !!r.video, embed: !r.video, embedUrl: r.embedUrl, poster: r.poster, permalink: r.permalink, caption: r.caption, node: null, seg, fill, src: r.video };
      });
      items.forEach((it, n) => {
        if (it.video) { it.node = makeVideo(it, n); stage.appendChild(it.node); }
      });
      stage.appendChild(progress);

      igLink = el("a", "reel__btn", { href: PROFILE, target: "_blank", rel: "noopener", "aria-label": "Watch on Instagram" });
      igLink.appendChild(svg(["M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4z", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M17.5 6.5h.01"]));
      igLink.addEventListener("click", (e) => e.stopPropagation());
      stage.appendChild(igLink);

      const play = el("div", "reel__play", { "aria-hidden": "true" });
      const circle = el("span");
      circle.appendChild(svg(["M8 5.5v13l11-6.5z"], 24));
      play.appendChild(circle);
      stage.appendChild(play);

      if (items.length < 2) { prevBtn.hidden = true; nextBtn.hidden = true; }
      show(0);
    })
    .catch(() => showFollow());
})();
