// Real customers don't type 500+ character booking requests. Capping what
// gets sent to the AI keeps cost/latency sane and reduces the odds of
// degenerate long input (repeated characters, pasted junk) producing a
// confused or hallucinated response — verified live: an uncapped 5000-char
// garbage string got a hallucinated provider name extracted from it.
const MAX_AI_INPUT_LENGTH = 500;

function capForAI(text) {
  return (text || "").slice(0, MAX_AI_INPUT_LENGTH);
}

module.exports = { MAX_AI_INPUT_LENGTH, capForAI };
