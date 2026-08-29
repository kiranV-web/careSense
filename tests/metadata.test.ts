import { describe, expect, it } from 'vitest';
import { validateMetadata } from '../src/domain/metadata.js';

const valid = {
  schema_version: '1.0',
  call_id: 'CALL-001',
  started_at: '2026-08-25T09:30:00+05:30',
  language: 'en',
  customer: { external_id: 'CUSTOMER-1', name: 'Daniel' },
  agent: { external_id: 'AGENT-1', name: 'Maya' },
  additional_data: { campaign: 'care' }
};

describe('metadata validation', () => {
  it('accepts the phase-one metadata contract and keeps additional data', () => {
    const result = validateMetadata(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.additional_data).toEqual({ campaign: 'care' });
      expect(result.data.device_model).toBe('GENERAL');
    }
  });

  it('normalizes the real session metadata shape', () => {
    const session = {
      call_id: 'CALL-001', audio_file: 'Call001.mp3', start_time_ms: 1770000010000,
      agent: { metadata: { agent_id: 'AGENT-MAYA-001', agent_name: 'Maya' }, speaker_id: 57 },
      caller: { metadata: { customer_id: 'CUSTOMER-001', first_and_last_name: 'Anjali Nair', device_model: 'LEGACY_VALUE' } },
      sid: 'call001maya0001'
    };
    const result = validateMetadata(session);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.audio_file).toBe('Call001.mp3');
      expect(result.data.customer.external_id).toBe('CUSTOMER-001');
      expect(result.data.agent.external_id).toBe('maya');
      expect(result.data.language).toBe('en');
      expect(result.data.device_model).toBe('LEGACY_VALUE');
      expect(result.data.raw_metadata).toEqual(session);
    }
  });

  it('rejects metadata without stable customer and agent identifiers', () => {
    const result = validateMetadata({ ...valid, customer: {}, agent: {} });
    expect(result.success).toBe(false);
  });

  it('normalizes CallRadar metadata with deterministic stereo channels', () => {
    const input = {
      sid: '004860b1ab2e4c88', start_time_ms: 1590860609249, end_time_ms: 1590860654497,
      agent: { speaker_id: 17, metadata: { agent_name: 'Robert' } },
      caller: { speaker_id: 44, metadata: { 'first and last name': 'Mary Smith' } },
      labels: { caller_mos: 3, agent_mos: 3 }, session: 'Little Harper Valley 2'
    };
    const result = validateMetadata(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.call_id).toBe(input.sid);
      expect(result.data.audio_file).toBe(`${input.sid}.mp3`);
      expect(result.data.customer.external_id).toBe('CALLRADAR-CUSTOMER-44');
      expect(result.data.agent.external_id).toBe('robert');
      expect(result.data).toMatchObject({ channel_layout: 'STEREO', customer_channel: 'RIGHT', agent_channel: 'LEFT',
        source_caller_speaker_id: '44', source_agent_speaker_id: '17' });
    }
  });

  it('maps agent-name variants and changing speaker IDs to one identity', () => {
    const make = (name: string, speakerId: number) => validateMetadata({
      sid: `call-${speakerId}`, start_time_ms: 1590860609249, end_time_ms: 1590860654497,
      agent: { speaker_id: speakerId, metadata: { agent_name: name } },
      caller: { speaker_id: 44, metadata: { 'first and last name': 'Mary Smith' } }
    });
    const first = make(' Mary Jane ', 1);
    const second = make('MARY JANE', 9);
    expect(first.success && first.data.agent.external_id).toBe('mary-jane');
    expect(second.success && second.data.agent.external_id).toBe('mary-jane');
    expect(first.success && first.data.source_agent_speaker_id).toBe('1');
    expect(second.success && second.data.source_agent_speaker_id).toBe('9');
  });

  it('rejects timestamps without a timezone', () => {
    expect(validateMetadata({ ...valid, started_at: '2026-08-25T09:30:00' }).success).toBe(false);
  });
});
