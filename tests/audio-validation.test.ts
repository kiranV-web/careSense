import { describe, expect, it } from 'vitest';
import { classifyAudioMeasurements, isMusicDominantStereo, type PcmStatistics } from '../src/services/audio-validation.js';

const options = {
  minDurationSeconds: 5,
  silenceThresholdDb: -55,
  musicDetectionEnabled: true,
  musicOverlapThreshold: 0.92
};

function statistics(left: number[], right: number[], peak = 0.5): PcmStatistics {
  return { peak, leftFrameRms: left, rightFrameRms: right };
}

describe('audio preflight classification', () => {
  it('rejects recordings of exactly five seconds', () => {
    const result = classifyAudioMeasurements({ durationSeconds: 5, channels: 2 }, statistics([0.2], [0.2]), options);
    expect(result).toMatchObject({ accepted: false, reason: 'AUDIO_TOO_SHORT' });
  });

  it('rejects a completely silent recording', () => {
    const result = classifyAudioMeasurements({ durationSeconds: 30, channels: 2 }, statistics([0], [0], 0), options);
    expect(result).toMatchObject({ accepted: false, reason: 'SILENT_AUDIO' });
  });

  it('rejects sustained stereo music-like activity', () => {
    const result = classifyAudioMeasurements(
      { durationSeconds: 30, channels: 2 }, statistics(Array(300).fill(0.3), Array(300).fill(0.28)), options
    );
    expect(result).toMatchObject({ accepted: false, reason: 'MUSIC_DETECTED' });
  });

  it('accepts stereo agent/customer turn-taking', () => {
    const left = Array.from({ length: 300 }, (_, index) => index % 20 < 9 ? 0.25 : 0);
    const right = Array.from({ length: 300 }, (_, index) => index % 20 >= 11 ? 0.25 : 0);
    const stats = statistics(left, right);
    expect(isMusicDominantStereo(stats, options.musicOverlapThreshold)).toBe(false);
    expect(classifyAudioMeasurements({ durationSeconds: 30, channels: 2 }, stats, options))
      .toMatchObject({ accepted: true });
  });
});
