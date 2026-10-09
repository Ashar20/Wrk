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
/** A new verified phone starts small and earns room only through accepted takes. */
const ATTESTED_BASE_CAP = 5;
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
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 5_000;

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
      // Standing: accepted takes earn room, refused ones cost more than an accepted one earns, and it never drops below the
      // unverified allowance (a verified phone with a bad run is still better than nothing) or above the ceiling.
      const earned = ATTESTED_BASE_CAP + d.accepted * 2 - d.rejected * 3;
      const cap = Math.max(UNATTESTED_DAILY_CAP, Math.min(ATTESTED_MAX_CAP, earned));
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
      if (d.owner !== address) {
        // The old owner of this phone and the old phone of this account are released: links stay one to one.
        const prior = this.accountDevice[address];
        if (prior && prior.device_id !== d.id && this.devices[prior.device_id]?.owner === address) delete this.devices[prior.device_id].owner;
        if (d.owner && this.accountDevice[d.owner]?.device_id === d.id) delete this.accountDevice[d.owner];
        d.owner = address; d.bound_at = this.now();
        this.accountDevice[address] = { device_id: d.id, bound_at: d.bound_at };
      }
      for (const k of Object.keys(d.days)) if (k < day && Object.keys(d.days).length > 14) delete d.days[k];
    } else {
      const m = (this.addressDays[address] ??= {});
      m[day] = (m[day] ?? 0) + 1;
      for (const k of Object.keys(m)) if (k < day) delete m[k];
    }
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
