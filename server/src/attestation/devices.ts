import { createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceIdOf, isFullyAttested, verifyAttestation, type SecurityLevel } from "./android";

export interface DeviceRecord {
  id: string;
  /** The attested public key, SPKI DER, base64. */
  spki: string;
  level: SecurityLevel;
  boot_verified: boolean;
  app_verified: boolean;
  /** Hardware-backed key, verified boot, and a Wrk-signed app. Only these devices make "attested" takes. */
  fully_attested: boolean;
  registered_at: number;
  accepted: number;
  rejected: number;
  /** Every payment account that has submitted from this device. */
  accounts: string[];
  /** The one payment account this phone earns for. Set by its first take; moves only after the cooldown. */
  owner?: string;
  bound_at?: number;
  /** Takes accepted into the queue per UTC day. */
  days: Record<string, number>;
}

export class DeviceError extends Error {
  constructor(message: string, readonly status = 400, readonly failures: string[] = []) {
    super(message);
  }
}

export interface DevicesOptions {
  /** How long a phone stays linked to its payment account (and an account to its phone) before it may move. */
  rebindAfterMs?: number;
  packageName?: string;
  allowedAppCerts?: string[];
  /** Override Google's roots (tests). */
  roots?: string[];
  now?: () => number;
}

/** Takes per day for a payment account on a phone we can't vouch for. */
export const UNATTESTED_DAILY_CAP = 5;
const ATTESTED_MAX_CAP = 100;
/** Phones and accounts are linked one to one; a link can move after this long (a genuine phone upgrade). */
export const DEFAULT_REBIND_MS = 7 * 24 * 3600_000;

/** Where new accounts cluster: brand-new accounts this close together (km) are treated as one group. */
export const NEAR_KM = 1.5;
/** Up to this many new accounts in one small area are free (a household, a few friends). More share one allowance. */
export const FREE_NEARBY = 3;
/** An account is "new" until it has this many accepted takes, or this long has passed. Established accounts are never pooled. */
export const ESTABLISHED_ACCEPTED = 10;
export const NEW_ACCOUNT_WINDOW_MS = 14 * 24 * 3600_000;

export interface Place { lat: number; lon: number }

export interface SybilFactor { id: string; label: string; points: number; max: number; note?: string }

export interface SybilReport {
  /** 0 to 100. */
  score: number;
  tier: "new" | "building" | "trusted";
  factors: SybilFactor[];
  /** Takes allowed per day, and how many were used today. */
  cap: number;
  used: number;
  live_verified_until: number | null;
}

export function distanceKm(a: Place, b: Place) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** What the validator remembers about one payment account. The location is a ~1 km area, never a precise point. */
interface Person {
  first_seen: number;
  accepted: number;
  rejected: number;
  lat?: number;
  lon?: number;
  cell_at?: number;
  days: Record<string, number>;
  /** When this account last passed a standalone live check. */
  live_at?: number;
  /** Takes flagged as copies of another take. */
  duplicates?: number;
  /** Live checks (on takes or standalone) that failed or passed. */
  live_fail?: number;
  live_pass?: number;
  /** When this account's phone link changed hands. Frequent changes look like account-hopping. */
  changes?: number[];
  /** Standalone live-check attempts, for rate limiting. */
  live_tries?: number[];
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 5_000;

/** A deduction as a negative number, with no negative zero when there is nothing to take off. */
const off = (n: number) => (n === 0 ? 0 : -n);

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Which phones are real, and how much each may submit. Sybil resistance for a phone-based network is about phones:
 * accounts are free to make, a verified device is not. So limits attach to the device, and are shared by every
 * account used on it.
 */
export class Devices {
  private devices: Record<string, DeviceRecord> = {};
  /** Per-address takes per day, for submitters without a verified device. */
  private addressDays: Record<string, Record<string, number>> = {};
  /** Which verified phone each payment account earns on. */
  private accountDevice: Record<string, { device_id: string; bound_at: number }> = {};
  /** Every payment account that has earned, with its coarse area. Used to spot many new accounts in one place. */
  private people: Record<string, Person> = {};
  private challenges = new Map<string, number>();
  private readonly file: string;
  private readonly now: () => number;
  revoked: ReadonlySet<string> | undefined;

