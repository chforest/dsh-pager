import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const MAX_SAMPLES = 55 * 16000;
const fault = (message, code = 'native-asr', status = 400) => Object.assign(new Error(message), { code, status });
const cancelled = () => fault('ASR turn cancelled', 'cancelled', 409);
export function createNativeCallAsr({ modelDir, files, fallback, resetFallback, runtime = () => ({ env: process.env }), forkProcess = fork, verifyFiles, timeoutMs = 30000, metric = () => {}, manualMode = () => false }) {
  let child = null, ready = null, closed = false, sequence = 0, failedUntil = 0;
  const pending = new Map(), epochs = new Map(), generations = new Map();
  const current = state => !closed && (generations.get(state.sessionId) || 0) === state.generation;
  const report = (sessionId, stage, data) => { try { metric(sessionId, stage, data); } catch {} };
  function die(processRef, error) {
    if (child !== processRef) return;
    child = null; ready = null; failedUntil = error.code === 'cancelled' ? 0 : Date.now() + 10000;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear();
  }
  function rpc(message) {
    return new Promise((resolve, reject) => {
      if (!child) { reject(fault('native worker unavailable')); return; }
      const id = ++sequence, processRef = child;
      const timer = setTimeout(() => { die(processRef, fault('native worker timeout')); processRef.kill(); }, timeoutMs);
      pending.set(id, { resolve, reject, timer, op: message.op, sessionId: message.sessionId });
      try { child.send({ id, ...message }); } catch (error) { die(processRef, error); processRef.kill(); }
    });
  }
  async function verified() {
    if (verifyFiles) return verifyFiles();
    for (const file of files) {
      const target = path.join(modelDir, file.file), st = await fs.promises.stat(target);
      if (!st.isFile()) return false;
      const hash = crypto.createHash('sha256'); for await (const part of fs.createReadStream(target)) hash.update(part);
      if (hash.digest('hex') !== file.sha256) return false;
    }
    return true;
  }
  function prepare() {
    if (closed) return Promise.reject(cancelled());
    if (ready) return ready;
    if (Date.now() < failedUntil) return Promise.reject(fault('native worker cooling down'));
    ready = (async () => {
      if (!await verified()) throw fault('local native model verification failed');
      if (closed) throw cancelled();
      const host = runtime(); if (!host) throw fault('native Node runtime unavailable');
      const processRef = forkProcess(fileURLToPath(new URL('./native-call-asr-worker.cjs', import.meta.url)), [], { windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], ...(host.execPath ? { execPath: host.execPath } : {}), env: host.env });
      child = processRef;
      processRef.on('message', response => { if (child !== processRef) return; const entry = pending.get(response?.id); if (!entry) return; pending.delete(response.id); clearTimeout(entry.timer); response.ok ? entry.resolve(response) : entry.reject(fault('native decode failed')); });
      processRef.on('error', error => { die(processRef, error); processRef.kill(); });
      processRef.on('exit', () => die(processRef, fault('native worker exited')));
      await rpc({ op: 'init', modelDir });
      if (closed || child !== processRef) throw cancelled();
    })().catch(error => { ready = null; failedUntil = Date.now() + 10000; if (child) { const processRef = child; die(processRef, error); processRef.kill(); } throw error; });
    return ready;
  }
  function stateFor(sessionId, epoch) {
    const key = JSON.stringify([sessionId, epoch]);
    let state = epochs.get(key);
    if (!state) {
      if ([...epochs.values()].filter(s => !s.done).length >= 4) throw fault('too many active ASR epochs', 'limit', 429);
      state = { sessionId, epoch, generation: generations.get(sessionId) || 0, pcm: new Float32Array(MAX_SAMPLES), count: 0, nativeFed: 0, queued: 0, chain: Promise.resolve(), backend: 'native', done: false, text: '' };
      epochs.set(key, state);
    }
    return state;
  }
  async function feed(sessionId, samples, final, offset = 0, epoch = 0, manual = false) {
    if (closed) throw cancelled();
    if (manualMode() && !manual) return { text: '' };
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !Number.isInteger(epoch) || epoch < 0 || !Number.isInteger(offset) || offset < 0 || !(samples instanceof Float32Array) || samples.byteLength > 4 * 1024 * 1024 || offset + samples.length > MAX_SAMPLES) throw fault('invalid ASR PCM or offset');
    for (const value of samples) if (!Number.isFinite(value)) throw fault('nonfinite ASR PCM');
    const state = stateFor(sessionId, epoch);
    if (state.queued >= 8) throw fault('ASR request backlog limit', 'limit', 429);
    state.queued++;
    const run = state.chain.catch(() => {}).then(async () => {
      if (!current(state)) throw cancelled();
      if (state.done) return { text: state.text, endpoint: false };
      if (offset > state.count) throw fault('missing ASR audio before offset', 'offset-gap', 409);
      const overlap = Math.min(samples.length, state.count - offset);
      for (let i = 0; i < overlap; i++) if (state.pcm[offset + i] !== samples[i]) throw fault('conflicting ASR audio retry', 'offset-conflict', 409);
      if (offset + samples.length > state.count) { state.pcm.set(samples.subarray(overlap), state.count); state.count = offset + samples.length; }
      const result = async () => {
        if (state.backend === 'native') {
          try {
            const start = Date.now(); await prepare(); if (!current(state)) throw cancelled();
            const response = await rpc({ op: 'feed', sessionId, epoch, offset: state.nativeFed, samples: state.pcm.slice(state.nativeFed, state.count), final: !!final });
            if (!current(state)) throw cancelled(); state.nativeFed = state.count;
            report(sessionId, 'native-asr-result', { durationMs: Date.now() - start, decodeMs: response.decodeMs ?? -1, final: !!final });
            const rawT = String(response.text ?? "").replace(/\s+\.\s*$/, "").trim();
            const cleaned = rawT.replace(/[\s.,????????????????\-???'"???????????)????\[\]????>]/g, "").length > 0 ? rawT : "";
            if (!final || cleaned) return { ...response, text: cleaned };
            let sumSq = 0;
            for (let i = 0; i < state.count; i++) sumSq += state.pcm[i] * state.pcm[i];
            const rms = state.count > 0 ? Math.sqrt(sumSq / state.count) : 0;
            if (rms < 0.015) return { text: "", endpoint: false };
            state.forceSense = true;
          } catch (error) { if (!current(state) || error.code === 'cancelled') throw cancelled(); }
          state.backend = 'fallback'; resetFallback?.(sessionId);
          report(sessionId, 'native-asr-fallback', { final: !!final });
        }
        const response = await fallback(sessionId, state.pcm.slice(0, state.count), final, 0, epoch, manual, !state.forceSense);
        if (!current(state)) throw cancelled(); return response;
      };
      const out = await result(); state.text = out.text || '';
      if (final && !out.loading) {
        state.done = true; state.pcm = null;
        for (const [key, old] of epochs) if (epochs.size > 32 && old.done && old !== state) epochs.delete(key);
      }
      return { text: state.text, endpoint: false, ...(out.loading ? { loading: true } : {}) };
    });
    const tracked = run.finally(() => { state.queued--; });
    state.chain = tracked; return tracked;
  }
  function reset(sessionId) {
    generations.set(sessionId, (generations.get(sessionId) || 0) + 1);
    for (const [key, state] of epochs) if (state.sessionId === sessionId) epochs.delete(key);
    if ([...pending.values()].some(p => p.op === 'feed' && p.sessionId === sessionId)) { const processRef = child; if (processRef) { die(processRef, cancelled()); processRef.kill(); } }
    else if (child) void rpc({ op: 'reset', sessionId }).catch(() => {});
  }
  function close() { closed = true; epochs.clear(); if (child) { const processRef = child; die(processRef, cancelled()); processRef.kill(); } }
  return { prepare, feed, reset, close };
}
