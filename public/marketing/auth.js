// New plan, Section 2 — two-step signup: POST /api/signup/request-otp
// verifies the signer owns the email before POST /api/signup creates
// anything, then the created tenant is "pending" until a platform admin
// activates it (see server.js's /api/signup comment for why) — so
// success here means "thanks, we'll be in touch," not "you're in."
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

      // Account created and pending review — not an instant dashboard
      // login, so replace the form with a clear next-step message rather
      // than redirecting somewhere that will just bounce back to login.
      form.hidden = true;
      const wrap = form.parentElement;
      const done = document.createElement("div");
      done.className = "auth-card";
      done.innerHTML =
        "<h2>You're on the list! 🎉</h2>" +
        "<p class=\"auth-sub\">Thanks for signing up — our team will review your account and reach out shortly to get you fully set up. You'll get an email once you're activated and ready to log in.</p>";
      wrap.appendChild(done);
    } catch (err) {
      showError(err.message);
      submitBtn.disabled = false;
      submitBtn.querySelector("span").textContent = "Verify & create account";
    }
  });
})();
