/**
 * Episode manifest schema.
 *
 * This deviates from product-spec.md §5 in four deliberate ways, each recorded
 * in docs/superpowers/specs/2026-08-23-contributor-pwa-design.md §10:
 *
 *  1. No `cid` inside the signed commitment. A CID is only known after pinning,
 *     which happens after signing — the spec's schema is circular. Addressing
 *     lives in StreamResolution, attached afterward. The sha256 binds the bytes
 *     either way. (§4.6)
 *  2. IMU is a hashed binary stream, not JSON floats inside the manifest.
 *     Float formatting across two runtimes is where byte-exactness dies. (§4.2)
 *  3. `est_skew_ms` (a constant the client cannot actually measure on Safari)
 *     is replaced by observed rates and a measured skew. (§5.2)
 *  4. Capture conditions the device actually delivered — lens, resolution, IMU
 *     frame convention — are recorded so the dataset is self-describing and the
 *     validator can map gyro axes into camera axes. (§5.4, §5.5)
 */

import type { JsonValue } from "./canonicalize";

export const SCHEMA_VERSION = "0.2.0";

/** How per-frame timestamps were obtained. Determines how far sync can be trusted. */
export type FrameTiming =
  /** Chromium: real capture timestamps from VideoFrame.timestamp. */
  | "track_processor"
  /** Safari: anchored at MediaRecorder.onstart, per-frame PTS recovered server-side. */
  | "recorder_anchored";

export type UaClass = "ios_safari" | "android_chrome" | "desktop_chrome" | "other";

export type StreamKind = "rgb" | "imu" | "audio";

/** A stream is described by its bytes, never by its content. */
export type StreamDigest = {
  sha256: string;
  bytes: number;
  content_type: string;
}

export type VideoCapture = {
  codec: string;
  width: number;
  height: number;
  fps_nominal: number;
  /**
   * Measured, not assumed — thermal throttling makes these diverge mid-episode.
   * Null where the platform cannot report it at signing time (Safari); the
   * value is then derived from decoded PTS and lives outside the signed
   * commitment, for the same reason CIDs do.
   */
  fps_observed: number | null;
  frame_timing: FrameTiming;
  /** Whatever lens we actually got. Safari will not reliably surface ultra-wide. */
  device_label: string | null;
  /** Horizontal FOV in degrees where the platform reports it, else null. */
  fov_deg: number | null;
}

/** Present only when the device recorded audio as its own stream. */
export type AudioCapture = {
  codec: string;
  bytes: number;
};

export type ImuCapture = {
  rate_hz_observed: number;
  samples: number;
  /**
   * Axis labelling, not axis normalizing. The validator maps gyro axes into
   * camera axes; doing it on-device means debugging coordinate frames on a
   * phone instead of in Python.
   */
  imu_frame: "device_motion_event";
  /** DeviceMotionEvent.rotationRate is alpha=z, beta=x, gamma=y, in deg/s. */
  rotation_convention: "alpha_z_beta_x_gamma_y_degrees";
  screen_orientation: string;
}

export type EpisodeManifest = {
  [key: string]: JsonValue;
  episode_id: string;
  schema_version: string;
  asset_id: string;
  entity_id: string;
  bounty_id: string;
  task: string;
  duration_s: number;
  recorded_at: number;
  client: { type: "pwa"; version: string; ua_class: UaClass };
  capture: { video: VideoCapture; imu: ImuCapture; audio?: AudioCapture | null };
  streams: Partial<Record<StreamKind, StreamDigest>>;
  sync: { method: FrameTiming; measured_skew_ms: number | null };
  /**
   * "unknown" where the contributor was never asked.
   *
   * The alternative is a default, and a default here is a claim about a take
   * nobody made — which is exactly what this field exists to record.
   */
  outcome: "success" | "failure" | "aborted" | "unknown";
  self_report: { task_completed: boolean; notes: string } | null;
}

export type SealedEpisodeManifest = EpisodeManifest & { manifest_hash: string };

/**
 * Storage addressing, attached AFTER pinning. Deliberately not covered by the
 * contributor's signature — see the header note. Swapping storage providers
 * changes only this record.
 */
export type StreamResolution = {
  episode_id: string;
  manifest_hash: string;
  pinned_at: number;
  streams: Partial<Record<StreamKind, { uri: string; cid: string | null }>>;
}
