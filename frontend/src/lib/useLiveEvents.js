import { useEffect, useRef, useState } from "react";

// Section 13 — thin React wrapper around the same GET /api/dashboard/events
// SSE stream Section 11 built; `onEvent` fires for every booking.created /
// booking.updated / support_request.created / feedback.created message so
// callers can re-fetch just the panel that changed, same pattern as the
// vanilla dashboard's own EventSource wiring.
export function useLiveEvents(onEvent) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const source = new EventSource("/api/dashboard/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false); // EventSource retries on its own
    const types = ["booking.created", "booking.updated", "support_request.created", "feedback.created"];
    const listener = (evt) => handlerRef.current?.(evt.type, JSON.parse(evt.data));
    types.forEach((t) => source.addEventListener(t, listener));
    return () => source.close();
  }, []);

  return connected;
}
