// BookPilot AI — marketing site interactions. No framework, no build step —
// same "static files served by Express" philosophy as the rest of the app.
(() => {
  document.getElementById("year").textContent = new Date().getFullYear();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- nav scroll state + mobile menu ---------- */
  const nav = document.getElementById("nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const burger = document.getElementById("navBurger");
  const mobile = document.getElementById("navMobile");
  const setMobileOpen = (open) => {
    mobile.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
  };
  burger.addEventListener("click", () => setMobileOpen(!mobile.classList.contains("open")));
  mobile.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setMobileOpen(false)));

  /* ---------- cursor glow (desktop only, ignored on touch) ---------- */
  const glow = document.getElementById("cursorGlow");
  if (matchMedia("(pointer: fine)").matches && !reducedMotion) {
    window.addEventListener("mousemove", (e) => {
      glow.style.left = `${e.clientX}px`;
      glow.style.top = `${e.clientY}px`;
    });
  }

  /* ---------- reveal-on-scroll ---------- */
  const revealItems = document.querySelectorAll("[data-reveal]");
  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          revealObserver.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15, rootMargin: "0px 0px -60px 0px" }
  );
  revealItems.forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 4, 3) * 60}ms`;
    revealObserver.observe(el);
  });

  /* ---------- animated stat counters ---------- */
  const statObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const target = Number(el.dataset.count);
        const duration = 900;
        const start = performance.now();
        function tick(now) {
          const p = Math.min((now - start) / duration, 1);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(target * eased);
          if (p < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
        statObserver.unobserve(el);
      }
    },
    { threshold: 0.5 }
  );
  document.querySelectorAll(".stat-num").forEach((el) => statObserver.observe(el));

  /* ---------- FAQ accordion ---------- */
  document.querySelectorAll(".faq-item").forEach((item) => {
    const btn = item.querySelector(".faq-q");
    btn.addEventListener("click", () => {
      const wasOpen = item.classList.contains("open");
      document.querySelectorAll(".faq-item.open").forEach((o) => {
        o.classList.remove("open");
        o.querySelector(".faq-q").setAttribute("aria-expanded", "false");
      });
      if (!wasOpen) {
        item.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  /* ---------- WhatsApp bubble sequencer ----------
     Small, dependency-free chat-replay engine shared by the ambient hero
     mock and the full "watch a real booking happen" demo. Each step is
     either a message bubble or a tappable list; `typingMs` shows the
     three-dot indicator first so it reads as a live conversation, not a
     static screenshot. */
  function playSequence(container, steps, { loop = false, statusEl = null } = {}) {
    let cancelled = false;
    container._cancelPlay?.();
    container._cancelPlay = () => { cancelled = true; };

    async function run() {
      container.innerHTML = "";
      for (const step of steps) {
        if (cancelled) return;
        if (step.typingMs) {
          const dots = document.createElement("div");
          dots.className = "typing-dots";
          dots.innerHTML = "<span></span><span></span><span></span>";
          if (statusEl) statusEl.textContent = "typing…";
          container.appendChild(dots);
          container.scrollTop = container.scrollHeight;
          await wait(step.typingMs);
          if (cancelled) return;
          dots.remove();
          if (statusEl) statusEl.textContent = "online";
        }
        const bubble = document.createElement("div");
        bubble.className = `bubble ${step.type}`;
        if (step.type === "list") {
          bubble.innerHTML = `${escapeHtml(step.text)}${step.options.map((o) => `<span class="opt">${escapeHtml(o)}</span>`).join("")}`;
        } else {
          bubble.textContent = step.text;
        }
        container.appendChild(bubble);
        container.scrollTop = container.scrollHeight;
        await wait(step.holdMs || 450);
      }
      if (loop && !cancelled) {
        await wait(1600);
        if (!cancelled) run();
      }
    }
    run();
  }
  function wait(ms) { return new Promise((r) => setTimeout(r, reducedMotion ? Math.min(ms, 60) : ms)); }
  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

  /* ---------- hero ambient mock (short, loops) ---------- */
  const heroSteps = [
    { type: "in", text: "Hi, need a haircut tomorrow evening", holdMs: 500 },
    { type: "out", text: "Got it! Based on your message, it looks like you need a hair stylist.", typingMs: 700, holdMs: 500 },
    { type: "list", text: "Please choose a time slot.", options: ["5:00 pm", "5:45 pm", "6:30 pm"], typingMs: 500, holdMs: 700 },
    { type: "in", text: "5:45 pm", holdMs: 500 },
    { type: "out", text: "✅ Booking confirmed!\nSnip & Style · 5:45 pm\nReply STATUS anytime.", typingMs: 800, holdMs: 2200 },
  ];
  playSequence(document.getElementById("waBody"), heroSteps, { loop: true, statusEl: document.getElementById("waStatus") });

  /* ---------- full demo (medical booking, plays once on scroll-in) ---------- */
  // Generate dynamic date labels so the demo never shows a past date
  const _today = new Date();
  const _tomorrow = new Date(_today); _tomorrow.setDate(_today.getDate() + 1);
  const _dayAfter = new Date(_today); _dayAfter.setDate(_today.getDate() + 2);
  const _dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const _monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const _dayAfterLabel = `${_dayNames[_dayAfter.getDay()]}, ${_dayAfter.getDate()} ${_monthNames[_dayAfter.getMonth()]}`;
  // Generate a booking ID that looks current (uses today's date)
  const _pad = (n) => String(n).padStart(2, "0");
  const _aptDate = `${_today.getFullYear()}${_pad(_today.getMonth()+1)}${_pad(_today.getDate())}`;
  const _aptId = `APT-${_aptDate}-X7QK`;

  const demoSteps = [
    { type: "in", text: "I have a fever, need to see a doctor", holdMs: 500 },
    { type: "out", text: "Got it! Based on your message, it looks like you need a doctor.", typingMs: 900, holdMs: 500 },
    { type: "list", text: "Please select the doctor you'd like to consult.", options: ["Dr. Rajesh Sharma — General Physician (₹500)", "Dr. Neha Mehta — Orthopedic (₹700)", "Dr. Imran Khan — Dermatologist (₹600)"], typingMs: 600, holdMs: 800 },
    { type: "in", text: "Dr. Rajesh Sharma", holdMs: 500 },
    { type: "list", text: "Please select your preferred date.", options: ["Today", "Tomorrow", _dayAfterLabel], typingMs: 600, holdMs: 700 },
    { type: "in", text: "Today", holdMs: 450 },
    { type: "list", text: "Please choose a time slot.", options: ["4:30 pm", "5:00 pm", "5:30 pm"], typingMs: 600, holdMs: 700 },
    { type: "in", text: "5:30 pm", holdMs: 450 },
    { type: "out", text: "What's your name?", typingMs: 600, holdMs: 500 },
    { type: "in", text: "Aisha", holdMs: 450 },
    { type: "out", text: `✅ Your appointment has been confirmed!\n\n🆔 ${_aptId}\n👨‍⚕️ Dr. Rajesh Sharma\n📅 Today · 5:30 pm\n💰 ₹500\n\nReply HERE when you arrive.`, typingMs: 1000, holdMs: 4000 },
  ];
  const demoBody = document.getElementById("demoBody");
  let demoPlayed = false;
  const demoObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !demoPlayed) {
          demoPlayed = true;
          playSequence(demoBody, demoSteps);
        }
      }
    },
    { threshold: 0.4 }
  );
  demoObserver.observe(demoBody);
  document.getElementById("demoReplay").addEventListener("click", () => {
    demoBody.classList.remove("live");
    playSequence(demoBody, demoSteps);
  });

  /* ---------- Item 8: the real, live chat widget ----------
     Talks to POST /api/demo/chat — a dedicated, permanently-sandboxed
     demo tenant on the backend (never any real business's data). A
     per-tab sessionId (sessionStorage, so it's gone when the tab closes)
     keeps this visitor's conversation independent of every other
     visitor's, without ever looking like a real WhatsApp number. */
  function demoSessionId() {
    let id = sessionStorage.getItem("bp_demo_session");
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      sessionStorage.setItem("bp_demo_session", id);
    }
    return id;
  }

  const liveDemoForm = document.getElementById("liveDemoForm");
  const liveDemoInput = document.getElementById("liveDemoInput");
  const liveDemoSend = document.getElementById("liveDemoSend");
  const demoStatus = document.getElementById("demoStatus");
  let liveModeStarted = false;

  function enterLiveMode() {
    if (liveModeStarted) return;
    liveModeStarted = true;
    demoObserver.unobserve(demoBody); // the scripted replay never auto-plays over a real conversation
    demoBody.classList.add("live");
    demoBody.innerHTML = "";
  }

  async function sendLiveDemoMessage(text) {
    enterLiveMode();
    const userBubble = document.createElement("div");
    userBubble.className = "bubble in";
    userBubble.textContent = text;
    demoBody.appendChild(userBubble);
    demoBody.scrollTop = demoBody.scrollHeight;

    const dots = document.createElement("div");
    dots.className = "typing-dots";
    dots.innerHTML = "<span></span><span></span><span></span>";
    demoBody.appendChild(dots);
    demoBody.scrollTop = demoBody.scrollHeight;
    if (demoStatus) demoStatus.textContent = "typing…";

    liveDemoInput.disabled = true;
    liveDemoSend.disabled = true;
    try {
      const resp = await fetch("/api/demo/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: demoSessionId(), text }),
      });
      const data = await resp.json().catch(() => ({}));
      dots.remove();
      if (!resp.ok) {
        const errBubble = document.createElement("div");
        errBubble.className = "bubble error";
        errBubble.textContent = data.error || "Something went wrong — please try again in a moment.";
        demoBody.appendChild(errBubble);
      } else {
        for (const part of String(data.reply || "").split("\n\n")) {
          if (!part.trim()) continue;
          const outBubble = document.createElement("div");
          outBubble.className = "bubble out";
          outBubble.textContent = part;
          demoBody.appendChild(outBubble);
        }
      }
    } catch {
      dots.remove();
      const errBubble = document.createElement("div");
      errBubble.className = "bubble error";
      errBubble.textContent = "Couldn't reach the demo right now — please try again in a moment.";
      demoBody.appendChild(errBubble);
    } finally {
      if (demoStatus) demoStatus.textContent = "online";
      liveDemoInput.disabled = false;
      liveDemoSend.disabled = false;
      demoBody.scrollTop = demoBody.scrollHeight;
      liveDemoInput.focus();
    }
  }

  if (liveDemoForm) {
    liveDemoForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = liveDemoInput.value.trim();
      if (!text) return;
      liveDemoInput.value = "";
      sendLiveDemoMessage(text);
    });
  }
})();
