import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import type { Mailer } from "./mailer";

interface UserRow {
  address: string;
  /** AES-256-GCM(secret key): iv | tag | ciphertext, base64. */
  secret: string;
  created_at: number;
}

interface Pending {
  codeHash: Buffer;
  expiresAt: number;
  attempts: number;
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 5;

const sha = (s: string) => createHash("sha256").update(s).digest();
export const normalizeEmail = (e: string) => e.trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Email-code sign-in with a Wrk-held payment account per user.
 *
 * The custodial key lets people who have never touched crypto earn without a
 * wallet app; it is encrypted at rest and only ever used server-side to anchor
 * their episodes and receive payouts. Users with their own wallet skip all of
 * this and connect through Mobile Wallet Adapter instead.
 */
export class Accounts {
  private users: Record<string, UserRow> = {};
  private sessions: Record<string, string> = {}; // sha256(token) hex -> email
  private pending = new Map<string, Pending>();
  private sends = new Map<string, number[]>();
  private readonly file: string;
  private readonly key: Buffer;

  constructor(dir: string, private readonly mailer: Mailer, opts: { key?: Buffer; now?: () => number } = {}) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "accounts.json");
    this.now = opts.now ?? Date.now;
    const keyFile = join(dir, "account.key");
    if (opts.key) this.key = opts.key;
    else if (process.env.WRK_ACCOUNT_KEY) this.key = Buffer.from(process.env.WRK_ACCOUNT_KEY, "hex");
    else if (existsSync(keyFile)) this.key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
    else {
      this.key = randomBytes(32);
      writeFileSync(keyFile, this.key.toString("hex"), { mode: 0o600 });
    }
    if (this.key.length !== 32) throw new Error("Account key must be 32 bytes (64 hex chars).");
    if (existsSync(this.file)) {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      this.users = j.users ?? {};
      this.sessions = j.sessions ?? {};
    }
  }

  private readonly now: () => number;

  async start(emailRaw: string) {
    const email = normalizeEmail(emailRaw);
    if (!EMAIL.test(email)) throw new AuthError("Enter a valid email address.");
    const recent = (this.sends.get(email) ?? []).filter((t) => this.now() - t < 3_600_000);
    if (recent.length >= MAX_SENDS_PER_HOUR) throw new AuthError("Too many codes requested. Try again later.", 429);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending.set(email, { codeHash: sha(code), expiresAt: this.now() + CODE_TTL_MS, attempts: 0 });
    this.sends.set(email, [...recent, this.now()]);
    await this.mailer.sendCode(email, code);
  }

  verify(emailRaw: string, code: string) {
    const email = normalizeEmail(emailRaw);
    const p = this.pending.get(email);
    if (!p || p.expiresAt < this.now()) throw new AuthError("That code has expired. Ask for a new one.");
    if (p.attempts >= MAX_ATTEMPTS) {
      this.pending.delete(email);
      throw new AuthError("Too many attempts. Ask for a new code.", 429);
    }
    p.attempts++;
    if (!timingSafeEqual(sha(code.trim()), p.codeHash)) throw new AuthError("That code is not right.");
    this.pending.delete(email);

    let user = this.users[email];
    if (!user) {
      const kp = Keypair.generate();
      user = { address: kp.publicKey.toBase58(), secret: this.seal(kp.secretKey), created_at: Math.floor(this.now() / 1000) };
      this.users[email] = user;
    }
    const token = randomBytes(32).toString("base64url");
    this.sessions[sha(token).toString("hex")] = email;
    this.flush();
    return { token, email, address: user.address };
  }

  session(token: string | null | undefined) {
    if (!token) return null;
    const email = this.sessions[sha(token).toString("hex")];
    const user = email ? this.users[email] : undefined;
    return user ? { email, address: user.address } : null;
  }

  signOut(token: string) {
    delete this.sessions[sha(token).toString("hex")];
    this.flush();
  }

  /** The account's secret key, for server-side anchoring only. */
  secretFor(email: string): Uint8Array | null {
    const row = this.users[email];
    return row ? this.open(row.secret) : null;
  }

  private seal(plain: Uint8Array) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }

  private open(b64: string) {
    const raw = Buffer.from(b64, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return new Uint8Array(Buffer.concat([d.update(raw.subarray(28)), d.final()]));
  }

  private flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ users: this.users, sessions: this.sessions }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
