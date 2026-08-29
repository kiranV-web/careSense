import { createRequire } from 'node:module';
import type { ErrorObject } from 'ajv';

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as typeof import('ajv').default;
const addFormats = require('ajv-formats') as typeof import('ajv-formats').default;

export interface CallParty {
  external_id: string;
  name?: string;
  raw_metadata: Record<string, unknown>;
}

export interface CallMetadata {
  schema_version: string;
  call_id: string;
  audio_file?: string;
  started_at: string;
  language: string;
  device_model?: string;
  banking_product?: string;
  channel_layout?: 'STEREO' | 'MONO' | 'UNKNOWN';
  customer_channel?: 'LEFT' | 'RIGHT';
  agent_channel?: 'LEFT' | 'RIGHT';
  source_caller_speaker_id?: string;
  source_agent_speaker_id?: string;
  customer: CallParty;
  agent: CallParty;
  source?: string;
  additional_data?: Record<string, unknown>;
  raw_metadata: Record<string, unknown>;
}

const canonicalSchema = {
  type: 'object', required: ['schema_version', 'call_id', 'started_at', 'language', 'customer', 'agent'],
  additionalProperties: true,
  properties: {
    schema_version: { type: 'string', const: '1.0' }, call_id: { type: 'string', minLength: 1 },
    audio_file: { type: 'string', minLength: 1 }, started_at: { type: 'string', format: 'date-time' },
    language: { type: 'string', minLength: 1 }, device_model: { type: 'string' },
    customer: { type: 'object', required: ['external_id'], additionalProperties: true,
      properties: { external_id: { type: 'string', minLength: 1 }, name: { type: 'string' } } },
    agent: { type: 'object', required: ['external_id'], additionalProperties: true,
      properties: { external_id: { type: 'string', minLength: 1 }, name: { type: 'string' } } },
    source: { type: 'string' }, additional_data: { type: 'object', additionalProperties: true }
  }
} as const;

const sessionSchema = {
  type: 'object', required: ['call_id', 'audio_file', 'agent', 'caller', 'start_time_ms'], additionalProperties: true,
  properties: {
    call_id: { type: 'string', minLength: 1 },
    audio_file: { type: 'string', pattern: '^[^/\\\\]+\\.([mM][pP]3|[wW][aA][vV])$' },
    language: { type: 'string', minLength: 1 }, start_time_ms: { type: 'number' },
    agent: { type: 'object', required: ['metadata'], additionalProperties: true, properties: {
      metadata: { type: 'object', required: ['agent_id'], additionalProperties: true,
        properties: { agent_id: { type: 'string', minLength: 1 }, agent_name: { type: 'string' } } }
    } },
    caller: { type: 'object', required: ['metadata'], additionalProperties: true, properties: {
      metadata: { type: 'object', required: ['customer_id'], additionalProperties: true, properties: {
        customer_id: { type: 'string', minLength: 1 }, first_and_last_name: { type: 'string' }, device_model: { type: 'string' }
      } }
    } }
  }
} as const;

const callRadarSchema = {
  type: 'object', required: ['sid', 'start_time_ms', 'end_time_ms', 'agent', 'caller'], additionalProperties: true,
  properties: {
    sid: { type: 'string', minLength: 1 }, start_time_ms: { type: 'number' }, end_time_ms: { type: 'number' },
    session: { type: 'string' },
    agent: { type: 'object', required: ['speaker_id', 'metadata'], additionalProperties: true, properties: {
      speaker_id: { anyOf: [{ type: 'number' }, { type: 'string', minLength: 1 }] }, metadata: { type: 'object', required: ['agent_name'],
        additionalProperties: true, properties: { agent_name: { type: 'string', minLength: 1 } } }
    } },
    caller: { type: 'object', required: ['speaker_id', 'metadata'], additionalProperties: true, properties: {
      speaker_id: { anyOf: [{ type: 'number' }, { type: 'string', minLength: 1 }] }, metadata: { type: 'object', required: ['first and last name'],
        additionalProperties: true, properties: { 'first and last name': { type: 'string', minLength: 1 } } }
    } }
  }
} as const;

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateCanonical = ajv.compile(canonicalSchema);
const validateSession = ajv.compile(sessionSchema);
const validateCallRadar = ajv.compile(callRadarSchema);

