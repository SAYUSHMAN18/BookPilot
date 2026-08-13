// New plan, Stream 2 — the page a fresh signup lands on right after
// POST /api/signup (see auth.js's redirect there). GET /api/billing/plans
// is unauthenticated on purpose (it's just a price list); POST
// /api/billing/checkout is the one that actually needs the session cookie
// this page relies on already being set from signup.
(() => {
  const grid = document.getElementById("planGrid");
  const errorBanner = document.getElementById("errorBanner");
  const logoutLink = document.getElementById("logoutLink");

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  function formatAmount(paise, currency) {
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
      card.innerHTML = `
        <h3>${plan.label}</h3>
        <div class="plan-price">${formatAmount(plan.amount, plan.currency)}<span> / month</span></div>
        <p class="plan-cycle">Billed monthly, cancel anytime.</p>
        <button class="btn btn-primary btn-full" type="button" data-plan="${plan.id}"><span>Choose ${plan.label}</span></button>
      `;
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
    btn.querySelector("span").textContent = "Redirecting to payment…";
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
    window.location.href = "/marketing/signup.html";
  });

  loadPlans();
})();
