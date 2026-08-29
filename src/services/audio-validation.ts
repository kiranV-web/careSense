import { execFile, spawn } from 'node:child_process';

export type AudioRejectionReason = 'AUDIO_TOO_SHORT' | 'SILENT_AUDIO' | 'MUSIC_DETECTED' | 'INVALID_AUDIO';

export interface AudioValidationOptions {
  ffmpegPath: string;
  ffprobePath: string;
  minDurationSeconds: number;
  silenceThresholdDb: number;
  musicDetectionEnabled: boolean;
  musicOverlapThreshold: number;
  timeoutMs: number;
  expectedChannelLayout?: string;
}

export type AudioValidationResult = {
  accepted: true;
  durationSeconds: number;
  channels: number;
} | {
  accepted: false;
  reason: AudioRejectionReason;
  message: string;
  details: Record<string, unknown>;
};

interface ProbeResult {
  durationSeconds: number;
  channels: number;
}

export interface PcmStatistics {
  peak: number;
  leftFrameRms: number[];
  rightFrameRms: number[];
}

type MeasurementOptions = Pick<AudioValidationOptions,
  'minDurationSeconds' | 'silenceThresholdDb' | 'musicDetectionEnabled' | 'musicOverlapThreshold'>;

function runFile(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${String(stderr).trim() || error.message}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function probeAudio(filePath: string, options: AudioValidationOptions): Promise<ProbeResult> {
  const { stdout } = await runFile(options.ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels:format=duration',
    '-of', 'json', filePath
  ], options.timeoutMs);
  const parsed = JSON.parse(stdout) as { streams?: Array<{ channels?: number }>; format?: { duration?: string } };
  const durationSeconds = Number(parsed.format?.duration);
  const channels = Number(parsed.streams?.[0]?.channels);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isInteger(channels) || channels <= 0) {
    throw new Error('The file does not contain a valid audio stream with a measurable duration');
  }
  return { durationSeconds, channels };
}

function consumePcmFrame(frame: Buffer, leftFrameRms: number[], rightFrameRms: number[], currentPeak: number): number {
  let leftSquares = 0;
  let rightSquares = 0;
  let samples = 0;
  let peak = currentPeak;
  for (let offset = 0; offset + 3 < frame.length; offset += 4) {
    const left = frame.readInt16LE(offset) / 32768;
    const right = frame.readInt16LE(offset + 2) / 32768;
    leftSquares += left * left;
    rightSquares += right * right;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    samples += 1;
  }
  if (samples > 0) {
    leftFrameRms.push(Math.sqrt(leftSquares / samples));
    rightFrameRms.push(Math.sqrt(rightSquares / samples));
  }
  return peak;
}

