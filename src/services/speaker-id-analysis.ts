import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type SpeakerRole = 'agent' | 'caller';

interface MetadataParticipant {
  speaker_id?: unknown;
  metadata?: Record<string, unknown>;
}

interface CallRadarMetadata {
  sid?: unknown;
  agent?: MetadataParticipant;
  caller?: MetadataParticipant;
}

export interface SpeakerIdOccurrence {
  role: SpeakerRole;
  speakerId: string;
  count: number;
  names: string[];
  callIds: string[];
  files: string[];
}

export interface SpeakerIdAnalysis {
  filesScanned: number;
  invalidFiles: Array<{ file: string; reason: string }>;
  repeated: SpeakerIdOccurrence[];
  idsAppearingInBothRoles: string[];
}

interface MutableOccurrence {
  role: SpeakerRole;
  speakerId: string;
  names: Set<string>;
  callIds: string[];
  files: string[];
}

function participantName(role: SpeakerRole, participant: MetadataParticipant): string | undefined {
  const key = role === 'agent' ? 'agent_name' : 'first and last name';
  const value = participant.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizedSpeakerId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

/** Scans CallRadar JSON metadata and returns speaker IDs occurring more than once. */
export async function analyzeRepeatedSpeakerIds(metadataDirectory: string): Promise<SpeakerIdAnalysis> {
  const entries = (await readdir(metadataDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
    .sort((left, right) => left.name.localeCompare(right.name));
  const occurrences = new Map<string, MutableOccurrence>();
  const invalidFiles: SpeakerIdAnalysis['invalidFiles'] = [];

  for (const entry of entries) {
    const filePath = path.join(metadataDirectory, entry.name);
    let metadata: CallRadarMetadata;
    try {
      metadata = JSON.parse(await readFile(filePath, 'utf8')) as CallRadarMetadata;
    } catch (error) {
      invalidFiles.push({ file: entry.name, reason: error instanceof Error ? error.message : 'Invalid JSON' });
      continue;
    }

    for (const role of ['agent', 'caller'] as const) {
      const participant = metadata[role];
      const speakerId = normalizedSpeakerId(participant?.speaker_id);
      if (!participant || speakerId === undefined) {
        invalidFiles.push({ file: entry.name, reason: `Missing ${role}.speaker_id` });
        continue;
      }
      const key = `${role}:${speakerId}`;
      const occurrence = occurrences.get(key) ?? {
        role, speakerId, names: new Set<string>(), callIds: [], files: []
      };
      const name = participantName(role, participant);
      if (name) occurrence.names.add(name);
      occurrence.callIds.push(typeof metadata.sid === 'string' ? metadata.sid : path.basename(entry.name, '.json'));
      occurrence.files.push(entry.name);
      occurrences.set(key, occurrence);
    }
  }

  const repeated = [...occurrences.values()]
    .filter((occurrence) => occurrence.files.length > 1)
    .map((occurrence) => ({
      role: occurrence.role,
      speakerId: occurrence.speakerId,
      count: occurrence.files.length,
      names: [...occurrence.names].sort(),
      callIds: occurrence.callIds,
      files: occurrence.files
    }))
    .sort((left, right) => right.count - left.count || left.role.localeCompare(right.role)
      || left.speakerId.localeCompare(right.speakerId, undefined, { numeric: true }));

  const agentIds = new Set(repeated.filter((item) => item.role === 'agent').map((item) => item.speakerId));
  const callerIds = new Set(repeated.filter((item) => item.role === 'caller').map((item) => item.speakerId));
  const idsAppearingInBothRoles = [...agentIds].filter((id) => callerIds.has(id))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  return { filesScanned: entries.length, invalidFiles, repeated, idsAppearingInBothRoles };
}
