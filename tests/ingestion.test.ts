import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { Config } from '../src/config.js';
import type { Repository } from '../src/db/repository.js';
import { inspectArchive } from '../src/services/archive.js';
import { ingestArchive } from '../src/services/ingestion.js';
import type { ObjectStorage, StoredObject } from '../src/services/storage.js';

let fixtureDirectory: string;
let archivePath: string;
let renamedDuplicateArchivePath: string;
let oversizedArchivePath: string;
let repeatedCallsArchivePath: string;
let callRadarArchivePath: string;

const metadata = {
  call_id: 'CALL-TEST-001', audio_file: 'DifferentCase001.mp3', start_time_ms: 1770000010000,
  agent: { metadata: { agent_id: 'AGENT-MAYA-001', agent_name: 'Maya' } },
  caller: { metadata: { customer_id: 'CUSTOMER-TEST-001', first_and_last_name: 'Test Customer' } }
};

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'caresense-ingestion-'));
  archivePath = path.join(fixtureDirectory, 'fixture.zip');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('fake-mp3'), 'DifferentCase001.mp3');
  zip.addBuffer(Buffer.from(JSON.stringify(metadata)), 'CALL-TEST-001_meta.json');
  zip.addBuffer(Buffer.from('do not upload'), 'notes.txt');
  zip.addBuffer(Buffer.from('orphan'), 'Orphan.wav');
  zip.addBuffer(Buffer.from(JSON.stringify({
    ...metadata, call_id: 'CALL-MISSING-AUDIO', audio_file: 'Absent.mp3'
  })), 'CALL-MISSING-AUDIO_meta.json');
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(archivePath));

  renamedDuplicateArchivePath = path.join(fixtureDirectory, 'renamed-duplicate.zip');
  const duplicateZip = new yazl.ZipFile();
  duplicateZip.addBuffer(Buffer.from('fake-mp3'), 'CompletelyRenamed.mp3');
  duplicateZip.addBuffer(Buffer.from(JSON.stringify({
    ...metadata, call_id: 'CALL-TEST-002', audio_file: 'CompletelyRenamed.mp3'
  })), 'UNRELATED-NAME_meta.json');
  duplicateZip.end();
  await pipeline(duplicateZip.outputStream, createWriteStream(renamedDuplicateArchivePath));

  oversizedArchivePath = path.join(fixtureDirectory, 'oversized.zip');
  const oversizedZip = new yazl.ZipFile();
  oversizedZip.addBuffer(Buffer.alloc(1025, 1), 'TooLarge.mp3');
  oversizedZip.addBuffer(Buffer.from(JSON.stringify({
    ...metadata, call_id: 'CALL-TOO-LARGE', audio_file: 'TooLarge.mp3'
  })), 'CALL-TOO-LARGE_meta.json');
  oversizedZip.end();
  await pipeline(oversizedZip.outputStream, createWriteStream(oversizedArchivePath));

  repeatedCallsArchivePath = path.join(fixtureDirectory, 'three-repeated-calls.zip');
  const repeatedZip = new yazl.ZipFile();
  for (let index = 1; index <= 4; index += 1) {
    const audioFile = `Recording-${index}.mp3`;
    repeatedZip.addBuffer(Buffer.from('identical-audio-content'), audioFile);
    repeatedZip.addBuffer(Buffer.from(JSON.stringify({
      ...metadata, call_id: `CALL-REPEAT-${index}`, audio_file: audioFile
    })), `Metadata-${index}_meta.json`);
  }
  repeatedZip.end();
  await pipeline(repeatedZip.outputStream, createWriteStream(repeatedCallsArchivePath));

  callRadarArchivePath = path.join(fixtureDirectory, 'callradar.zip');
  const callRadarZip = new yazl.ZipFile();
  callRadarZip.addBuffer(Buffer.from('stereo-mp3'), 'audio/004860b1ab2e4c88.mp3');
  callRadarZip.addBuffer(Buffer.from(JSON.stringify({
    sid: '004860b1ab2e4c88', start_time_ms: 1590860609249, end_time_ms: 1590860654497,
    agent: { speaker_id: 17, metadata: { agent_name: 'Robert' } },
    caller: { speaker_id: 44, metadata: { 'first and last name': 'Mary Smith' } }
  })), 'metadata/004860b1ab2e4c88.json');
  callRadarZip.end();
  await pipeline(callRadarZip.outputStream, createWriteStream(callRadarArchivePath));
});

afterAll(async () => rm(fixtureDirectory, { recursive: true, force: true }));

