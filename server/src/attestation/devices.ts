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
  /** Every payment account that has submitted from this device. Many accounts on one phone is the farming signal. */
  accounts: string[];
  /** Takes accepted into the queue per UTC day. */
  days: Record<string, number>;
}

export class DeviceError extends Error {
  constructor(message: string, readonly status = 400, readonly failures: string[] = []) {
    super(message);
  }
}

export interface DevicesOptions {
  packageName?: string;
  allowedAppCerts?: string[];
  /** Override Google's roots (tests). */
  roots?: string[];
  now?: () => number;
}

/** Takes per day for a payment account on a phone we can't vouch for. */
export const UNATTESTED_DAILY_CAP = 5;
/** A verified phone starts here and earns more as its takes get accepted. */
const ATTESTED_BASE_CAP = 20;
const ATTESTED_MAX_CAP = 100;
/** More accounts than this on one phone is treated as farming. */
export const MAX_ACCOUNTS_PER_DEVICE = 3;

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

  /** How many takes may this submitter still send today? */
  allowance(deviceId: string | null | undefined, address: string) {
    const day = dayOf(this.now());
    const d = this.get(deviceId);
    if (d?.fully_attested) {
      const farming = new Set([...d.accounts, address]).size > MAX_ACCOUNTS_PER_DEVICE;
      // Standing: accepted takes earn room, refused ones cost more than an accepted one earns, and it never drops below the
      // unverified allowance (a verified phone with a bad run is still better than nothing) or above the ceiling.
      const earned = ATTESTED_BASE_CAP + d.accepted * 2 - d.rejected * 3;
      const cap = farming ? UNATTESTED_DAILY_CAP : Math.max(UNATTESTED_DAILY_CAP, Math.min(ATTESTED_MAX_CAP, earned));
      return { cap, used: d.days[day] ?? 0, farming };
    }
    return { cap: UNATTESTED_DAILY_CAP, used: this.addressDays[address]?.[day] ?? 0, farming: false };
  }

  /** Counts a take that was let in. */
  note(deviceId: string | null | undefined, address: string) {
    const day = dayOf(this.now());
    const d = this.get(deviceId);
    if (d?.fully_attested) {
      d.days[day] = (d.days[day] ?? 0) + 1;
      if (!d.accounts.includes(address)) d.accounts.push(address);
      for (const k of Object.keys(d.days)) if (k < day && Object.keys(d.days).length > 14) delete d.days[k];
    } else {
      const m = (this.addressDays[address] ??= {});
      m[day] = (m[day] ?? 0) + 1;
      for (const k of Object.keys(m)) if (k < day) delete m[k];
    }
    this.flush();
  }

  /** A take from this device was accepted or refused: its standing grows or doesn't. */
  decided(deviceId: string | null | undefined, accepted: boolean) {
    const d = this.get(deviceId);
    if (!d) return;
    if (accepted) d.accepted++; else d.rejected++;
    this.flush();
  }

  private flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices: this.devices, addressDays: this.addressDays }));
    renameSync(tmp, this.file);
  }
}
