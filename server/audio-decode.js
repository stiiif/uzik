// Decodes a compressed audio file (mp3/flac/m4a/aac/wav/ogg/opus — whatever ffmpeg's built with support
// for) into raw PCM, the server-side equivalent of the browser's decodeAudioData. Node has no built-in
// audio decoder — decodeAudioData is a Web Audio API method and genuinely doesn't exist outside a browser
// (confirmed before building this: OfflineAudioContext is undefined in every non-browser JS runtime) — so
// this shells out to ffmpeg, the standard, Docker-friendly way to do this server-side.
//
// Output matches what analyzeEnergy() in player.js hands to the worker: two Float32Arrays (left, right)
// at a fixed sample rate, so analysis-dsp.js's analyzeTrack() needs zero changes to accept either source.
// Forcing stereo output (-ac 2) even for a mono source file gives left===right, which is the same "fully
// mono-compatible" answer computeSubBass already produces client-side for its own explicit
// samplesR === null case — different code path, same correct result, no special-casing needed here.

const { spawn } = require('child_process');

const ANALYSIS_SAMPLE_RATE = 44100; // matches ANALYSIS_SAMPLE_RATE in player.js — same rate on both ends
                                     // means Hz-based thresholds (SUB_LO_HZ, MONO_LOWPASS_HZ, etc. in
                                     // analysis-dsp.js) behave identically regardless of where a track
                                     // was analyzed.

function decodeAudioFile(filePath, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',           // suppress ffmpeg's normal banner/progress noise — only real errors on stderr
      '-i', filePath,
      '-f', 'f32le',           // raw 32-bit float, little-endian — directly usable as a Float32Array
      '-ar', String(ANALYSIS_SAMPLE_RATE),
      '-ac', '2',              // always decode to stereo — see header comment on why mono sources are fine
      '-',                     // write to stdout
    ];
    // (FFMPEG_PATH: the app's own copy of ffmpeg, when the server runs inside the Uzikext app)
    const proc = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms decoding ${filePath}`));
    }, timeoutMs);

    proc.stdout.on('data', chunk => chunks.push(chunk));
    proc.stderr.on('data', chunk => { stderr += chunk.toString('utf8', 0, Math.min(chunk.length, 4096)); });
    proc.on('error', err => { // e.g. ffmpeg binary not found/not executable
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg failed to start: ${err.message}`));
    });
    proc.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`ffmpeg exited ${code} decoding ${filePath}: ${stderr.trim().slice(0, 300)}`)); return; }
      const raw = Buffer.concat(chunks);
      if (raw.length < 8) { reject(new Error(`ffmpeg produced no usable audio for ${filePath}`)); return; }
      try {
        resolve(deinterleave(raw));
      } catch (e) { reject(e); }
    });
  });
}

// f32le interleaved stereo (L,R,L,R,...) -> separate {left, right} Float32Arrays. Buffer.concat's result
// isn't guaranteed 4-byte-aligned within its underlying ArrayBuffer (chunk boundaries from the ffmpeg
// stream are arbitrary), and a misaligned Float32Array view throws — so this copies into a fresh,
// correctly-sized ArrayBuffer first rather than trying to view the raw Buffer directly.
function deinterleave(raw) {
  const bytesPerSample = 4; // f32le
  const totalSamples = Math.floor(raw.length / bytesPerSample); // combined L+R sample count
  const frames = Math.floor(totalSamples / 2);
  if (frames < 1) throw new Error('decoded audio too short to analyze');
  const ab = new ArrayBuffer(frames * 2 * bytesPerSample);
  new Uint8Array(ab).set(raw.subarray(0, frames * 2 * bytesPerSample));
  const interleaved = new Float32Array(ab);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { left[i] = interleaved[i * 2]; right[i] = interleaved[i * 2 + 1]; }
  return { left, right, sampleRate: ANALYSIS_SAMPLE_RATE };
}

module.exports = { decodeAudioFile, ANALYSIS_SAMPLE_RATE };
