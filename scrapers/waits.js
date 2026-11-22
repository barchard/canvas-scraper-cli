/**
 * Tracks what the scraper is waiting on, so the UI can show a running timer
 * instead of looking frozen.
 *
 * - Known waits (opening a tab, loading a page, waiting for a site) are
 *   registered with track()/begin() along with their time limit.
 * - Anything else shows up as "no new output for …": every log line and
 *   progress event calls noteActivity().
 */

// Show nothing for short pauses; they're normal.
export const SHOW_WAIT_AFTER_MS = 5000;
export const SHOW_IDLE_AFTER_MS = 15000;

const waits = {
  active: new Map(),
  nextId: 1,
  lastActivityAt: Date.now(),
  lastLine: "",
  // Limit shown for waits we don't know about (the Chrome request timeout).
  idleLimitMs: 0,

  /** Starts a known wait. Returns an id for end(). */
  begin(label, limitMs = 0, now = Date.now()) {
    const id = this.nextId++;
    this.active.set(id, { label, limitMs, startedAt: now });
    return id;
  },

  /** Ends a known wait (and counts as activity). */
  end(id, now = Date.now()) {
    if (this.active.delete(id)) this.lastActivityAt = now;
  },

  /** Runs `fn` as a known wait. */
  async track(label, limitMs, fn) {
    const id = this.begin(label, limitMs);
    try {
      return await fn();
    } finally {
      this.end(id);
    }
  },

  /** Something visible happened (a log line, a progress update). */
  noteActivity(line, now = Date.now()) {
    this.lastActivityAt = now;
    if (line) this.lastLine = line;
  },

  /** Forget everything (start of a run). */
  reset(now = Date.now()) {
    this.active.clear();
    this.lastActivityAt = now;
    this.lastLine = "";
  },

  /**
   * The wait worth showing right now, or null.
   * @returns {null | {kind: "wait"|"idle", label: string, elapsedMs: number, limitMs: number}}
   */
  describe(now = Date.now()) {
    // The most recently started known wait is the innermost one.
    let latest = null;
    for (const w of this.active.values()) if (!latest || w.startedAt >= latest.startedAt) latest = w;
    if (latest) {
      const elapsedMs = now - latest.startedAt;
      if (elapsedMs >= SHOW_WAIT_AFTER_MS) {
        return { kind: "wait", label: latest.label, elapsedMs, limitMs: latest.limitMs };
      }
      return null;
    }
    const idleMs = now - this.lastActivityAt;
    if (idleMs >= SHOW_IDLE_AFTER_MS) {
      return { kind: "idle", label: this.lastLine, elapsedMs: idleMs, limitMs: this.idleLimitMs };
    }
    return null;
  },
};

/** 75000 -> "1:15", 3723000 -> "1:02:03". */
export function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * One line for the UI, e.g
 *   "⏳ Waiting for www.example.com to load — 0:12 (gives up at 0:30)"
 *   "⏳ No new output for 1:05 (stuck Chrome requests give up at 5:00) — last: …"
 */
export function formatWait(w) {
  if (!w) return "";
  const limit = w.limitMs ? ` (gives up at ${fmtClock(w.limitMs)})` : "";
  if (w.kind === "wait") return `⏳ Waiting for ${w.label} — ${fmtClock(w.elapsedMs)}${limit}`;
  const idleLimit = w.limitMs ? ` (stuck Chrome requests give up at ${fmtClock(w.limitMs)})` : "";
  const last = w.label ? ` — last: ${w.label}` : "";
  return `⏳ No new output for ${fmtClock(w.elapsedMs)}${idleLimit}${last}`;
}

export default waits;
