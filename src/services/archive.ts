import path from 'node:path';
import { createHash } from 'node:crypto';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import type { CallMetadata } from '../domain/metadata.js';
import { validateMetadata } from '../domain/metadata.js';

export type PairingStatus = 'PAIRED' | 'MISSING_AUDIO' | 'MISSING_METADATA' | 'INVALID_METADATA' |
  'DUPLICATE_AUDIO' | 'DUPLICATE_METADATA' | 'DUPLICATE_CALL_ID' | 'DUPLICATE_RECORDING' |
  'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE' | 'UPLOAD_FAILED';

export interface StagingItem {
  stem: string;
  audio?: Entry;
  metadata?: Entry;
  rejectedFile?: Entry;
  status: PairingStatus;
  errors: unknown[];
  parsedMetadata?: CallMetadata;
}

export interface ArchiveInspection {
  items: StagingItem[];
  totalEntries: number;
}

export function isSafeZipPath(filename: string): boolean {
  if (!filename || filename.includes('\\') || path.posix.isAbsolute(filename)) return false;
  return !filename.split('/').some((part) => part === '..' || part === '');
}

export function isMacOsMetadataPath(filename: string): boolean {
  const parts = filename.split('/');
  return parts.includes('__MACOSX') || parts.some((part) => part.startsWith('._'));
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('Unable to open ZIP archive'));
      else resolve(zip);
    });
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error('Unable to read ZIP entry'));
      else resolve(stream);
    });
  });
}

async function findAndConsumeEntry<T>(zipPath: string, filename: string,
  consume: (zip: ZipFile, entry: Entry) => Promise<T>): Promise<T> {
  const zip = await openZip(zipPath);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    zip.on('error', reject);
    zip.on('end', () => { if (!settled) reject(new Error(`Archive entry not found: ${filename}`)); });
    zip.on('entry', async (entry: Entry) => {
      if (entry.fileName !== filename) return zip.readEntry();
      settled = true;
      try { resolve(await consume(zip, entry)); }
      catch (error) { reject(error); }
      finally { zip.close(); }
    });
    zip.readEntry();
  });
}

async function readEntryJson(zipPath: string, filename: string, maxBytes: number): Promise<unknown> {
  return findAndConsumeEntry(zipPath, filename, async (zip, entry) => {
    const stream = await openEntry(zip, entry);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > maxBytes) throw new Error(`Metadata exceeds ${maxBytes} bytes`);
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  });
}

