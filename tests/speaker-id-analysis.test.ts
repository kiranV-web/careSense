import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepeatedSpeakerIds } from '../src/services/speaker-id-analysis.js';

describe('CallRadar speaker ID analysis', () => {
  it('reports repeated IDs by role and IDs reused across roles', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'speaker-ids-'));
    const calls = [
      { sid: 'one', agent: { speaker_id: 7, metadata: { agent_name: 'Maya' } }, caller: { speaker_id: 9, metadata: { 'first and last name': 'A' } } },
      { sid: 'two', agent: { speaker_id: 7, metadata: { agent_name: 'Maya' } }, caller: { speaker_id: 7, metadata: { 'first and last name': 'B' } } },
      { sid: 'three', agent: { speaker_id: 8, metadata: { agent_name: 'Arjun' } }, caller: { speaker_id: 7, metadata: { 'first and last name': 'B' } } }
    ];
    await Promise.all(calls.map((call) => writeFile(path.join(directory, `${call.sid}.json`), JSON.stringify(call))));

    const result = await analyzeRepeatedSpeakerIds(directory);

    expect(result.filesScanned).toBe(3);
    expect(result.repeated).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'agent', speakerId: '7', count: 2 }),
      expect.objectContaining({ role: 'caller', speakerId: '7', count: 2 })
    ]));
    expect(result.idsAppearingInBothRoles).toEqual(['7']);
  });
});
