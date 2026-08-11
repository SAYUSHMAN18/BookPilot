// Signup form -> POST /api/signup -> session cookie set -> straight into
// the dashboard. Same fetch-with-credentials pattern as the React
// dashboard's own lib/api.js, kept dependency-free here since this page
// intentionally has no build step.
(() => {
  const form = document.getElementById("signupForm");
  const errorBanner = document.getElementById("errorBanner");
  const submitBtn = document.getElementById("submitBtn");

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBanner.hidden = true;
    submitBtn.disabled = true;
    submitBtn.querySelector("span").textContent = "Creating your account…";

    const body = {
      businessName: form.businessName.value.trim(),
      ownerName: form.ownerName.value.trim(),
      email: form.email.value.trim(),
      password: form.password.value,
    };

    try {
      const resp = await fetch("/api/signup", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || "Something went wrong — please try again.");

      // Session cookie is already set by the response above — land the new
      // owner straight in their dashboard, no separate login step.
      window.location.href = "/app";
    } catch (err) {
      showError(err.message);
      submitBtn.disabled = false;
      submitBtn.querySelector("span").textContent = "Create free account";
    }
  });
})();
