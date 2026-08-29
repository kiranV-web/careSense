import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import OpenAI from 'openai';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { RecordingForTranscription, StoredSegment } from '../db/transcription.repository.js';
import type { ObjectStorage } from './storage.js';

const diarizedResponseSchema = z.object({
  text: z.string().optional(),
  language: z.string().optional(),
  duration: z.number().nonnegative().optional(),
  // No minimum length here — a genuinely silent/no-speech recording legitimately
  // returns an empty segments array, which normalizeDiarizedTranscript/
  // normalizeSingleChannel already classify as the more specific EMPTY_TRANSCRIPT
  // rather than a generic schema-contract violation.
  segments: z.array(z.object({
    speaker: z.union([z.string(), z.number()]).transform(String),
    text: z.string(),
    start: z.number().nonnegative(),
    end: z.number().nonnegative()
  }))
});

export interface NormalizedTranscript {
  fullText: string;
  language?: string;
  durationSeconds?: number;
  segments: StoredSegment[];
  rawResponse: unknown;
}

export class TranscriptionContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TranscriptionContractError';
  }
}

export function normalizeDiarizedTranscript(raw: unknown, agentName?: string | null,
  customerName?: string | null): NormalizedTranscript {
  const parsed = diarizedResponseSchema.safeParse(raw);
  if (!parsed.success) throw new TranscriptionContractError('INVALID_TRANSCRIPTION_RESPONSE', parsed.error.message);
  const ordered = [...parsed.data.segments].sort((left, right) => left.start - right.start);
  if (ordered.some((segment) => segment.end < segment.start)) {
    throw new TranscriptionContractError('INVALID_TRANSCRIPTION_RESPONSE', 'A segment ends before it starts');
  }
  const first = ordered.find((segment) => segment.text.trim().length > 0);
  if (!first) throw new TranscriptionContractError('EMPTY_TRANSCRIPT', 'No meaningful transcript segments were returned');
  const speakers = [...new Set(ordered.map((segment) => segment.speaker))];
  if (speakers.length > 2) {
    throw new TranscriptionContractError('DIARIZATION_INCONSISTENT', `Expected at most two speakers, received ${speakers.length}`);
  }
  const agentSpeaker = first.speaker;
  const segments: StoredSegment[] = ordered.map((segment, index) => {
    const speakerRole = segment.speaker === agentSpeaker ? 'AGENT' : 'CUSTOMER';
    return {
      segment_index: index,
      provider_speaker_label: segment.speaker,
      speaker_role: speakerRole,
      speaker_name: speakerRole === 'AGENT' ? agentName?.trim() || 'Agent' : customerName?.trim() || 'Customer',
      start_seconds: segment.start,
      end_seconds: segment.end,
      text: segment.text
    };
  });
  return {
    fullText: ordered.map((segment) => segment.text).join('\n'),
    language: parsed.data.language,
    durationSeconds: parsed.data.duration ?? Math.max(...ordered.map((segment) => segment.end)),
    segments,
    rawResponse: raw
  };
}

function splitStereo(inputPath: string, leftPath: string, rightPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
      '-filter_complex', '[0:a]channelsplit=channel_layout=stereo[left][right]',
      '-map', '[left]', leftPath, '-map', '[right]', rightPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    const errors: Buffer[] = [];
    process.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    process.on('error', reject);
    process.on('close', (code) => code === 0 ? resolve()
      : reject(new TranscriptionContractError('INVALID_STEREO_AUDIO', Buffer.concat(errors).toString('utf8').trim()
        || `ffmpeg exited with code ${code}`)));
  });
}

