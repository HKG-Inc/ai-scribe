/** 16-bit PCM @ 16 kHz mono — same format streamed to the live transcriber. */
export const RECORDING_PCM_SAMPLE_RATE = 16_000;
export const RECORDING_PCM_CHANNELS = 1;
export const RECORDING_PCM_BITS = 16;

/**
 * Visit recording object-storage name:
 * `{YYYYMMDD}_{HHMMSS}_{8-char-uuid}.wav`
 */
export function buildVisitRecordingFilename(at: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const yyyy = at.getFullYear();
  const mm = pad(at.getMonth() + 1);
  const dd = pad(at.getDate());
  const hh = pad(at.getHours());
  const mi = pad(at.getMinutes());
  const ss = pad(at.getSeconds());
  const uuid8 =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}_${uuid8}.wav`;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Wrap raw little-endian PCM16 chunks in a standard WAV container.
 */
export function encodePcm16ChunksToWav(
  chunks: readonly Uint8Array[],
  sampleRate: number = RECORDING_PCM_SAMPLE_RATE,
  numChannels: number = RECORDING_PCM_CHANNELS,
  bitsPerSample: number = RECORDING_PCM_BITS
): Blob | null {
  const dataLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (dataLength === 0) {
    return null;
  }

  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  const dest = new Uint8Array(buffer);
  for (const chunk of chunks) {
    dest.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
