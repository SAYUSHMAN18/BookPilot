import { useEffect, useRef, useState } from "react";

// Requested directly ("not just plain text/numbers") — a stat tile that
// counts up on load/refresh instead of just appearing reads as alive, the
// same "does this feel designed" gap the marketing site's aurora/gradient
// work already closed there. Ease-out cubic, not linear — a number that
// visibly decelerates into its final value reads as more deliberate than
// a constant-speed tick. Respects prefers-reduced-motion (same convention
// as every other animation in this codebase, e.g. .card's card-in, the
// login aurora) by jumping straight to the final value instead.
const prefersReducedMotion =
  typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function AnimatedNumber({ value, format, duration = 700 }) {
  const numeric = typeof value === "number" && Number.isFinite(value);
  const fmt = format || ((n) => n);
  const shouldAnimate = numeric && !prefersReducedMotion && !(typeof document !== "undefined" && document.hidden);
  const [display, setDisplay] = useState(shouldAnimate ? 0 : value);
  const prevValue = useRef(shouldAnimate ? 0 : value);

  useEffect(() => {
    // requestAnimationFrame is throttled to near-zero in a background tab
    // (found live: data loading while the dashboard tab isn't focused left
    // every stat tile stuck at 0 indefinitely, reading as a broken/empty
    // dashboard rather than a paused animation). Skip the tween entirely
    // when the tab starts hidden, and jump straight to the final value the
    // moment it's hidden mid-flight — the animation is a nicety, landing on
    // the real number is not optional.
    if (!numeric || prefersReducedMotion || document.hidden) {
      setDisplay(value);
      prevValue.current = value;
      return;
    }
    const start = prevValue.current;
    const startTime = performance.now();
    let raf;
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      setDisplay(value);
      prevValue.current = value;
    }
    function tick(now) {
      if (document.hidden) return finish();
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(start + (value - start) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else finish();
    }
    raf = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", finish);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", finish);
    };
     
  }, [value, duration, numeric]);

  return fmt(numeric ? Math.round(display) : display);
}
