/* BELLORA — interactions */
(function () {
  "use strict";

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* screenshot/QA mode: ?snap disables entrance animations; ?snap&menu opens the mobile menu */
  const qaParams = new URLSearchParams(location.search);
  if (qaParams.has("snap")) {
    document.documentElement.classList.add("snap");
  }
  if (qaParams.has("menu")) {
    window.addEventListener("DOMContentLoaded", () => {
      const m = document.getElementById("menu");
      const b = document.getElementById("burger");
      if (m && b) {
        m.classList.add("is-open");
        b.classList.add("is-open");
        document.body.style.overflow = "hidden";
      }
    });
  }

  /* ── Preloader ─────────────────────────────────────────── */
  const preloader = document.getElementById("preloader");
  const heroImg = document.getElementById("heroImg");

  function dismissPreloader() {
    if (!preloader || preloader.classList.contains("is-done")) return;
    preloader.classList.add("is-done");
    document.body.classList.add("is-loaded");
  }

  if (heroImg && !heroImg.complete) {
    heroImg.addEventListener("load", () => setTimeout(dismissPreloader, 1400));
    heroImg.addEventListener("error", dismissPreloader);
    setTimeout(dismissPreloader, 4200); // never trap the visitor
  } else {
    setTimeout(dismissPreloader, 1500);
  }

  /* ── Navigation state on scroll ────────────────────────── */
  const nav = document.getElementById("nav");
  function onScrollNav() {
    nav.classList.toggle("is-scrolled", window.scrollY > 40);
  }
  onScrollNav();
  window.addEventListener("scroll", onScrollNav, { passive: true });

  /* ── Mobile menu ───────────────────────────────────────── */
  const burger = document.getElementById("burger");
  const menu = document.getElementById("menu");

  function toggleMenu(force) {
    const open = typeof force === "boolean" ? force : !menu.classList.contains("is-open");
    menu.classList.toggle("is-open", open);
    burger.classList.toggle("is-open", open);
    burger.setAttribute("aria-expanded", String(open));
    menu.setAttribute("aria-hidden", String(!open));
    document.body.style.overflow = open ? "hidden" : "";
    if (open) nav.classList.remove("is-scrolled");
    else onScrollNav();
  }
  burger.addEventListener("click", () => toggleMenu());

  /* ── Smooth anchor scrolling ───────────────────────────── */
  document.querySelectorAll("[data-scroll]").forEach((link) => {
    link.addEventListener("click", (e) => {
      const id = link.getAttribute("href");
      if (!id || !id.startsWith("#")) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      const wasOpen = menu.classList.contains("is-open");
      if (wasOpen) toggleMenu(false);
      setTimeout(() => {
        target.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth" });
      }, wasOpen ? 350 : 0);
    });
  });

  /* ── Scroll reveals ────────────────────────────────────── */
  const revealEls = document.querySelectorAll(".reveal, .reveal-img");
  if ("IntersectionObserver" in window && !prefersReduced) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-in"));
  }

  /* ── Gentle parallax on tagged imagery ─────────────────── */
  const parallaxEls = Array.from(document.querySelectorAll("[data-parallax]"));
  if (parallaxEls.length && !prefersReduced) {
    let ticking = false;
    function parallax() {
      const vh = window.innerHeight;
      parallaxEls.forEach((el) => {
        const speed = parseFloat(el.dataset.parallax) || 0.06;
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -100 || rect.top > vh + 100) return;
        const progress = (rect.top + rect.height / 2 - vh / 2) / vh; // -0.5 … 0.5
        el.style.transform = `translate3d(0, ${(progress * speed * -100).toFixed(2)}%, 0) scale(1.14)`;
      });
      ticking = false;
    }
    window.addEventListener(
      "scroll",
      () => {
        if (!ticking) {
          requestAnimationFrame(parallax);
          ticking = true;
        }
      },
      { passive: true }
    );
    parallax();
  }

  /* ── Reservation form ──────────────────────────────────── */
  const form = document.getElementById("reserveForm");
  const success = document.getElementById("reserveSuccess");
  const successName = document.getElementById("successName");
  const dateInput = document.getElementById("f-date");

  if (dateInput) {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    dateInput.min = iso;
  }

  if (form) {
    const errorBox = document.getElementById("reserveError");
    const submitBtn = form.querySelector('button[type="submit"]');

    const showError = (html) => { errorBox.innerHTML = html; errorBox.hidden = false; };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      if (!form.reportValidity()) return;

      const data = Object.fromEntries(new FormData(form).entries());
      const firstName = (data.name || "").toString().trim().split(" ")[0] || "guest";

      submitBtn.disabled = true;
      try {
        const res = await fetch("/api/reservations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const out = await res.json().catch(() => ({}));

        if (!res.ok || !out.ok) {
          const first = out.errors && Object.values(out.errors)[0];
          showError(first || out.error || 'Something went wrong. Please call us on <a href="tel:+917291045151">072910 45151</a>.');
          return;
        }

        successName.textContent = firstName;
        success.hidden = false;
        success.style.opacity = "0";
        requestAnimationFrame(() => {
          success.style.transition = "opacity 0.8s cubic-bezier(0.22,1,0.36,1)";
          success.style.opacity = "1";
        });
        form.reset();
      } catch (_) {
        showError('We couldn’t reach the server. Please call us on <a href="tel:+917291045151">072910 45151</a>.');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }
})();