function normalizeSingleChannel(raw: unknown, role: 'AGENT' | 'CUSTOMER', speakerName: string): NormalizedTranscript {
  const parsed = diarizedResponseSchema.safeParse(raw);
  if (!parsed.success) throw new TranscriptionContractError('INVALID_TRANSCRIPTION_RESPONSE', parsed.error.message);
  const ordered = [...parsed.data.segments].sort((left, right) => left.start - right.start);
  const segments: StoredSegment[] = ordered.filter((segment) => segment.text.trim()).map((segment, index) => ({
    segment_index: index,
    provider_speaker_label: role === 'AGENT' ? 'RIGHT' : 'LEFT',
    speaker_role: role,
    speaker_name: speakerName,
    start_seconds: segment.start,
    end_seconds: segment.end,
    text: segment.text
  }));
  if (segments.length === 0) throw new TranscriptionContractError('EMPTY_TRANSCRIPT', `${role} channel has no speech`);
  return {
    fullText: segments.map((segment) => segment.text).join('\n'), language: parsed.data.language,
    durationSeconds: parsed.data.duration ?? Math.max(...segments.map((segment) => segment.end_seconds)),
    segments, rawResponse: raw
  };
}

export function mergeChannelTranscripts(customer: NormalizedTranscript,
  agent: NormalizedTranscript): NormalizedTranscript {
  const segments = [...customer.segments, ...agent.segments]
    .sort((left, right) => left.start_seconds - right.start_seconds || left.end_seconds - right.end_seconds)
    .map((segment, index) => ({ ...segment, segment_index: index }));
  return {
    fullText: segments.map((segment) => `${segment.speaker_role}: ${segment.text}`).join('\n'),
    language: customer.language ?? agent.language,
    durationSeconds: Math.max(customer.durationSeconds ?? 0, agent.durationSeconds ?? 0),
    segments,
    rawResponse: { channel_layout: 'STEREO', left_agent_channel: agent.rawResponse, right_customer_channel: customer.rawResponse }
  };
}

export class TranscriptionService {
  private readonly openai: OpenAI;

  constructor(private readonly config: Config, private readonly storage: ObjectStorage) {
    this.openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: config.TRANSCRIPTION_TIMEOUT_MS,
      maxRetries: 0
    });
  }

  async transcribe(recording: RecordingForTranscription): Promise<NormalizedTranscript> {
    await mkdir(this.config.TRANSCRIPTION_TMP_DIR, { recursive: true, mode: 0o700 });
    const extension = path.extname(recording.original_filename).toLowerCase();
    const temporaryPath = path.resolve(this.config.TRANSCRIPTION_TMP_DIR, `${recording.id}-${randomUUID()}${extension}`);
    const customerPath = path.resolve(this.config.TRANSCRIPTION_TMP_DIR, `${recording.id}-${randomUUID()}-customer.wav`);
    const agentPath = path.resolve(this.config.TRANSCRIPTION_TMP_DIR, `${recording.id}-${randomUUID()}-agent.wav`);
    try {
      await this.storage.downloadToFile(recording.object_key, temporaryPath);
      if (recording.channel_layout === 'STEREO' && recording.customer_channel === 'RIGHT'
        && recording.agent_channel === 'LEFT') {
        await splitStereo(temporaryPath, agentPath, customerPath);
        const transcribeChannel = async (filePath: string) => JSON.parse(JSON.stringify(
          await this.openai.audio.transcriptions.create({
            file: createReadStream(filePath), model: this.config.OPENAI_TRANSCRIPTION_MODEL,
            response_format: 'diarized_json', chunking_strategy: 'auto'
          })
        )) as unknown;
        const [customerRaw, agentRaw] = await Promise.all([transcribeChannel(customerPath), transcribeChannel(agentPath)]);
        return mergeChannelTranscripts(
          normalizeSingleChannel(customerRaw, 'CUSTOMER', recording.customer_name?.trim() || 'Customer'),
          normalizeSingleChannel(agentRaw, 'AGENT', recording.agent_name?.trim() || 'Agent')
        );
      }
      const response = await this.openai.audio.transcriptions.create({
        file: createReadStream(temporaryPath),
        model: this.config.OPENAI_TRANSCRIPTION_MODEL,
        response_format: 'diarized_json',
        chunking_strategy: 'auto'
      });
      return normalizeDiarizedTranscript(JSON.parse(JSON.stringify(response)) as unknown,
        recording.agent_name, recording.customer_name);
    } finally {
      await Promise.all([temporaryPath, customerPath, agentPath]
        .map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
    }
  }
}