describe('phase-one ingestion', () => {
  it('stops before archive processing when the batch is cancelled', async () => {
    let touchedStorage = false;
    const repository = {
      isBatchCancelled: async () => true,
      failBatch: async () => { throw new Error('cancelled batches must not fail'); }
    } as unknown as Repository;
    const storage = { upload: async () => { touchedStorage = true; throw new Error('must not upload'); } } as unknown as ObjectStorage;
    const config = {
      MAX_ARCHIVE_ENTRIES: 20, MAX_INGEST_FILE_BYTES: 1024 * 1024,
      MAX_EXTRACTED_BYTES: 10 * 1024 * 1024, DEFAULT_CALL_LANGUAGE: 'en'
    } as Config;

    await ingestArchive('cancelled-batch', archivePath, config, repository, storage);
    expect(touchedStorage).toBe(false);
  });

  it('pairs by metadata audio_file and records unsupported/orphan files', async () => {
    const inspection = await inspectArchive(archivePath, 20, 1024 * 1024, 10 * 1024 * 1024, 'en');
    expect(inspection.totalEntries).toBe(5);
    expect(inspection.items.map((item) => item.status).sort()).toEqual([
      'MISSING_AUDIO', 'MISSING_METADATA', 'PAIRED', 'UNSUPPORTED_FILE'
    ]);
    const paired = inspection.items.find((item) => item.status === 'PAIRED');
    expect(paired?.audio?.fileName).toBe('DifferentCase001.mp3');
    expect(paired?.parsedMetadata?.customer.external_id).toBe('CUSTOMER-TEST-001');
  });

  it('pairs CallRadar audio and JSON across sibling archive folders', async () => {
    const inspection = await inspectArchive(callRadarArchivePath, 10, 1024 * 1024, 10 * 1024 * 1024, 'en');
    expect(inspection.items).toHaveLength(1);
    expect(inspection.items[0]).toMatchObject({
      status: 'PAIRED',
      audio: { fileName: 'audio/004860b1ab2e4c88.mp3' },
      metadata: { fileName: 'metadata/004860b1ab2e4c88.json' },
      parsedMetadata: { call_id: '004860b1ab2e4c88', channel_layout: 'STEREO' }
    });
  });

  it('uploads only the paired audio and persists all rejected names', async () => {
    const uploaded: string[] = [];
    const staged: Array<{ stem: string; status: string }> = [];
    const knownChecksums = new Set<string>();
    const duplicateFailures: string[] = [];
    const rejectedFailures: string[] = [];
    const missingPairFailures: Array<{ status: string; callId?: string }> = [];
    let completed: unknown[] = [];
    const storage = {
      upload: async (key: string, source: NodeJS.ReadableStream): Promise<StoredObject> => {
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of source) {
          const buffer = Buffer.from(chunk as Uint8Array);
          bytes += buffer.length;
          hash.update(buffer);
        }
        uploaded.push(key);
        return { bucket: 'test', key, url: `r2://test/${key}`, checksum: hash.digest('hex'), bytes };
      },
      remove: async () => undefined
    } as unknown as ObjectStorage;
    const repository = {
      isBatchCancelled: async () => false,
      setBatchInventory: async () => undefined,
      updateIngestionCounts: async () => undefined,
      recordStaging: async (_batch: string, item: { stem: string; status: string }) => { staged.push(item); },
      recordRejectedFile: async (_batch: string, item: { rejectedFile?: { fileName: string }; metadata?: { fileName: string } }) => {
        rejectedFailures.push((item.rejectedFile ?? item.metadata)!.fileName);
      },
      recordMissingPair: async (_batch: string, item: { status: string; parsedMetadata?: { call_id: string } }) => {
        missingPairFailures.push({ status: item.status, callId: item.parsedMetadata?.call_id });
      },
      recordFailedCall: async () => undefined,
      findRecordingByChecksum: async (checksum: string) => knownChecksums.has(checksum)
        ? { id: 'existing-id', external_call_id: 'CALL-TEST-001' } : undefined,
      recordDuplicateCall: async (_batch: string, item: { parsedMetadata?: { call_id: string } }) => {
        duplicateFailures.push(item.parsedMetadata!.call_id);
      },
      saveRecording: async (...args: unknown[]) => {
        knownChecksums.add((args[4] as StoredObject).checksum);
        return 'recording-id';
      },
      completeBatch: async (...args: unknown[]) => { completed = args; },
      failBatch: async (_batch: string, message: string) => { throw new Error(message); }
    } as unknown as Repository;
    const config = {
      MAX_ARCHIVE_ENTRIES: 20, MAX_INGEST_FILE_BYTES: 1024 * 1024,
      MAX_EXTRACTED_BYTES: 10 * 1024 * 1024, DEFAULT_CALL_LANGUAGE: 'en'
    } as Config;

    await ingestArchive('batch-id', archivePath, config, repository, storage);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toContain('/CALL-TEST-001/original.mp3');
    expect(staged.map((item) => item.stem).sort()).toEqual(['CALL-MISSING-AUDIO', 'Orphan', 'notes.txt']);
    expect(rejectedFailures).toEqual(['notes.txt']);
    expect(missingPairFailures).toEqual([
      { status: 'MISSING_AUDIO', callId: 'CALL-MISSING-AUDIO' },
      { status: 'MISSING_METADATA', callId: undefined }
    ]);
    // Unsupported standalone files are recorded separately and do not inflate
    // call-level failed progress.
    expect(completed).toEqual(['batch-id', 5, 1, 2, 1]);

    uploaded.length = 0;
    staged.length = 0;
    await ingestArchive('second-batch', renamedDuplicateArchivePath, config, repository, storage);
    expect(uploaded).toHaveLength(0);
    expect(staged).toEqual([expect.objectContaining({ stem: 'UNRELATED-NAME', status: 'DUPLICATE_RECORDING' })]);
    expect(duplicateFailures).toEqual(['CALL-TEST-002']);
  });

  it('saves an oversized audio as SIZE_EXCEEDED and never uploads it', async () => {
    let uploads = 0;
    const failed: Array<{ item: { status: string; parsedMetadata?: { call_id: string } }; limit: number }> = [];
    const storage = { upload: async () => { uploads += 1; throw new Error('must not upload'); } } as unknown as ObjectStorage;
    const repository = {
      isBatchCancelled: async () => false,
      setBatchInventory: async () => undefined,
      updateIngestionCounts: async () => undefined,
      recordStaging: async () => undefined,
      recordFailedCall: async (_batch: string, item: { status: string; parsedMetadata?: { call_id: string } }, limit: number) => {
        failed.push({ item, limit });
      },
      completeBatch: async () => undefined,
      failBatch: async (_batch: string, message: string) => { throw new Error(message); }
    } as unknown as Repository;
    const config = {
      MAX_ARCHIVE_ENTRIES: 20, MAX_INGEST_FILE_BYTES: 1024,
      MAX_EXTRACTED_BYTES: 10 * 1024 * 1024, DEFAULT_CALL_LANGUAGE: 'en'
    } as Config;

    await ingestArchive('oversized-batch', oversizedArchivePath, config, repository, storage);
    expect(uploads).toBe(0);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ item: { status: 'FILE_TOO_LARGE', parsedMetadata: { call_id: 'CALL-TOO-LARGE' } }, limit: 1024 });
  });

  it('accepts one copy and marks only three repeated calls as DUPLICATE_CALL', async () => {
    const known = new Map<string, string>();
    const uploaded: string[] = [];
    const duplicateFailures: Array<{ callId: string; duplicateOf: string }> = [];
    const storage = {
      upload: async (key: string, source: NodeJS.ReadableStream): Promise<StoredObject> => {
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of source) {
          const buffer = Buffer.from(chunk as Uint8Array);
          hash.update(buffer);
          bytes += buffer.length;
        }
        uploaded.push(key);
        return { bucket: 'test', key, url: `r2://test/${key}`, checksum: hash.digest('hex'), bytes };
      },
      remove: async () => undefined
    } as unknown as ObjectStorage;
    const repository = {
      isBatchCancelled: async () => false,
      setBatchInventory: async () => undefined,
      updateIngestionCounts: async () => undefined,
      recordStaging: async () => undefined,
      findRecordingByChecksum: async (checksum: string) => {
        const callId = known.get(checksum);
        return callId ? { id: 'accepted-id', external_call_id: callId } : undefined;
      },
      saveRecording: async (_batch: string, metadataValue: { call_id: string }, _filename: string,
        _format: string, stored: StoredObject) => {
        known.set(stored.checksum, metadataValue.call_id);
        return 'accepted-id';
      },
      recordDuplicateCall: async (_batch: string, item: { parsedMetadata?: { call_id: string } },
        _checksum: string, _bytes: number, duplicateOf: string) => {
        duplicateFailures.push({ callId: item.parsedMetadata!.call_id, duplicateOf });
      },
      completeBatch: async () => undefined,
      failBatch: async (_batch: string, message: string) => { throw new Error(message); }
    } as unknown as Repository;
    const config = {
      MAX_ARCHIVE_ENTRIES: 20, MAX_INGEST_FILE_BYTES: 1024 * 1024,
      MAX_EXTRACTED_BYTES: 10 * 1024 * 1024, DEFAULT_CALL_LANGUAGE: 'en'
    } as Config;

    await ingestArchive('repeated-batch', repeatedCallsArchivePath, config, repository, storage);
    expect(uploaded).toHaveLength(1);
    expect(duplicateFailures).toEqual([
      { callId: 'CALL-REPEAT-2', duplicateOf: 'CALL-REPEAT-1' },
      { callId: 'CALL-REPEAT-3', duplicateOf: 'CALL-REPEAT-1' },
      { callId: 'CALL-REPEAT-4', duplicateOf: 'CALL-REPEAT-1' }
    ]);
  });
});
