import type pg from 'pg';

export const CALL_ETIQUETTE_RULES = [
  'greeted_customer',
  'introduced_self',
  'showed_empathy',
  'offered_help',
  'provided_clear_guidance',
  'thanked_customer',
  'wished_customer_good_day'
] as const;

export interface ApplicationSettings {
  recurring_lookback_days: number;
  ideal_call_duration_seconds: number;
  call_etiquette: string[];
  updated_at: Date;
}

export interface ApplicationSettingsUpdate {
  recurring_lookback_days?: number;
  ideal_call_duration_seconds?: number;
  call_etiquette?: string[];
}

export class SettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(): Promise<ApplicationSettings> {
    const result = await this.pool.query<ApplicationSettings>(
      `SELECT recurring_lookback_days,ideal_call_duration_seconds,call_etiquette,updated_at
       FROM application_settings WHERE id=1`
    );
    if (!result.rows[0]) throw new Error('Application settings row is missing');
    return result.rows[0];
  }

  async update(input: ApplicationSettingsUpdate): Promise<ApplicationSettings> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query<ApplicationSettings>(
        `SELECT recurring_lookback_days,ideal_call_duration_seconds,call_etiquette,updated_at
         FROM application_settings WHERE id=1 FOR UPDATE`
      );
      if (!before.rows[0]) throw new Error('Application settings row is missing');
      const result = await client.query<ApplicationSettings>(
        `UPDATE application_settings SET
           recurring_lookback_days=coalesce($1,recurring_lookback_days),
           ideal_call_duration_seconds=coalesce($2,ideal_call_duration_seconds),
           call_etiquette=coalesce($3::text[],call_etiquette),updated_at=now()
         WHERE id=1
         RETURNING recurring_lookback_days,ideal_call_duration_seconds,call_etiquette,updated_at`,
        [input.recurring_lookback_days ?? null, input.ideal_call_duration_seconds ?? null,
          input.call_etiquette ?? null]
      );
      if (input.recurring_lookback_days !== undefined &&
          input.recurring_lookback_days !== before.rows[0].recurring_lookback_days) {
        await this.requeueRecurrence(client);
      }
      await client.query('COMMIT');
      return result.rows[0]!;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async requeueRecurrence(client: pg.PoolClient): Promise<void> {
    await client.query('DELETE FROM recurring_call_groups');
    await client.query(
      `UPDATE call_recordings SET call_statuses=array_remove(call_statuses,'RECURRING'),
         recurrence_status=CASE WHEN analysis_status='COMPLETED' THEN 'QUEUED' ELSE recurrence_status END,
         recurrence_failure_reason=NULL,
         recurrence_completed_at=CASE WHEN analysis_status='COMPLETED' THEN NULL ELSE recurrence_completed_at END,
         updated_at=now()`
    );
    await client.query(
      `INSERT INTO recurrence_jobs (batch_id,customer_id,status)
       SELECT DISTINCT batch_id,customer_id,'PENDING' FROM call_recordings WHERE analysis_status='COMPLETED'
       ON CONFLICT (batch_id,customer_id) DO UPDATE
       SET status='PENDING',attempt_count=0,last_error=NULL,dispatched_at=NULL,started_at=NULL,
         completed_at=NULL,updated_at=now()`
    );
    await client.query(
      `UPDATE upload_batches b SET processing_state='LINKING_RECURRING_CALLS',completed_at=NULL,updated_at=now()
       WHERE EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id
         AND c.analysis_status='COMPLETED' AND c.recurrence_status='QUEUED')`
    );
  }
}