  constructor(dir: string, private readonly opts: DevicesOptions = {}) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "devices.json");
    this.now = opts.now ?? Date.now;
    if (existsSync(this.file)) {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      this.devices = j.devices ?? {};
      this.addressDays = j.addressDays ?? {};
      this.accountDevice = j.accountDevice ?? {};
      this.people = j.people ?? {};
    }
  }

  /** A fresh single-use challenge; the phone must create its key with exactly this. */
  challenge() {
    const now = this.now();
    for (const [c, exp] of this.challenges) if (exp < now) this.challenges.delete(c);
    while (this.challenges.size >= MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value!);
    const challenge = randomBytes(32).toString("base64");
    this.challenges.set(challenge, now + CHALLENGE_TTL_MS);
    return { challenge };
  }

  register(challengeB64: string, chainB64: string[]) {
    const exp = this.challenges.get(challengeB64);
    this.challenges.delete(challengeB64); // one try per challenge, right or wrong
    if (exp === undefined || exp < this.now()) throw new DeviceError("That request expired. Try again.");
    let chain: Buffer[];
    try { chain = chainB64.map((c) => Buffer.from(c, "base64")); } catch { throw new DeviceError("The attestation couldn't be read."); }

    const r = verifyAttestation(chain, {
      challenge: Buffer.from(challengeB64, "base64"),
      packageName: this.opts.packageName ?? "com.wrk.app",
      allowedAppCerts: this.opts.allowedAppCerts,
      roots: this.opts.roots,
      revoked: this.revoked,
    });
    if (!r.ok || !r.spki) throw new DeviceError("This phone couldn't be verified.", 400, r.failures);

    const id = deviceIdOf(r.spki);
    const prior = this.devices[id];
    this.devices[id] = {
      id, spki: r.spki.toString("base64"), level: r.level, boot_verified: r.bootVerified, app_verified: r.appVerified,
      fully_attested: isFullyAttested(r), registered_at: prior?.registered_at ?? Math.floor(this.now() / 1000),
      accepted: prior?.accepted ?? 0, rejected: prior?.rejected ?? 0, accounts: prior?.accounts ?? [], days: prior?.days ?? {},
    };
    this.flush();
    return { device: this.devices[id], appCertDigests: r.appCertDigests, appPackage: r.appPackage };
  }

  get(id: string | null | undefined) {
    return id ? this.devices[id] : undefined;
  }

  /** True when [signature] (DER ECDSA over [message]) was made by the device's attested key. */
  verifySignature(id: string, message: string, signatureB64: string) {
    const d = this.devices[id];
    if (!d) return false;
    try {
      const key = createPublicKey({ key: Buffer.from(d.spki, "base64"), format: "der", type: "spki" });
      return edVerify("sha256", Buffer.from(message, "utf8"), key, Buffer.from(signatureB64, "base64"));
    } catch {
      return false;
    }
  }

  /** The standalone live check stays valid this long. */
  static readonly LIVE_VALID_MS = 30 * 24 * 3600_000;

  /**
   * A transparent 0 to 100 trust score for a payment account, and the daily allowance that follows from it. Every point
   * comes from something observable, listed so a person can see what to do to raise it. A new account on a verified phone
   * starts at 40, which is still the small starting allowance: trust is earned, not given.
   */
  report(address: string): SybilReport {
    const now = this.now();
    const p = this.people[address];
    const link = this.accountDevice[address];
    const d = link ? this.devices[link.device_id] : undefined;
    const pooled = this.cluster(address, undefined).length + 1 > FREE_NEARBY;
    const liveUntil = p?.live_at ? p.live_at + Devices.LIVE_VALID_MS : null;
    const liveOk = liveUntil !== null && liveUntil > now;
    const ageDays = p ? (now - p.first_seen) / 86_400_000 : 0;
    const recentChanges = (p?.changes ?? []).filter((t) => now - t < 30 * 86_400_000).length;

    const f = (id: string, label: string, points: number, max: number, note?: string): SybilFactor => ({ id, label, points, max, note });
    const factors: SybilFactor[] = [
      f("phone", "Verified phone", d?.fully_attested ? 20 : 0, 20, d?.fully_attested ? undefined : "Open Wrk on a phone that can be verified"),
      f("live", "Live check passed", liveOk ? 15 : 0, 15, liveOk ? undefined : "Take the quick live check"),
      f("record", "Accepted takes", Math.min(30, (p?.accepted ?? 0) * 3), 30, "3 points for each, up to 10 takes"),
      f("age", "Time on Wrk", Math.min(15, Math.floor(ageDays)), 15, "1 point for each day, up to 15"),
      f("place", "Not one of many new accounts in one spot", p && !pooled ? 10 : 0, 10, pooled ? "Several new accounts share this area" : undefined),
      f("stable", "Steady sign-in", p && recentChanges === 0 ? 10 : 0, 10, recentChanges ? "You switched phones or accounts recently" : undefined),
      f("refused", "Refused takes", off(Math.min(30, (p?.rejected ?? 0) * 4)), 0),
      f("duplicates", "Copied takes", off(Math.min(40, (p?.duplicates ?? 0) * 20)), 0),
      f("live_fail", "Failed live checks", off(Math.min(30, (p?.live_fail ?? 0) * 10)), 0),
    ];
    const score = Math.max(0, Math.min(100, factors.reduce((n, x) => n + x.points, 0)));
    // The first 40 points are what a clean new account on a verified phone starts with; allowance grows from there.
    const cap = pooled || !d?.fully_attested
      ? UNATTESTED_DAILY_CAP
      : Math.max(UNATTESTED_DAILY_CAP, Math.min(ATTESTED_MAX_CAP, UNATTESTED_DAILY_CAP + Math.round(Math.max(0, score - 40) * 1.58)));
    const day = dayOf(now);
    return {
      score, tier: score < 50 ? "new" : score < 75 ? "building" : "trusted", factors, cap,
      used: d?.fully_attested ? d.days[day] ?? 0 : p?.days[day] ?? 0,
      live_verified_until: liveOk ? liveUntil : null,
    };
  }

  /** Records what happened to one of this account's takes that bears on trust. */
  signal(address: string, kind: "duplicate" | "live_pass" | "live_fail") {
    const p = (this.people[address] ??= { first_seen: this.now(), accepted: 0, rejected: 0, days: {} });
    if (kind === "duplicate") p.duplicates = (p.duplicates ?? 0) + 1;
    else if (kind === "live_pass") p.live_pass = (p.live_pass ?? 0) + 1;
    else p.live_fail = (p.live_fail ?? 0) + 1;
    this.flush();
  }

  /** A standalone live check finished. A pass keeps the account "verified live" for 30 days; a fail counts against it. */
  liveChecked(address: string, passed: boolean) {
    const p = (this.people[address] ??= { first_seen: this.now(), accepted: 0, rejected: 0, days: {} });
    if (passed) { p.live_at = this.now(); p.live_pass = (p.live_pass ?? 0) + 1; }
    else p.live_fail = (p.live_fail ?? 0) + 1;
    this.flush();
  }

  /** Five standalone live checks per account per hour. Returns false when over the limit, and counts the attempt when not. */
  allowLiveTry(address: string) {
    const p = (this.people[address] ??= { first_seen: this.now(), accepted: 0, rejected: 0, days: {} });
    const recent = (p.live_tries ?? []).filter((t) => this.now() - t < 3_600_000);
    if (recent.length >= 5) { p.live_tries = recent; return false; }
    p.live_tries = [...recent, this.now()];
    this.flush();
    return true;
  }

  private isNew(p: Person | undefined) {
    return !p || (p.accepted < ESTABLISHED_ACCEPTED && this.now() - p.first_seen < NEW_ACCOUNT_WINDOW_MS);
  }

  /**
   * Brand-new accounts clustered in one small area. Many phones and wallets in one spot is how a farm looks, and one
   * person's gain from adding another is nothing if they all share one allowance. Established accounts are never pooled,
   * so real neighbours aren't punished for living near each other.
   */
  private cluster(address: string, at: Place | undefined) {
    const me = this.people[address];
    const here = at ?? (me?.lat !== undefined ? { lat: me.lat, lon: me.lon! } : undefined);
    if (!here || !this.isNew(me)) return [];
    const recent = this.now() - NEW_ACCOUNT_WINDOW_MS;
    return Object.entries(this.people)
      .filter(([a, p]) => a !== address && this.isNew(p) && p.lat !== undefined && (p.cell_at ?? 0) > recent && distanceKm(here, { lat: p.lat, lon: p.lon! }) <= NEAR_KM)
      .map(([a]) => a);
  }

  /** How many takes may this submitter still send today? [at] is where this take was made, as a coarse area. */
  allowance(deviceId: string | null | undefined, address: string, at?: Place) {
    const day = dayOf(this.now());
    const neighbours = this.cluster(address, at);
    if (neighbours.length + 1 > FREE_NEARBY) {
      const used = [address, ...neighbours].reduce((n, a) => n + (this.people[a]?.days[day] ?? 0), 0);
      return { cap: UNATTESTED_DAILY_CAP, used, pooled: true };
    }
    const d = this.get(deviceId);
    if (d?.fully_attested) {
      // The allowance follows the account's trust score. A new person on a verified phone has no record yet, so is scored as
      // new rather than as nobody.
      const r = address && this.people[address] ? this.report(address) : null;
      const cap = r ? r.cap : UNATTESTED_DAILY_CAP;
      return { cap, used: d.days[day] ?? 0, pooled: false };
    }
    return { cap: UNATTESTED_DAILY_CAP, used: this.addressDays[address]?.[day] ?? 0, pooled: false };
  }

  /**
   * Phones and payment accounts are linked one to one. Without this, one person could multiply their allowance with a few
   * accounts on one phone, or one account across a few phones. The link is made by a phone's first take and can move only
   * after the cooldown, which is long enough to stop spam and short enough for a real phone upgrade.
   */
  linkCheck(deviceId: string | null | undefined, address: string): { ok: true } | { ok: false; reason: string } {
    const d = this.get(deviceId);
    if (!d?.fully_attested) return { ok: true }; // unverified submitters have no link (and can be refused outright elsewhere)
    const now = this.now();
    const wait = this.opts.rebindAfterMs ?? DEFAULT_REBIND_MS;
    const movable = (at?: number) => at !== undefined && now - at >= wait;

    if (d.owner && d.owner !== address && !movable(d.bound_at)) {
      return { ok: false, reason: "This phone is already linked to another payment account." };
    }
    const link = this.accountDevice[address];
    if (link && link.device_id !== d.id && !movable(link.bound_at)) {
      const until = new Date(link.bound_at + wait).toISOString().slice(0, 10);
      return { ok: false, reason: `This payment account is linked to another phone. It can move to a new phone after ${until}.` };
    }
    return { ok: true };
  }

  /** Counts a take that was let in, and makes (or keeps) the phone-account link. */
  note(deviceId: string | null | undefined, address: string, at?: Place) {
    const day = dayOf(this.now());
    const person = (this.people[address] ??= { first_seen: this.now(), accepted: 0, rejected: 0, days: {} });
    person.days[day] = (person.days[day] ?? 0) + 1;
    if (at) { person.lat = at.lat; person.lon = at.lon; person.cell_at = this.now(); }
    for (const k of Object.keys(person.days)) if (k < day) delete person.days[k];
    const d = this.get(deviceId);
    if (d?.fully_attested) {
      d.days[day] = (d.days[day] ?? 0) + 1;
      if (!d.accounts.includes(address)) d.accounts.push(address);
      this.link(d, address);
      for (const k of Object.keys(d.days)) if (k < day && Object.keys(d.days).length > 14) delete d.days[k];
    } else {
      const m = (this.addressDays[address] ??= {});
      m[day] = (m[day] ?? 0) + 1;
      for (const k of Object.keys(m)) if (k < day) delete m[k];
    }
    this.flush();
  }

  private link(d: DeviceRecord, address: string) {
    if (d.owner === address) return;
        // The old owner of this phone and the old phone of this account are released: links stay one to one.
        const prior = this.accountDevice[address];
        // A change of hands (not the very first link) is remembered: frequent ones look like account-hopping.
        if (d.owner || prior) {
          for (const a of [address, d.owner].filter((x): x is string => !!x)) {
            const person = this.people[a];
            if (person) person.changes = [...(person.changes ?? []), this.now()];
          }
        }
        if (prior && prior.device_id !== d.id && this.devices[prior.device_id]?.owner === address) delete this.devices[prior.device_id].owner;
        if (d.owner && this.accountDevice[d.owner]?.device_id === d.id) delete this.accountDevice[d.owner];
        d.owner = address; d.bound_at = this.now();
        this.accountDevice[address] = { device_id: d.id, bound_at: d.bound_at };
  }

  /** Links a verified phone and an account without counting a take (used by the standalone live check). */
  noteLink(deviceId: string | null | undefined, address: string) {
    const d = this.get(deviceId);
    if (!d?.fully_attested || d.owner === address) return;
    this.people[address] ??= { first_seen: this.now(), accepted: 0, rejected: 0, days: {} };
    this.link(d, address);
    this.flush();
  }

  /** A take from this device was accepted or refused: its standing grows or doesn't. */
  decided(deviceId: string | null | undefined, accepted: boolean, address?: string | null) {
    const person = address ? this.people[address] : undefined;
    if (person) { if (accepted) person.accepted++; else person.rejected++; }
    const d = this.get(deviceId);
    if (!d) { if (person) this.flush(); return; }
    if (accepted) d.accepted++; else d.rejected++;
    this.flush();
  }

  private flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices: this.devices, addressDays: this.addressDays, accountDevice: this.accountDevice, people: this.people }));
    renameSync(tmp, this.file);
  }
}
