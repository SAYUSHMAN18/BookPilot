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
  const authStep1 = document.getElementById("authStep1");
  const authStep2 = document.getElementById("authStep2");
  const authHeading = document.getElementById("authHeading");
  const authSub = document.getElementById("authSub");
  const preOtpFields = document.getElementById("preOtpFields");
  const authSummary = document.getElementById("authSummary");
  const authSummaryBiz = document.getElementById("authSummaryBiz");
  const authSummaryEmail = document.getElementById("authSummaryEmail");
  const authEditBtn = document.getElementById("authEditBtn");
  const resendBtn = document.getElementById("resendBtn");

  let otpRequested = false;

  // Sending the code again re-uses the exact same request the first submit
  // makes — the backend already treats a repeat request-otp for the same
  // email as "send another code" (see /api/signup/request-otp), this just
  // gives the customer an obvious button instead of having to guess that
  // going back and resubmitting would do the same thing. A short client-
  // side cooldown (not a hard block — the server is the real rate limit)
  // just stops someone mashing the button and getting 5 emails at once.
  async function sendOtp() {
    const email = form.email.value.trim();
    const resp = await fetch("/api/signup/request-otp", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || "Couldn't send a verification code — please try again.");
  }

  function startResendCooldown() {
    let remaining = 30;
    resendBtn.disabled = true;
    resendBtn.textContent = `Resend code (${remaining}s)`;
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        resendBtn.disabled = false;
        resendBtn.textContent = "Resend code";
        return;
      }
      resendBtn.textContent = `Resend code (${remaining}s)`;
    }, 1000);
  }

  resendBtn?.addEventListener("click", async () => {
    resendBtn.disabled = true;
    try {
      await sendOtp();
      showSuccess("Sent — check your inbox again.");
      startResendCooldown();
    } catch (err) {
      showError(err.message);
      resendBtn.disabled = false;
    }
  });

  authEditBtn?.addEventListener("click", () => {
    otpRequested = false;
    preOtpFields.hidden = false;
    authSummary.hidden = true;
    otpField.hidden = true;
    authStep1.classList.add("active");
    authStep1.classList.remove("done");
    authStep2.classList.remove("active");
    authHeading.textContent = "Create your business account";
    authSub.textContent = "";
    authSub.innerHTML = 'Already have one? <a href="/app">Log in</a>';
    submitBtn.querySelector("span").textContent = "Send verification code";
    errorBanner.hidden = true;
    successBanner.hidden = true;
  });

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
        await sendOtp();

        otpRequested = true;
        // Swap the 4 already-submitted fields for a compact summary —
        // showing all 4 plus the OTP field at once was pushing the actual
        // submit button below the fold (found live, from a real screenshot).
        preOtpFields.hidden = true;
        authSummaryBiz.textContent = businessName;
        authSummaryEmail.textContent = email;
        authSummary.hidden = false;
        otpField.hidden = false;
        otpInput.focus();
        submitBtn.querySelector("span").textContent = "Verify & create account";
        showSuccess("A verification code has been sent to your email.");
        authStep1.classList.remove("active");
        authStep1.classList.add("done");
        authStep2.classList.add("active");
        authHeading.textContent = "Check your inbox";
        authSub.textContent = `We sent a code to ${email}`;
        startResendCooldown();
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
