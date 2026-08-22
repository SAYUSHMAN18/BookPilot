// A small hand-drawn stroke-icon set replacing the sidebar/quick-link
// emoji. Emoji render inconsistently across OS/fonts and read as a
// placeholder rather than a designed product — one consistent 20x20
// stroke language (round caps/joins, 1.8 weight) reads as considered
// instead. currentColor throughout so each usage site controls color via
// its own text color, same pattern the rest of this design system uses.
const base = { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };

export function IconGrid(props) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
    </svg>
  );
}

export function IconCalendar(props) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="4" width="15" height="13.5" rx="2" />
      <path d="M2.5 8h15" />
      <path d="M6.5 2.5v3M13.5 2.5v3" />
      <path d="M6.5 11.5h2M11.5 11.5h2M6.5 14.5h2M11.5 14.5h2" />
    </svg>
  );
}

export function IconClock(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 5.5V10l3 2" />
    </svg>
  );
}

export function IconUsers(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="7.5" cy="7" r="3" />
      <path d="M2 17c.5-3.2 2.6-5 5.5-5s5 1.8 5.5 5" />
      <circle cx="14.5" cy="6.5" r="2.4" />
      <path d="M13 9.7c2.3.3 3.7 1.9 4 4.8" />
    </svg>
  );
}

export function IconBuilding(props) {
  return (
    <svg {...base} {...props}>
      <rect x="4" y="2.5" width="9" height="15" rx="1" />
      <path d="M13 8.5h3v9h-3" />
      <path d="M6.5 6h1.2M10.3 6h1.2M6.5 9h1.2M10.3 9h1.2M6.5 12h1.2M10.3 12h1.2" />
      <path d="M7.5 17.5v-3h2v3" />
    </svg>
  );
}

export function IconTrendUp(props) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 14.5l5-5 3 3 6.5-6.5" />
      <path d="M13.5 5.5h3.5V9" />
    </svg>
  );
}

export function IconMessage(props) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 5.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8l-4 3v-3H4.5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function IconCard(props) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
      <path d="M2.5 8h15" />
      <path d="M5.5 12h4" />
    </svg>
  );
}

export function IconSliders(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3 5.5h8M14.5 5.5H17" />
      <circle cx="11.5" cy="5.5" r="2" />
      <path d="M3 10h3.5M9.5 10H17" />
      <circle cx="7.5" cy="10" r="2" />
      <path d="M3 14.5h8M14.5 14.5H17" />
      <circle cx="11.5" cy="14.5" r="2" />
    </svg>
  );
}

export function IconLogout(props) {
  return (
    <svg {...base} {...props}>
      <path d="M8 17.5H4.5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2H8" />
      <path d="M13 14l4-4-4-4" />
      <path d="M17 10H7.5" />
    </svg>
  );
}

export function IconBell(props) {
  return (
    <svg {...base} {...props}>
      <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 1.5 5.5h-13S5 12 5 8z" />
      <path d="M8.2 16.5a1.9 1.9 0 0 0 3.6 0" />
    </svg>
  );
}

export function IconCheckCircle(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M6.8 10.2l2.1 2.1 4.3-4.6" />
    </svg>
  );
}

export function IconXCircle(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.3 7.3l5.4 5.4M12.7 7.3l-5.4 5.4" />
    </svg>
  );
}

// Brand mark — a paper plane redrawn as a stroke icon instead of the
// ✈️ emoji, so it sits crisply on the gradient chip at any size/DPI.
export function IconPlane(props) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M17.5 2.5L2.5 9.2l6 2.3 2.3 6L17.5 2.5z" fill="currentColor" fillOpacity="0.18" />
      <path d="M17.5 2.5L2.5 9.2l6 2.3 2.3 6L17.5 2.5z" />
      <path d="M8.5 11.5L17.5 2.5" />
    </svg>
  );
}

// Mobile sidebar drawer toggle (DashboardLayout.jsx) — the sidebar itself
// has no equivalent on mobile until this, so these two didn't exist before.
export function IconMenu(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
    </svg>
  );
}

export function IconX(props) {
  return (
    <svg {...base} {...props}>
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}
