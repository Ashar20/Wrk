import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Devices, UNATTESTED_DAILY_CAP } from "../src/attestation/devices";

const DAY = 86_400_000;

describe("trust score", () => {
  let clock: number; let d: Devices;
  const make = () => new Devices(mkdtempSync(join(tmpdir(), "wrk-s-")), { roots: [], now: () => clock });
  const phone = (id: string, attested = true) => { (d as any).devices[id] = { id, fully_attested: attested, accepted: 0, rejected: 0, accounts: [], days: {}, level: "tee", boot_verified: attested, app_verified: attested, spki: "", registered_at: 0 }; return id; };
  /** An account on a verified phone that has made its first take. */
  const earner = (addr: string, id = "p-" + addr) => { phone(id); d.note(id, addr); return addr; };
  const pts = (addr: string, id: string) => d.report(addr).factors.find((f) => f.id === id)!.points;

  beforeEach(() => { clock = Date.now(); d = make(); });

  it("starts a clean new account on a verified phone at 40, with the smallest allowance", () => {
    earner("a");
    const r = d.report("a");
    expect(r).toMatchObject({ score: 40, tier: "new", cap: UNATTESTED_DAILY_CAP });
    expect(r.factors.map((f) => [f.id, f.points])).toEqual([["phone", 20], ["live", 0], ["record", 0], ["age", 0], ["place", 10], ["stable", 10], ["refused", 0], ["duplicates", 0], ["live_fail", 0]]);
  });

  it("explains each missing point so a person knows what to do", () => {
    earner("a");
    const notes = Object.fromEntries(d.report("a").factors.map((f) => [f.id, f.note]));
    expect(notes.live).toMatch(/live check/i);
    expect(notes.record).toMatch(/3 points for each/);
  });

  it("gives nothing for a phone that can't be verified", () => {
    phone("w", false); d.note("w", "a");
    const r = d.report("a");
    expect(pts("a", "phone")).toBe(0);
    expect(r.cap).toBe(UNATTESTED_DAILY_CAP);
  });

  it("grows with accepted takes, three points each, up to ten", () => {
    earner("a");
    for (let i = 0; i < 4; i++) d.decided("p-a", true, "a");
    expect(pts("a", "record")).toBe(12);
    for (let i = 0; i < 20; i++) d.decided("p-a", true, "a");
    expect(pts("a", "record")).toBe(30); // capped
  });

  it("grows with time on Wrk, a point a day up to fifteen", () => {
    earner("a");
    clock += 5 * DAY; expect(pts("a", "age")).toBe(5);
    clock += 60 * DAY; expect(pts("a", "age")).toBe(15);
  });

  it("rewards a live check for thirty days, then asks again", () => {
    earner("a");
    d.liveChecked("a", true);
    expect(pts("a", "live")).toBe(15);
    expect(d.report("a").live_verified_until).toBe(clock + 30 * DAY);
    clock += 29 * DAY; expect(pts("a", "live")).toBe(15);
    clock += 2 * DAY; expect(pts("a", "live")).toBe(0);
    expect(d.report("a").live_verified_until).toBeNull();
  });

  it("takes points off for refused takes, copies and failed live checks, each with a limit", () => {
    earner("a");
    for (let i = 0; i < 3; i++) d.decided("p-a", false, "a");
    expect(pts("a", "refused")).toBe(-12);
    for (let i = 0; i < 20; i++) d.decided("p-a", false, "a");
    expect(pts("a", "refused")).toBe(-30);
    d.signal("a", "duplicate"); expect(pts("a", "duplicates")).toBe(-20);
    d.signal("a", "duplicate"); d.signal("a", "duplicate"); expect(pts("a", "duplicates")).toBe(-40);
    d.signal("a", "live_fail"); expect(pts("a", "live_fail")).toBe(-10);
    for (let i = 0; i < 9; i++) d.signal("a", "live_fail"); expect(pts("a", "live_fail")).toBe(-30);
  });

  it("never goes below 0 or above 100", () => {
    earner("a");
    for (let i = 0; i < 50; i++) { d.decided("p-a", false, "a"); d.signal("a", "duplicate"); d.signal("a", "live_fail"); }
    expect(d.report("a").score).toBe(0);
    earner("b");
    for (let i = 0; i < 20; i++) d.decided("p-b", true, "b");
    d.liveChecked("b", true); clock += 20 * DAY;
    d.note("p-b", "b"); // keep the record fresh
    expect(d.report("b").score).toBe(Math.min(100, d.report("b").factors.reduce((n, f) => n + f.points, 0)));
    expect(d.report("b").score).toBeLessThanOrEqual(100);
  });

  it("ties the allowance to the score: nothing extra until 40, then a steady climb to 100", () => {
    earner("a");
    expect(d.report("a").cap).toBe(5);                       // 40
    for (let i = 0; i < 10; i++) d.decided("p-a", true, "a"); // +30 = 70
    expect(d.report("a").cap).toBe(5 + Math.round(30 * 1.58));
    d.liveChecked("a", true); clock += 15 * DAY; d.note("p-a", "a"); // 70 + 15 live + 15 age = 100
    const r = d.report("a");
    expect(r.score).toBe(100); expect(r.tier).toBe("trusted"); expect(r.cap).toBe(100);
  });

  it("never lowers a score for doing well", () => {
    earner("a");
    let last = d.report("a").score;
    for (let i = 0; i < 15; i++) { d.decided("p-a", true, "a"); const s = d.report("a").score; expect(s).toBeGreaterThanOrEqual(last); last = s; }
  });

  it("loses the steady-sign-in points after switching phones, and regains them after a month", () => {
    const a = earner("a", "old");
    phone("new"); clock += 8 * DAY; // past the cooldown
    expect(d.linkCheck("new", "a").ok).toBe(true);
    d.note("new", "a");
    expect(pts("a", "stable")).toBe(0);
    clock += 31 * DAY;
    expect(pts("a", "stable")).toBe(10);
    expect(a).toBe("a");
  });

  it("doesn't count the very first link as a change", () => {
    earner("a"); expect(pts("a", "stable")).toBe(10);
  });

  it("loses the place points when brand-new accounts crowd one spot, and is held to the small allowance", () => {
    for (const a of ["a", "b", "c", "d"]) { phone("p-" + a); d.note("p-" + a, a, { lat: 51.5, lon: -0.12 }); }
    expect(pts("a", "place")).toBe(0);
    expect(d.report("a").cap).toBe(UNATTESTED_DAILY_CAP);
    clock += 15 * DAY; // they stop being new
    expect(pts("a", "place")).toBe(10);
  });

  it("limits standalone live checks to five an hour", () => {
    for (let i = 0; i < 5; i++) expect(d.allowLiveTry("a")).toBe(true);
    expect(d.allowLiveTry("a")).toBe(false);
    clock += 61 * 60_000;
    expect(d.allowLiveTry("a")).toBe(true);
  });

  it("remembers scores across restarts", () => {
    earner("a"); d.decided("p-a", true, "a"); d.liveChecked("a", true);
    const again = new Devices((d as any).file.replace(/\/devices\.json$/, ""), { roots: [], now: () => clock });
    expect(again.report("a").score).toBe(d.report("a").score);
  });
});
