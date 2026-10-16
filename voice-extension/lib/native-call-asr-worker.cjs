// Native addon is intentionally confined to this child, never the DSH host.
const { OnlineRecognizer } = require('sherpa-onnx-node');
const path = require('node:path');
let recognizer = null;
const streams = new Map();
const MAX_SAMPLES = 55 * 16000;
function respond(id, value) { if (process.connected) process.send({ id, ...value }); }
process.on('message', message => {
  try {
    if (message.op === 'init') {
      const f = name => path.join(message.modelDir, name);
      recognizer = new OnlineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: { encoder: f('encoder.int8.onnx'), decoder: f('decoder.onnx'), joiner: f('joiner.int8.onnx') }, tokens: f('tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 } });
      respond(message.id, { ok: true }); return;
    }
    if (message.op === 'reset') {
      for (const [key, value] of streams) if (value.sessionId === message.sessionId) streams.delete(key);
      respond(message.id, { ok: true }); return;
    }
    if (message.op !== 'feed' || !recognizer) throw Error('native ASR not ready');
    const { sessionId, epoch, offset, final, samples } = message;
    if (!(samples instanceof Float32Array) || !Number.isInteger(offset) || offset < 0 || offset + samples.length > MAX_SAMPLES || samples.byteLength > 4 * 1024 * 1024) throw Error('invalid native PCM');
    for (const value of samples) if (!Number.isFinite(value)) throw Error('nonfinite PCM');
    const key = JSON.stringify([sessionId, epoch]);
    let entry = streams.get(key);
    if (!entry) { if (streams.size >= 36) throw Error('native stream limit'); entry = { sessionId, stream: recognizer.createStream(), fed: 0, done: false, text: '' }; streams.set(key, entry); }
    if (entry.done) { respond(message.id, { ok: true, text: entry.text, endpoint: false }); return; }
    if (offset !== entry.fed) throw Error('native offset mismatch');
    const at = Date.now();
    if (samples.length) entry.stream.acceptWaveform({ sampleRate: 16000, samples });
    entry.fed += samples.length;
    while (recognizer.isReady(entry.stream)) recognizer.decode(entry.stream);
    if (final) {
      entry.stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(8000) });
      while (recognizer.isReady(entry.stream)) recognizer.decode(entry.stream);
    }
    entry.text = recognizer.getResult(entry.stream).text || '';
    if (final) { entry.done = true; entry.stream = null; for (const [oldKey, old] of streams) if (streams.size > 32 && old.done && oldKey !== key) streams.delete(oldKey); }
    respond(message.id, { ok: true, text: entry.text, endpoint: false, decodeMs: Date.now() - at });
  } catch { respond(message.id, { ok: false, error: 'native ASR request failed' }); }
});
process.on('disconnect', () => process.exit(0));
