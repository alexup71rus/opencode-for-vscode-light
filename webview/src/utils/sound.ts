// Lightweight synthesized "completion" cue via the Web Audio API — no asset
// needed. A soft ascending two-note chime signals an agent turn finished.
// Audio is unlocked on the first user gesture to satisfy autoplay policies.

let ctx: AudioContext | null = null;
let unlockBound = false;

function ensureCtx(): AudioContext | null {
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

function unlock(): void {
  const c = ensureCtx();
  if (c && c.state === "suspended") void c.resume();
  if (unlockBound) {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    unlockBound = false;
  }
}

function bindUnlock(): void {
  if (unlockBound || typeof window === "undefined") return;
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  unlockBound = true;
}

export function playCompleteSound(): void {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  try {
    const now = c.currentTime;
    const notes = [{ f: 660, t: 0 }, { f: 988, t: 0.085 }];
    for (const n of notes) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = n.f;
      const start = now + n.t;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    }
  } catch {
    // ignore audio errors
  }
}

// A brighter, more insistent cue for "needs your input" — a question or an
// approval request that is blocking the agent. Triangle timbre + a repeated
// higher pulse distinguishes it from the soft sine completion chime.
export function playAttentionSound(): void {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  try {
    const now = c.currentTime;
    const notes = [{ f: 988, t: 0 }, { f: 1319, t: 0.11 }];
    for (const n of notes) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "triangle";
      osc.frequency.value = n.f;
      const start = now + n.t;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.1, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    }
  } catch {
    // ignore audio errors
  }
}

// Bind the gesture unlock as soon as this module loads in a window.
if (typeof window !== "undefined") bindUnlock();
