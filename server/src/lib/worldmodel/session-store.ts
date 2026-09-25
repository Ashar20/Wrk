/**
 * Per-take state for live prediction.
 *
 * The GRU hidden state is what makes this a *sequence* model rather than one
 * that scores each frame in isolation — it has to survive between requests,
 * one per streamed frame, for the length of a take. There is no client
 * connection to hang it off (each request is a fresh HTTP call), so it lives
 * here, keyed by a session id the client mints when recording starts.
 *
 * The frame bank is what the nearest-neighbour decode in product-spec §8.2
 * needs: a set of frames the model has actually seen, to search for the one
 * closest to its own prediction. During a LIVE take that bank can only
 * contain frames from EARLIER in this same recording — the actual future
 * frame the model is trying to predict has not been captured yet. So a live
 * "predicted next frame" is honestly "of what I have already seen, this is
 * closest to where the motion says you're heading" — sometimes a frame from
 * seconds ago, if a contributor glances back to where they were. That is a
 * real and different claim from the offline version, which can search the
 * whole finished episode including genuinely later frames, and predict.ts
 * says so in what it returns rather than letting the UI imply otherwise.
 */

export interface BankEntry {
  /** Standardised latent — the space the model was trained and evaluated in. */
  latentStd: Float32Array;
  /** Small RGB thumbnail, already downsampled for cheap storage and transfer. */
  thumbnail: Uint8Array;
  thumbnailSize: number;
  capturedAtMs: number;
}

export interface LiveSession {
  hidden: Float32Array;
  bank: BankEntry[];
  lastTouchedMs: number;
}

/** Long enough to cover product-spec §3's 15s episode at a few Hz with room to spare. */
const MAX_BANK_ENTRIES = 80;
/** Sessions older than this are abandoned takes, not ones a client will resume. */
const SESSION_TTL_MS = 5 * 60_000;

const sessions = new Map<string, LiveSession>();
let lastSweep = 0;

function sweepStale(now: number): void {
  // Amortised rather than a timer: this runs on the request path already, and
  // a live-only feature does not need its own background interval.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;

  for (const [id, session] of sessions) {
    if (now - session.lastTouchedMs > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function getOrCreateSession(id: string, hiddenSize: number): LiveSession {
  const now = Date.now();
  sweepStale(now);

  let session = sessions.get(id);
  if (!session) {
    session = { hidden: new Float32Array(hiddenSize), bank: [], lastTouchedMs: now };
    sessions.set(id, session);
  }
  session.lastTouchedMs = now;
  return session;
}

export function pushBankEntry(session: LiveSession, entry: BankEntry): void {
  session.bank.push(entry);
  if (session.bank.length > MAX_BANK_ENTRIES) session.bank.shift();
}

export function endSession(id: string): void {
  sessions.delete(id);
}