type CanonicalInput = {
  schema_version: string; call_id: string; audio_file?: string; started_at: string; language: string;
  device_model?: string; customer: { external_id: string; name?: string };
  agent: { external_id: string; name?: string }; source?: string; additional_data?: Record<string, unknown>;
};
type SessionInput = {
  call_id: string; audio_file: string; language?: string; start_time_ms: number;
  agent: { metadata: { agent_id: string; agent_name?: string }; [key: string]: unknown };
  caller: { metadata: { customer_id: string; first_and_last_name?: string; device_model?: string }; [key: string]: unknown };
  [key: string]: unknown;
};
type CallRadarInput = {
  sid: string; start_time_ms: number; end_time_ms: number; session?: string; labels?: Record<string, unknown>;
  agent: { speaker_id: string | number; metadata: { agent_name: string }; [key: string]: unknown };
  caller: { speaker_id: string | number; metadata: { 'first and last name': string }; [key: string]: unknown };
  [key: string]: unknown;
};

export type MetadataResult = { success: true; data: CallMetadata } | { success: false; errors: ErrorObject[] };

function asRecord(input: unknown): Record<string, unknown> {
  return input as Record<string, unknown>;
}

export function normalizeAgentId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
}

export function validateMetadata(input: unknown, defaultLanguage = 'en'): MetadataResult {
  if (validateCanonical(input)) {
    const value = input as CanonicalInput;
    const agentName = value.agent.name?.trim();
    return { success: true, data: {
      ...value,
      device_model: value.device_model?.trim() || 'GENERAL',
      customer: { ...value.customer, raw_metadata: asRecord(value.customer) },
      agent: { ...value.agent, external_id: agentName ? normalizeAgentId(agentName) : value.agent.external_id,
        name: agentName, raw_metadata: asRecord(value.agent) },
      raw_metadata: asRecord(input)
    } };
  }
  if (validateSession(input)) {
    const value = input as SessionInput;
    const startedAt = new Date(value.start_time_ms);
    if (Number.isNaN(startedAt.getTime())) {
      return { success: false, errors: [{ keyword: 'format', instancePath: '/start_time_ms', schemaPath: '', params: {}, message: 'must be a valid epoch timestamp' }] };
    }
    return { success: true, data: {
      schema_version: 'session-1.0', call_id: value.call_id, audio_file: value.audio_file,
      started_at: startedAt.toISOString(), language: value.language ?? defaultLanguage,
      device_model: value.caller.metadata.device_model?.trim() || 'GENERAL',
      customer: { external_id: value.caller.metadata.customer_id, name: value.caller.metadata.first_and_last_name, raw_metadata: asRecord(value.caller) },
      agent: { external_id: value.agent.metadata.agent_name?.trim()
        ? normalizeAgentId(value.agent.metadata.agent_name) : value.agent.metadata.agent_id,
        name: value.agent.metadata.agent_name?.trim(), raw_metadata: asRecord(value.agent) },
      source: 'session_call_data', additional_data: { sid: value.sid, session: value.session, labels: value.labels },
      raw_metadata: asRecord(input)
    } };
  }
  if (validateCallRadar(input)) {
    const value = input as CallRadarInput;
    const startedAt = new Date(value.start_time_ms);
    if (Number.isNaN(startedAt.getTime()) || value.end_time_ms < value.start_time_ms) {
      return { success: false, errors: [{ keyword: 'format', instancePath: '/start_time_ms', schemaPath: '', params: {},
        message: 'must contain a valid call time range' }] };
    }
    const agentName = value.agent.metadata.agent_name.trim();
    const customerName = value.caller.metadata['first and last name'].trim();
    const identityKey = normalizeAgentId;
    return { success: true, data: {
      schema_version: 'callradar-1.0', call_id: value.sid, audio_file: `${value.sid}.mp3`,
      started_at: startedAt.toISOString(), language: defaultLanguage, banking_product: 'GENERAL_BANKING',
      channel_layout: 'STEREO', customer_channel: 'RIGHT', agent_channel: 'LEFT',
      source_caller_speaker_id: String(value.caller.speaker_id),
      source_agent_speaker_id: String(value.agent.speaker_id),
      customer: { external_id: `CALLRADAR-CUSTOMER-${value.caller.speaker_id}`, name: customerName,
        raw_metadata: asRecord(value.caller) },
      agent: { external_id: identityKey(agentName), name: agentName,
        raw_metadata: asRecord(value.agent) },
      source: 'callradar', additional_data: { session: value.session, labels: value.labels,
        duration_ms: value.end_time_ms - value.start_time_ms, source_caller_speaker_id: value.caller.speaker_id,
        source_agent_speaker_id: value.agent.speaker_id }, raw_metadata: asRecord(input)
    } };
  }
  return { success: false, errors: [...(validateSession.errors ?? [])] };
}
