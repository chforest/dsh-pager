// src/sense-worker.ts (upgraded to native sherpa-onnx-node 2-thread ARM64 + silence/punctuation gate)
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function createSenseWorkerClient(worker) {
  let counter = 0;
  const pending = new Map();
  let dead = false;
  const deathFns = new Set();
  const die = () => {
    if (dead) return;
    dead = true;
    for (const fn of deathFns) {
      try { fn(); } catch {}
    }
  };
  worker.on?.("message", (msg) => {
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    if (!msg.ok) {
      p.resolve(null);
      return;
    }
    p.resolve(p.op === "create" ? true : msg.text ?? "");
  });
  worker.on?.("error", (e) => {
    die();
    const err = new Error("sense worker error: " + String(e?.message ?? e));
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  worker.on?.("exit", () => {
    die();
    const err = new Error("sense worker exited");
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  const request = (op, samples) => {
    if (dead) return Promise.reject(new Error("sense worker dead"));
    const id = counter++;
    return new Promise((resolve, reject) => {
      pending.set(id, { op, resolve, reject });
      const msg = { id, op };
      if (samples) msg.samples = samples;
      try {
        worker.postMessage(msg);
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };
  return {
    request,
    onDeath(fn) {
      deathFns.add(fn);
    },
    terminate: async () => {
      dead = true;
      const err = new Error("sense worker terminated");
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      try { await worker.terminate?.(); } catch {}
    }
  };
}

function cleanSpeechText(s) {
  const t = String(s ?? "").replace(/\s+\.\s*$/, "").trim();
  const stripped = t.replace(/[\s.,????????????????\-???'"???????????)????\[\]????>]/g, "");
  return stripped.length > 0 ? t : "";
}\p{N}]/u.test(t) ? t : "";
}

function rmsOfSamples(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function startSenseWorker(data) {
  const port = parentPort;
  if (!port) return;
  let nativeRec = null;
  let wasmRec = null;
  let sherpaWasm = null;
  port.on("message", async (msg) => {
    try {
      if (msg.op === "create" || msg.op === "decode") {
        if (!nativeRec && !wasmRec) {
          try {
            const { OfflineRecognizer } = require("sherpa-onnx-node");
            nativeRec = new OfflineRecognizer({
              featConfig: { sampleRate: 16e3, featureDim: 80 },
              modelConfig: {
                senseVoice: {
                  model: data.modelDir + "/model.int8.onnx",
                  language: data.language,
                  useInverseTextNormalization: data.useITN
                },
                tokens: data.modelDir + "/tokens.txt",
                numThreads: 2,
                provider: "cpu",
                debug: 0
              }
            });
          } catch {
            if (!sherpaWasm) sherpaWasm = await import(data.sherpaModule);
            wasmRec = sherpaWasm.createOfflineRecognizer({
              featConfig: { sampleRate: 16e3, featureDim: 80 },
              modelConfig: {
                senseVoice: {
                  model: data.modelDir + "/model.int8.onnx",
                  language: data.language,
                  useInverseTextNormalization: data.useITN
                },
                tokens: data.modelDir + "/tokens.txt",
                provider: "cpu",
                debug: 0
              }
            });
          }
        }
        if (msg.op === "decode" && msg.samples) {
          if (rmsOfSamples(msg.samples) < 0.014) {
            port.postMessage({ id: msg.id, ok: true, text: "" });
            return;
          }
          if (nativeRec) {
            const stream = nativeRec.createStream();
            stream.acceptWaveform({ sampleRate: 16e3, samples: msg.samples });
            nativeRec.decode(stream);
            const text = cleanSpeechText(nativeRec.getResult(stream).text);
            port.postMessage({ id: msg.id, ok: true, text });
            return;
          }
          const stream = wasmRec.createStream();
          try {
            stream.acceptWaveform(16e3, msg.samples);
            wasmRec.decode(stream);
            const text = cleanSpeechText(wasmRec.getResult(stream).text);
            port.postMessage({ id: msg.id, ok: true, text });
          } finally {
            try { stream.free(); } catch {}
          }
          return;
        }
        port.postMessage({ id: msg.id, ok: true, text: "" });
        return;
      }
      port.postMessage({ id: msg.id, ok: false, error: "unknown op: " + msg.op });
    } catch (e) {
      port.postMessage({ id: msg.id, ok: false, error: String(e) });
    }
  });
}
if (parentPort) {
  startSenseWorker(workerData);
}
export {
  createSenseWorkerClient,
  startSenseWorker
};
