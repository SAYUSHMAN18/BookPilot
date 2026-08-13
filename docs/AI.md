# AI layer

Every AI call in this codebase lives under `src/ai/` and goes through one
shared HTTP client. This doc maps each module to its purpose, model,
timeout, and callers — read this before adding a new AI call site or
changing how an existing one behaves.

## Design principles (why it's organized this way)

- **One shared client, one shared timeout.** Every module below calls
  `groqClient.js`'s `groqChatCompletion()` instead of hitting Groq's API
  directly. Before this existed, a hung Groq response could block a
  message handler indefinitely — no `AbortController`, no deadline. Now
  every call gets a hard 5s timeout by default (`GROQ_TIMEOUT_MS`),
  overridable per-call (`workflowGenerator.js` uses 15s — see below).
- **The AI never owns a write.** `orchestrator.js`'s own comment states
  this most directly: the model plans *which navigation action* to take
  (retry, go back a step, cancel, hand off to a human), but the
  deterministic engine (`src/engine/workflowEngine.js`) still executes
  every actual state change — slot locking, validation, and persistence
  are untouched by any model output. No module here can call
  `create_booking` or anything like it.
- **Every model output is untrusted input.** Three enforcement patterns
  recur across every module:
  1. **Closed vocabularies.** `intentDetector.js`'s intents, `orchestrator.js`'s
     actions, and `classify.js`'s workflow ids are all fixed sets — an
     unrecognized string from the model is treated as a parse failure, not
     guessed at.
  2. **Grounding against real data.** `extractContext.js`'s extracted
     provider name must match an actual provider in the workflow;
     `factualQA.js`'s answers must come only from the DATA block it's
     given. A model can still hallucinate a real-sounding value that
     happens to match — `workflowEngine.js`'s `tryAutoFillStep` additionally
     requires the extracted value to literally appear in the customer's own
     message before accepting it (found live: a garbage string got a real
     provider name hallucinated onto it that happened to exist).
  3. **Deterministic fallback on every failure.** Every module degrades to
     regex/keyword logic (or a safe default) if `GROQ_API_KEY` is unset, the
     call times out, or the response fails validation. The bot never breaks
     because of a missing key or a transient API error — see each module's
     own fallback below.
- **Keyword override for the two highest-cost intents.** `intentDetector.js`
  lets its own regex fallback (`CANCEL_RE`/`STATUS_RE`) override an LLM
  verdict, but *only* for `cancel_booking`/`check_status` — a false
  negative there (silently not cancelling/not showing status) is worse
  than being wrong on a softer intent, where the cost is one extra
  clarifying turn.

## Module reference

| Module | Purpose | Model | Timeout | Called from |
|---|---|---|---|---|
| `groqClient.js` | Shared HTTP client every other module calls through — auth header, endpoint, `AbortController` timeout. Not itself an AI call. | n/a | 5s default (`GROQ_TIMEOUT_MS`), overridable per-call | Every other `src/ai/*` module |
| `classify.js` | Business Detection Engine — routes a free-text message to one workflow id, or `null` for anything that isn't clearly a booking request. | `llama-3.1-8b-instant`, temp 0, 8 tokens | 5s (default) | `workflowEngine.js` (`handleDetecting`) |
| `intentDetector.js` | Classifies a message into one of 8 fixed intents (cancel/status/restart/question/complaint/booking/greeting/unclear) for a customer NOT currently mid-booking. | `llama-3.1-8b-instant`, temp 0, 10 tokens, few-shot | 5s (default) | `workflowEngine.js` (`handleGlobalSpecialActions`) |
| `extractContext.js` | Pulls provider name / date hint / customer name out of a customer's opening message so the bot can skip questions already answered. | `llama-3.1-8b-instant`, temp 0, 150 tokens, JSON mode | 5s (default) | `workflowEngine.js` (right after a workflow is matched) |
| `orchestrator.js` | Agentic step router for a customer mid-booking who says something that doesn't fit the current step — plans ONE of 6 fixed navigation actions, never a write. | `llama-3.1-8b-instant`, temp 0, 60 tokens, JSON mode, few-shot | 5s (default) | `workflowEngine.js` (`applyStepInput`, when the raw answer doesn't validate) |
| `factualQA.js` | Two functions: `tryAnswerFactually` answers a general question about the business from its own config + uploaded FAQ docs; `tryAnswerAboutBooking` answers a follow-up about the customer's OWN booking. Both grounded — must say `NO_ANSWER` (→ `null`) rather than invent a fact. Also exports `MAX_DOC_CHARS` (a plain constant, not an AI call) consumed by `dashboard.js`'s knowledge-base upload limit. | `llama-3.1-8b-instant`, temp 0, 150/100 tokens | 5s (default) | `workflowEngine.js` (`handleAiChat`, `handleStatusCommand`-adjacent follow-ups) |
| `translate.js` | Two functions: `translateForVoice` (spoken-language translation before TTS, fails open to English) and `translateText` (translates an outgoing WhatsApp text reply). | `llama-3.1-8b-instant`, temp 0 / 0.1, 400/500 tokens | 5s (default) | `translateForVoice`: `webhook.js` (voice-note reply pipeline). `translateText`: `workflowEngine.js` |
| `workflowGenerator.js` | Drafts a full workflow JSON from a plain-language business description, for the admin dashboard's "Generate business" feature. Never writes to disk itself — the admin reviews/edits the draft, and saving still goes through `validateWorkflowShape()`. | `llama-3.1-8b-instant`, temp 0.3, 2000 tokens, JSON mode | **15s explicit** (`GENERATE_TIMEOUT_MS`) — the one call site with a non-default timeout, since 2000 tokens genuinely needs more time than the 5s default allows | `dashboard.js` (`POST /api/dashboard/workflows/generate`) |

All eight modules use the same model (`llama-3.1-8b-instant`) — chosen for
latency (every one of these sits in a live WhatsApp reply's critical path
except `workflowGenerator.js`, which is a one-off admin action), not
necessarily peak quality. If a future call site needs materially better
reasoning at the cost of latency (e.g. a background job, not a live reply),
that's a deliberate model choice to make there, not a default to inherit.

## Where the API key comes from

Every module reads `process.env.GROQ_API_KEY` directly — no per-tenant
override is threaded through any of them by default.
`tenantStore.getGroqKeyOverride(tenantId)` exists (a tenant can bring
their own key on a higher plan) but as of this doc, no call site in
`src/ai/*` consults it — that override is groundwork for a feature not
yet wired up, not a currently-active behavior. If you're debugging "why
did this tenant's AI reply use the platform's key instead of their own,"
that's why: it's not implemented yet, not a bug.

## Extending this

Adding a new AI call site: reuse `groqClient.js`'s `groqChatCompletion()`
rather than calling `fetch()` directly (see `workflowGenerator.js`'s own
comment on why — it was, until fixed, the one call site that didn't and
could hang a request indefinitely). Pick a fixed, validated output
vocabulary if the model is choosing between actions. Ground any extracted
fact against real data before trusting it. Always have a non-AI fallback
path — nothing in this bot should hard-require `GROQ_API_KEY` to function
at a basic level, and every module above already proves that pattern.
