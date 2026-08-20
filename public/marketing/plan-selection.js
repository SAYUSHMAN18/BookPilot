// New plan, Stream 2 — the page a fresh signup lands on right after
// POST /api/signup (see auth.js's redirect there). GET /api/billing/plans
// is unauthenticated on purpose (it's just a price list); POST
// /api/billing/checkout is the one that actually needs the session cookie
// this page relies on already being set from signup.
//
// Found live (audit pass): every plan used to render as a paid checkout
// button, including an "Enterprise" tier that should never be self-serve
// — see src/infra/plans.js's own comment. Card behavior is keyed purely
// off amount: null (sales-assisted, contact links only) vs a real
// number (checkout, redirect to the returned paymentUrl) — no plan id
// is hardcoded here, so Starter going from ₹0 to a real ₹199/mo listing
// fee needed no changes on this page, just the price in plans.js. The
// amount===0 branch below is kept for any future free plan; nothing
// currently uses it.
(() => {
  const grid = document.getElementById("planGrid");
  const errorBanner = document.getElementById("errorBanner");
  const logoutLink = document.getElementById("logoutLink");

  // Same contact details as the marketing site's own Enterprise card
  // (public/marketing/index.html #pricing) — one real path, not a second
  // one that could drift out of sync.
  const CONTACT_EMAIL = "er.sayushman@gmail.com";
  const CONTACT_WHATSAPP = "https://wa.me/917838881412";

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  function formatAmount(paise) {
    return `₹${(paise / 100).toLocaleString("en-IN")}`;
  }

  async function loadPlans() {
    try {
      const resp = await fetch("/api/billing/plans");
      const plans = await resp.json();
      if (!resp.ok) throw new Error("Couldn't load plans — please refresh.");
      renderPlans(plans);
    } catch (err) {
      grid.innerHTML = "";
      showError(err.message);
    }
  }

  function renderPlans(plans) {
    grid.innerHTML = "";
    plans.forEach((plan, i) => {
      const card = document.createElement("div");
      card.className = "plan-card" + (i === 1 ? " plan-card-featured" : "");

      const priceHtml =
        plan.amount === null
          ? `<div class="plan-price">Custom</div><p class="plan-cycle">Public API, unlimited team logins, dedicated account manager.</p>`
          : plan.amount === 0
          ? `<div class="plan-price">Free</div><p class="plan-cycle">No card needed, upgrade anytime.</p>`
          : `<div class="plan-price">${formatAmount(plan.amount)}<span> / month</span></div><p class="plan-cycle">Billed monthly, cancel anytime.</p>`;

      const actionHtml =
        plan.amount === null
          ? `<div class="btn-group-stack">
               <a class="btn btn-outline btn-full" href="mailto:${CONTACT_EMAIL}"><svg class="icon"><use href="#icon-mail"/></svg> Email us</a>
               <a class="btn btn-outline btn-full" href="${CONTACT_WHATSAPP}" target="_blank" rel="noopener"><svg class="icon"><use href="#icon-message"/></svg> WhatsApp us</a>
             </div>`
          : `<button class="btn btn-primary btn-full" type="button" data-plan="${plan.id}"><span>${plan.amount === 0 ? "Start free" : `Choose ${plan.label}`}</span></button>`;

      card.innerHTML = `<h3>${plan.label}</h3>${priceHtml}${actionHtml}`;
      grid.appendChild(card);
    });
    grid.querySelectorAll("button[data-plan]").forEach((btn) => {
      btn.addEventListener("click", () => startCheckout(btn));
    });
  }

  async function startCheckout(btn) {
    errorBanner.hidden = true;
    const plan = btn.dataset.plan;
    const originalText = btn.querySelector("span").textContent;
    btn.disabled = true;
    btn.querySelector("span").textContent = "One moment…";
    try {
      const resp = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) {
        window.location.href = "/signup";
        return;
      }
      if (!resp.ok) throw new Error(data.error || "Couldn't start checkout — please try again.");

      if (data.activated) {
        // Free plan — nothing to pay, already queued for onboarding.
        // Same dashboard redirect the "log in" links elsewhere on this
        // site already use (window.DASHBOARD_URL, from /marketing/config.js).
        const dashboardUrl = window.DASHBOARD_URL || "http://localhost:8081";
        btn.querySelector("span").textContent = "You're in! Redirecting…";
        window.location.href = `${dashboardUrl}/app`;
        return;
      }
      window.location.href = data.paymentUrl;
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.querySelector("span").textContent = originalText;
    }
  }

  logoutLink.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // best-effort — the cookie may already be gone; either way, send them on
    }
    window.location.href = "/signup";
  });

  loadPlans();
})();
