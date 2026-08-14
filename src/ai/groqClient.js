// Overridable so a test can point this at a local server that never
// responds, to prove the timeout actually fires — hitting the real Groq
// API in a test would be slow, flaky, and not actually test the timeout
// path (a real response, however slow, isn't the same as a genuine hang).
const GROQ_URL = process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions";
// Overridable the same way, and for the same reason — a full-pipeline test
// against a hanging server should take milliseconds, not the production
// default's several seconds, to actually be a fast test suite.
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS) || 5000;

// Every Groq call in this codebase shares the same endpoint, auth header
// shape, and now the same hard timeout — centralized so "every Groq call
// needs a timeout" is one change, not four copies of fetch() boilerplate
// that can drift out of sync. Before this existed, a hung Groq response
// blocked the entire message handler indefinitely: no AbortController, no
// deadline anywhere, which was the actual root cause of both the slow
// replies and the cases where a customer got no reply at all.
//
// Found live (audit pass, rapid-fire testing) — a 429 (rate limit) used
// to fail exactly like any other error: straight to the caller's
// fallback, no retry at all. Unlike a timeout or a genuine 5xx, a 429 is
// specifically "try again shortly," not "something's actually wrong" —
// one short, bounded retry (never more — this sits in a live WhatsApp
// reply's critical path, an unbounded retry loop would just turn a rate
// limit into a hung reply) recovers cleanly from a brief burst without
// changing behavior for any other error type, which still fails once and
// falls through to the caller's own keyword/deterministic fallback exactly
// as before.
const RATE_LIMIT_RETRY_DELAY_MS = 500;

async function attemptGroqCall(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = new Error(`Groq API responded ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    return { data, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`Groq call timed out after ${timeoutMs}ms`);
      timeoutErr.code = "GROQ_TIMEOUT";
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Callers get a rejected promise on timeout/failure and are expected to
// catch it and fall back to their own keyword/deterministic logic — this
// module never decides what "safe default" means for a caller, since that
// differs per call site (classification defaults to null, intent defaults
// to a keyword guess, factual Q&A defaults to no answer).
async function groqChatCompletion(body, { timeoutMs = GROQ_TIMEOUT_MS } = {}) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");

  try {
    return await attemptGroqCall(body, timeoutMs);
  } catch (err) {
    if (err.status !== 429) throw err;
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS));
    return attemptGroqCall(body, timeoutMs); // one retry only — a second 429 here propagates to the caller as-is
  }
}

module.exports = { groqChatCompletion, GROQ_TIMEOUT_MS };
