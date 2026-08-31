import "dotenv/config";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),
  R2_ENDPOINT: z.string().url().optional(),
  R2_FORCE_PATH_STYLE: booleanString.default(false),
  OPENAI_API_KEY: z.string().min(20),
  OPENAI_TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-4o-transcribe-diarize"),
  TRANSCRIPTION_MODEL_VERSION: z.string().min(1).default("v1"),
  TRANSCRIPTION_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  TRANSCRIPTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  OPENAI_ANALYSIS_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  ANALYSIS_PROMPT_VERSION: z.string().min(1).default("bank-card-loss-empathy-v5"),
  ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  ANALYSIS_GROUP_SIZE: z.coerce.number().int().min(1).max(4).default(4),
  ANALYSIS_GROUP_MAX_WAIT_MS: z.coerce.number().int().positive().default(3_000),
  ANALYSIS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  ANALYSIS_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  ANALYSIS_REASONING_EFFORT: z.enum(["none", "low", "medium", "high"]).default("low"),
  RECURRENCE_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  RECURRENCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  OPENAI_RECURRENCE_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  RECURRENCE_PROMPT_VERSION: z.string().min(1).default("v2"),
  RECURRENCE_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  REDIS_URL: z.string().url().default("redis://localhost:6380"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1_073_741_824),
  MAX_ARCHIVE_ENTRIES: z.coerce.number().int().positive().default(50),
  MAX_EXTRACTED_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
  MAX_INGEST_FILE_BYTES: z.coerce.number().int().positive().default(12_582_912),
  AUDIO_PREFLIGHT_ENABLED: booleanString.default(true),
  AUDIO_MIN_DURATION_SECONDS: z.coerce.number().positive().default(5),
  AUDIO_SILENCE_THRESHOLD_DB: z.coerce.number().max(0).default(-55),
  AUDIO_MUSIC_DETECTION_ENABLED: booleanString.default(true),
  AUDIO_MUSIC_OVERLAP_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.92),
  AUDIO_PREFLIGHT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  DEFAULT_CALL_LANGUAGE: z.string().min(1).default("en"),
  OPENAI_CHAT_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  CHAT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  CHAT_REASONING_EFFORT: z.enum(["none", "low", "medium", "high"]).default("low"),
  CHAT_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(20).default(6),
  OPENAI_COACHING_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  COACHING_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  COACHING_REASONING_EFFORT: z.enum(["none", "low", "medium", "high"]).default("low"),
  STAGING_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  UPLOAD_TMP_DIR: z.string().default("./storage/uploads"),
  TRANSCRIPTION_TMP_DIR: z.string().default("./storage/transcription-tmp"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Config {
  return schema.parse(environment);
}
