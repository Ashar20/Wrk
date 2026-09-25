/**
 * Stub for @mediapipe/hands.
 *
 * @tensorflow-models/hand-pose-detection requires this at module load to
 * support its "mediapipe" runtime, which pulls in MediaPipe's WASM build. We
 * use the "tfjs" runtime exclusively — it reuses the TensorFlow.js runtime
 * optical flow already loads — so the real package would cost megabytes for a
 * code path that never executes.
 *
 * A real package rather than a bundler alias, because the import is a
 * CommonJS require executed inside node_modules. Aliases do not reach that:
 * Vite externalises dependencies instead of transforming them, so Node's own
 * resolver runs and fails. next.config.ts's alias covers the browser bundle;
 * this covers everything else, including the test runner.
 *
 * Touching it at runtime means something selected the mediapipe runtime by
 * mistake, so it throws rather than failing quietly.
 */

function refuse() {
  throw new Error(
    "The MediaPipe hands runtime is not bundled. Hand tracking uses the tfjs " +
      "runtime; see src/lib/analysis/landmarks.ts.",
  );
}

class Hands {
  constructor() {
    refuse();
  }
}

const HAND_CONNECTIONS = [];

module.exports = { Hands, HAND_CONNECTIONS, default: { Hands, HAND_CONNECTIONS } };