async function decodeStatistics(filePath: string, options: AudioValidationOptions): Promise<PcmStatistics> {
  const sampleRate = 8_000;
  const frameBytes = sampleRate / 10 * 2 * 2; // 100 ms, stereo, signed 16-bit PCM.
  const child = spawn(options.ffmpegPath, [
    '-v', 'error', '-i', filePath, '-vn', '-ac', '2', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const leftFrameRms: number[] = [];
  const rightFrameRms: number[] = [];
  const stderr: Buffer[] = [];
  let carry = Buffer.alloc(0);
  let peak = 0;
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
  child.stderr.on('data', (chunk: Buffer | Uint8Array) => stderr.push(Buffer.from(chunk)));
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  try {
    for await (const rawChunk of child.stdout) {
      const chunk = Buffer.from(rawChunk as Uint8Array);
      const data = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let offset = 0;
      while (offset + frameBytes <= data.length) {
        peak = consumePcmFrame(data.subarray(offset, offset + frameBytes), leftFrameRms, rightFrameRms, peak);
        offset += frameBytes;
      }
      carry = data.subarray(offset);
    }
    if (carry.length >= 4) peak = consumePcmFrame(carry, leftFrameRms, rightFrameRms, peak);
    const exitCode = await completed;
    if (exitCode !== 0) throw new Error(`ffmpeg failed: ${Buffer.concat(stderr).toString('utf8').trim() || `exit ${exitCode}`}`);
    if (leftFrameRms.length === 0) throw new Error('The audio stream decoded to no samples');
    return { peak, leftFrameRms, rightFrameRms };
  } finally {
    clearTimeout(timer);
  }
}

export function isMusicDominantStereo(statistics: PcmStatistics, overlapThreshold: number): boolean {
  const frameCount = Math.min(statistics.leftFrameRms.length, statistics.rightFrameRms.length);
  if (frameCount < 100) return false;
  let loudestRms = 0;
  for (const rms of statistics.leftFrameRms) loudestRms = Math.max(loudestRms, rms);
  for (const rms of statistics.rightFrameRms) loudestRms = Math.max(loudestRms, rms);
  const activeThreshold = Math.max(10 ** (-50 / 20), loudestRms * 0.08);
  let leftActive = 0;
  let rightActive = 0;
  let eitherActive = 0;
  let bothActive = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const left = statistics.leftFrameRms[index]!;
    const right = statistics.rightFrameRms[index]!;
    const hasLeft = left >= activeThreshold;
    const hasRight = right >= activeThreshold;
    if (hasLeft) leftActive += 1;
    if (hasRight) rightActive += 1;
    if (hasLeft || hasRight) eitherActive += 1;
    if (hasLeft && hasRight) bothActive += 1;
    leftEnergy += left;
    rightEnergy += right;
  }
  if (eitherActive === 0) return false;
  const overlapRatio = bothActive / eitherActive;
  const leftActivityRatio = leftActive / frameCount;
  const rightActivityRatio = rightActive / frameCount;
  const energyBalance = Math.min(leftEnergy, rightEnergy) / Math.max(leftEnergy, rightEnergy, Number.EPSILON);
  return overlapRatio >= overlapThreshold && leftActivityRatio >= 0.85 && rightActivityRatio >= 0.85 && energyBalance >= 0.25;
}

export function classifyAudioMeasurements(probe: ProbeResult, statistics: PcmStatistics,
  options: MeasurementOptions): AudioValidationResult {
  if (probe.durationSeconds <= options.minDurationSeconds) {
    return {
      accepted: false, reason: 'AUDIO_TOO_SHORT',
      message: `Audio duration must be longer than ${options.minDurationSeconds} seconds`,
      details: { duration_seconds: probe.durationSeconds, minimum_duration_seconds: options.minDurationSeconds }
    };
  }
  const peakDb = statistics.peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(statistics.peak);
  if (peakDb <= options.silenceThresholdDb) {
    return {
      accepted: false, reason: 'SILENT_AUDIO', message: 'The recording is completely silent',
      details: { duration_seconds: probe.durationSeconds, peak_db: Number.isFinite(peakDb) ? peakDb : '-inf', silence_threshold_db: options.silenceThresholdDb }
    };
  }
  if (options.musicDetectionEnabled && probe.channels >= 2 &&
      isMusicDominantStereo(statistics, options.musicOverlapThreshold)) {
    return {
      accepted: false, reason: 'MUSIC_DETECTED',
      message: 'Music-dominant audio without agent/customer turn-taking is not supported',
      details: { duration_seconds: probe.durationSeconds, channels: probe.channels }
    };
  }
  return { accepted: true, durationSeconds: probe.durationSeconds, channels: probe.channels };
}

export async function validateAudioFile(filePath: string, options: AudioValidationOptions): Promise<AudioValidationResult> {
  let probe: ProbeResult;
  try {
    probe = await probeAudio(filePath, options);
  } catch (error) {
    return {
      accepted: false, reason: 'INVALID_AUDIO', message: 'The file is not a valid or decodable MP3/WAV recording',
      details: { error: error instanceof Error ? error.message : String(error) }
    };
  }
  let statistics: PcmStatistics;
  try {
    statistics = await decodeStatistics(filePath, options);
  } catch (error) {
    return {
      accepted: false, reason: 'INVALID_AUDIO', message: 'The audio stream could not be decoded',
      details: { duration_seconds: probe.durationSeconds, error: error instanceof Error ? error.message : String(error) }
    };
  }
  return classifyAudioMeasurements(probe, statistics, options);
}
