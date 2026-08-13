// New plan, Section 2 — two-step signup: POST /api/signup/request-otp
// verifies the signer owns the email before POST /api/signup creates
// anything. New plan, Stream 2 — the created tenant now lands at
// "awaiting_payment", not "pending review" (see src/routes/auth.js's
// /api/signup comment) — so a successful signup redirects straight to
// plan-selection.html, not a static "we'll be in touch" message. The
// session cookie POST /api/signup just set travels with that redirect
// (same-origin navigation), so that page is already logged in.
(() => {
  const form = document.getElementById("signupForm");
  const errorBanner = document.getElementById("errorBanner");
  const successBanner = document.getElementById("successBanner");
  const submitBtn = document.getElementById("submitBtn");
  const otpField = document.getElementById("otpField");
  const otpInput = document.getElementById("otp");

  let otpRequested = false;

  function showError(message) {
    successBanner.hidden = true;
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }
  function showSuccess(message) {
    errorBanner.hidden = true;
    successBanner.textContent = message;
    successBanner.hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBanner.hidden = true;

    const businessName = form.businessName.value.trim();
    const email = form.email.value.trim();
    const password = form.password.value;

    if (!otpRequested) {
      if (!businessName || !email || password.length < 8) {
        showError("Please fill in your business name, a valid email, and a password of at least 8 characters first.");
        return;
      }
      submitBtn.disabled = true;
      submitBtn.querySelector("span").textContent = "Sending code…";
      try {
        const resp = await fetch("/api/signup/request-otp", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || "Couldn't send a verification code — please try again.");

        otpRequested = true;
        otpField.hidden = false;
        otpInput.focus();
        submitBtn.querySelector("span").textContent = "Verify & create account";
        showSuccess("A verification code has been sent to your email.");
      } catch (err) {
        showError(err.message);
      } finally {
        submitBtn.disabled = false;
      }
      return;
    }

    // Second submit: the code field is now visible and required.
    const otp = otpInput.value.trim();
    if (!otp) {
      showError("Enter the verification code we sent you.");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.querySelector("span").textContent = "Creating your account…";
    try {
      const resp = await fetch("/api/signup", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          ownerName: form.ownerName.value.trim(),
          email,
          password,
          otp,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || "Something went wrong — please try again.");

      // Account created, session cookie set — straight to plan selection,
      // the next real step, not a dead-end "thanks" message.
      window.location.href = "/plan-selection";
    } catch (err) {
      showError(err.message);
      submitBtn.disabled = false;
      submitBtn.querySelector("span").textContent = "Verify & create account";
    }
  });
})();