export async function inspectArchive(zipPath: string, maxEntries: number, maxFileBytes: number,
  maxExtractedBytes: number, defaultLanguage = 'en'): Promise<ArchiveInspection> {
  const zip = await openZip(zipPath);
  const audioByName = new Map<string, Entry[]>();
  const metadataByName = new Map<string, Entry[]>();
  const results: StagingItem[] = [];
  let entryCount = 0;
  let extractedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry: Entry) => {
      entryCount += 1;
      extractedBytes += entry.uncompressedSize;
      if (entryCount > maxEntries) return reject(new Error(`Archive exceeds ${maxEntries} entries`));
      if (extractedBytes > maxExtractedBytes) return reject(new Error(`Archive exceeds ${maxExtractedBytes} extracted bytes`));
      if (!isSafeZipPath(entry.fileName)) {
        results.push({ stem: entry.fileName, rejectedFile: entry, status: 'UNSUPPORTED_FILE', errors: ['Unsafe archive path'] });
      } else if (!entry.fileName.endsWith('/') && isMacOsMetadataPath(entry.fileName)) {
        results.push({
          stem: entry.fileName, rejectedFile: entry, status: 'UNSUPPORTED_FILE',
          errors: ['Ignored macOS archive metadata']
        });
      } else if (!entry.fileName.endsWith('/')) {
        const extension = path.posix.extname(entry.fileName).toLowerCase();
        if (extension === '.mp3' || extension === '.wav') {
          const entries = audioByName.get(entry.fileName) ?? [];
          entries.push(entry);
          audioByName.set(entry.fileName, entries);
        } else if (extension === '.json') {
          const entries = metadataByName.get(entry.fileName) ?? [];
          entries.push(entry);
          metadataByName.set(entry.fileName, entries);
        } else {
          results.push({
            stem: entry.fileName, rejectedFile: entry, status: 'UNSUPPORTED_FILE',
            errors: ['Unsupported format: only MP3, WAV and JSON metadata files are allowed']
          });
        }
      }
      zip.readEntry();
    });
    zip.readEntry();
  });

  const usedAudio = new Set<string>();
  const referencedAudio = new Set<string>();
  const callIds = new Set<string>();
  for (const [metadataFilename, metadataEntries] of metadataByName) {
    const metadataEntry = metadataEntries[0]!;
    const fallbackStem = metadataFilename.toLowerCase().endsWith('_meta.json')
      ? metadataFilename.slice(0, -'_meta.json'.length)
      : metadataFilename.slice(0, -'.json'.length);
    if (metadataEntries.length > 1) {
      results.push({ stem: fallbackStem, metadata: metadataEntry, status: 'DUPLICATE_METADATA', errors: metadataEntries.map((entry) => entry.fileName) });
      continue;
    }
    if (metadataEntry.uncompressedSize > maxFileBytes) {
      results.push({
        stem: fallbackStem, metadata: metadataEntry, status: 'FILE_TOO_LARGE',
        errors: [`Metadata is ${metadataEntry.uncompressedSize} bytes; maximum is ${maxFileBytes} bytes`]
      });
      continue;
    }
    try {
      const raw = await readEntryJson(zipPath, metadataFilename, maxFileBytes);
      const validation = validateMetadata(raw, defaultLanguage);
      if (!validation.success) {
        results.push({ stem: fallbackStem, metadata: metadataEntry, status: 'INVALID_METADATA', errors: validation.errors });
        continue;
      }
      const directory = path.posix.dirname(metadataFilename);
      const fallbackAudioNames = [`${fallbackStem}.mp3`, `${fallbackStem}.wav`];
      const referencedName = validation.data.audio_file
        ? [
            path.posix.join(directory === '.' ? '' : directory, validation.data.audio_file),
            validation.data.audio_file,
            ...[...audioByName.keys()].filter((name) => path.posix.basename(name) === validation.data.audio_file)
          ].find((name, index, candidates) => candidates.indexOf(name) === index && audioByName.has(name))
        : fallbackAudioNames.find((name) => audioByName.has(name))
          ?? [...audioByName.keys()].find((name) => fallbackAudioNames.includes(path.posix.basename(name)));
      if (!referencedName) {
        results.push({
          stem: fallbackStem, metadata: metadataEntry, parsedMetadata: validation.data,
          status: 'MISSING_AUDIO', errors: ['No audio_file reference or matching filename stem']
        });
        continue;
      }
      referencedAudio.add(referencedName);
      const audioEntries = audioByName.get(referencedName) ?? [];
      const audioEntry = audioEntries[0];
      if (!audioEntry) {
        results.push({
          stem: fallbackStem, metadata: metadataEntry, parsedMetadata: validation.data,
          status: 'MISSING_AUDIO', errors: [`Referenced audio not found: ${referencedName}`]
        });
        continue;
      }
      if (audioEntries.length > 1) {
        results.push({ stem: fallbackStem, audio: audioEntry, metadata: metadataEntry, status: 'DUPLICATE_AUDIO', errors: audioEntries.map((entry) => entry.fileName) });
        continue;
      }
      if (audioEntry.uncompressedSize > maxFileBytes) {
        referencedAudio.add(referencedName);
        results.push({
          stem: fallbackStem, audio: audioEntry, metadata: metadataEntry, parsedMetadata: validation.data,
          status: 'FILE_TOO_LARGE',
          errors: [`Audio is ${audioEntry.uncompressedSize} bytes; maximum is ${maxFileBytes} bytes`]
        });
        continue;
      }
      if (usedAudio.has(referencedName)) {
        results.push({ stem: fallbackStem, audio: audioEntry, metadata: metadataEntry, status: 'DUPLICATE_METADATA', errors: [`More than one metadata file references ${referencedName}`] });
        continue;
      }
      if (callIds.has(validation.data.call_id)) {
        results.push({ stem: fallbackStem, audio: audioEntry, metadata: metadataEntry, status: 'DUPLICATE_CALL_ID', errors: [validation.data.call_id] });
        continue;
      }
      usedAudio.add(referencedName);
      callIds.add(validation.data.call_id);
      results.push({ stem: fallbackStem, audio: audioEntry, metadata: metadataEntry, status: 'PAIRED', errors: [], parsedMetadata: validation.data });
    } catch (error) {
      results.push({ stem: fallbackStem, metadata: metadataEntry, status: 'INVALID_METADATA', errors: [error instanceof Error ? error.message : 'Invalid JSON'] });
    }
  }

  for (const [audioFilename, entries] of audioByName) {
    if (!usedAudio.has(audioFilename) && !referencedAudio.has(audioFilename)) {
      const oversized = entries[0]!.uncompressedSize > maxFileBytes;
      results.push({
        stem: audioFilename.slice(0, -path.posix.extname(audioFilename).length), audio: entries[0],
        status: entries.length > 1 ? 'DUPLICATE_AUDIO' : oversized ? 'FILE_TOO_LARGE' : 'MISSING_METADATA',
        errors: entries.length > 1 ? entries.map((entry) => entry.fileName)
          : oversized ? [`Audio is ${entries[0]!.uncompressedSize} bytes; maximum is ${maxFileBytes} bytes`] : []
      });
    }
  }
  return { items: results, totalEntries: entryCount };
}

export async function withZipEntry<T>(zipPath: string, filename: string,
  consume: (stream: NodeJS.ReadableStream) => Promise<T>): Promise<T> {
  return findAndConsumeEntry(zipPath, filename, async (zip, entry) => consume(await openEntry(zip, entry)));
}

export async function fingerprintZipEntry(zipPath: string, filename: string): Promise<{ checksum: string; bytes: number }> {
  return withZipEntry(zipPath, filename, async (stream) => {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      hash.update(buffer);
    }
    return { checksum: hash.digest('hex'), bytes };
  });
}
