import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { EpisodeAnchor, EpisodePayment } from "@/lib/market/types";
import type { ValidationResult } from "@/lib/validator/validate";

export type EpisodeStatus = "scoring" | "scored" | "failed";

export interface EpisodeRecord {
  episode_id: string;
  bounty_id: string;
  contributor: string | null;
  manifest_hash: string;
  duration_s: number;
  recorded_at: number;
  status: EpisodeStatus;
  accepted: boolean;
  reasons: string[];
  plausibility: number | null;
  /** Share of frames with hands where the task needs them, 0–1. Null when hands were never analysed. */
  framing?: number | null;
  hands_visible_percent?: number | null;
  signature: string[];
  validation?: ValidationResult;
  scoring_error?: string | null;
  anchor?: EpisodeAnchor;
  payment?: EpisodePayment;
  received_at: number;
}

/** JSON-file store. Small on purpose: this is a demo-scale validator, not a database. */
export class Store {
  private episodes = new Map<string, EpisodeRecord>();
  private readonly file: string;

  constructor(readonly dir: string) {
    mkdirSync(join(dir, "blobs"), { recursive: true });
    this.file = join(dir, "episodes.json");
    if (existsSync(this.file)) {
      for (const e of JSON.parse(readFileSync(this.file, "utf8")) as EpisodeRecord[]) {
        // A restart mid-scoring leaves nothing running; surface it instead of hanging.
        if (e.status === "scoring") {
          e.status = "failed";
          e.scoring_error = "The validator restarted before scoring finished.";
        }
        this.episodes.set(e.episode_id, e);
      }
    }
  }

  get(id: string) {
    return this.episodes.get(id);
  }

  list() {
    return [...this.episodes.values()];
  }

  put(e: EpisodeRecord) {
    this.episodes.set(e.episode_id, e);
    this.flush();
    return e;
  }

  update(id: string, patch: Partial<EpisodeRecord>) {
    const cur = this.episodes.get(id);
    if (!cur) throw new Error(`No such episode ${id}`);
    return this.put({ ...cur, ...patch });
  }

  readBlob(id: string, kind: string): Buffer | null {
    const p = join(this.dir, "blobs", id, kind);
    return existsSync(p) ? readFileSync(p) : null;
  }

  blobPath(id: string, kind: string) {
    const d = join(this.dir, "blobs", id);
    mkdirSync(d, { recursive: true });
    return join(d, kind);
  }

  saveBlob(id: string, kind: string, bytes: Uint8Array) {
    writeFileSync(this.blobPath(id, kind), bytes);
  }

  private flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.episodes.values()], null, 2));
    renameSync(tmp, this.file);
  }
}
