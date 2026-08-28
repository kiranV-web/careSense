import type pg from 'pg';

function number(value: unknown): number {
  return Number(value ?? 0);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

const ETIQUETTE_RULES = [
  'greeted_customer', 'introduced_self', 'showed_empathy', 'offered_help',
  'provided_clear_guidance', 'thanked_customer', 'wished_customer_good_day'
] as const;
export type EtiquetteRule = (typeof ETIQUETTE_RULES)[number];

/** Blocks writes, DDL, and known-dangerous functions/keywords in a generated SQL string. Defense-in-depth
 *  layer 1 — the real guarantee is the read-only transaction + subquery wrap in runReadonlyQuery below. */
const FORBIDDEN_SQL_PATTERN = new RegExp(
  '\\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|call|do|execute|vacuum|reindex|' +
  'set|reset|listen|notify|unlisten|lock|prepare|deallocate|cluster|refresh|comment|security|' +
  'pg_sleep|pg_read_file|pg_write_file|pg_terminate_backend|pg_cancel_backend|dblink|lo_import|lo_export)\\b',
  'iu'
);

function assertSafeReadonlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!/^(select|with)\b/iu.test(trimmed)) {
    throw new Error('Only SELECT / WITH queries are allowed');
  }
  if (trimmed.includes(';')) {
    throw new Error('Only a single statement is allowed (no semicolons)');
  }
  if (FORBIDDEN_SQL_PATTERN.test(trimmed)) {
    throw new Error('Query contains a disallowed keyword');
  }
}

function agentQualitySelect(extraWhere?: string): string {
  return `
    SELECT a.id, a.name, a.external_id, count(c.id)::int AS call_count,
      (CASE WHEN count(e.call_recording_id) = 0 THEN NULL ELSE round(avg(
         ((e.greeted_customer::int + e.introduced_self::int + coalesce(e.showed_empathy::int,0) +
           e.offered_help::int + e.provided_clear_guidance::int + e.thanked_customer::int +
           e.wished_customer_good_day::int)::numeric / (6 + e.showed_empathy_applicable::int)) * 100
       )) END) AS quality_score_percent,
      round((count(c.id) FILTER (WHERE c.resolution_status IN ('RESOLVED','RESOLVED_BUT_IMPROVE_QUALITY'))::numeric
        / NULLIF(count(c.id), 0)) * 100) AS resolution_rate_percent
    FROM agents a
    JOIN call_recordings c ON c.agent_id = a.id AND c.started_at BETWEEN $1 AND $2
    LEFT JOIN call_evaluations e ON e.call_recording_id = c.id
    ${extraWhere ?? ''}`;
}

function mapAgentQualityRow(row: Record<string, unknown>) {
  return {
    agent_id: String(row.id), agent_name: String(row.name ?? row.external_id),
    call_count: number(row.call_count),
    quality_score_percent: nullableNumber(row.quality_score_percent),
    resolution_rate_percent: nullableNumber(row.resolution_rate_percent)
  };
}

export class ChatRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getCallVolume(dateFrom: string, dateTo: string, groupBy: 'day' | 'week' | 'month'): Promise<
    Array<{ bucket: string; call_count: number }>
  > {
    const result = await this.pool.query(
      `SELECT date_trunc($3, started_at)::date AS bucket, count(*)::int AS call_count
       FROM call_recordings WHERE started_at BETWEEN $1 AND $2
       GROUP BY 1 ORDER BY 1`,
      [dateFrom, dateTo, groupBy]
    );
    return result.rows.map((row) => ({ bucket: String(row.bucket), call_count: number(row.call_count) }));
  }

  async rankAgentsByQuality(dateFrom: string, dateTo: string, order: 'best' | 'worst',
    minCallCount: number, limit: number): Promise<ReturnType<typeof mapAgentQualityRow>[]> {
    const direction = order === 'best' ? 'DESC' : 'ASC';
    const result = await this.pool.query(
      `${agentQualitySelect()}
       GROUP BY a.id, a.name, a.external_id
       HAVING count(c.id) >= $3
       ORDER BY quality_score_percent ${direction} NULLS LAST, call_count DESC
       LIMIT $4`,
      [dateFrom, dateTo, minCallCount, limit]
    );
    return result.rows.map(mapAgentQualityRow);
  }

  async compareAgents(agentNames: string[], dateFrom: string, dateTo: string): Promise<ReturnType<typeof mapAgentQualityRow>[]> {
    const result = await this.pool.query(
      `${agentQualitySelect('WHERE a.name = ANY($3::text[]) OR a.external_id = ANY($3::text[])')}
       GROUP BY a.id, a.name, a.external_id`,
      [dateFrom, dateTo, agentNames]
    );
    return result.rows.map(mapAgentQualityRow);
  }

  async listAgents(limit: number): Promise<Array<{ agent_id: string; agent_name: string; call_count: number }>> {
    const result = await this.pool.query(
      `SELECT a.id, a.name, a.external_id, count(c.id)::int AS call_count
       FROM agents a LEFT JOIN call_recordings c ON c.agent_id = a.id
       GROUP BY a.id, a.name, a.external_id ORDER BY call_count DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      agent_id: String(row.id), agent_name: String(row.name ?? row.external_id), call_count: number(row.call_count)
    }));
  }

  async getAgentEtiquetteBreakdown(agentName: string, dateFrom: string, dateTo: string): Promise<
    Array<{ rule: EtiquetteRule; fail_count: number; total: number; fail_rate_percent: number }>
  > {
    const result = await this.pool.query(
      `SELECT r.rule, count(*) FILTER (WHERE NOT r.passed)::int AS fail_count, count(*)::int AS total
       FROM call_recordings c
       JOIN agents a ON a.id = c.agent_id
       JOIN call_evaluations e ON e.call_recording_id = c.id,
       LATERAL (VALUES
         ('greeted_customer', e.greeted_customer), ('introduced_self', e.introduced_self),
         ('showed_empathy', e.showed_empathy), ('offered_help', e.offered_help),
         ('provided_clear_guidance', e.provided_clear_guidance), ('thanked_customer', e.thanked_customer),
         ('wished_customer_good_day', e.wished_customer_good_day)
       ) AS r(rule, passed)
       WHERE c.started_at BETWEEN $2 AND $3 AND (a.name ILIKE '%'||$1||'%' OR a.external_id = $1)
         AND r.passed IS NOT NULL
       GROUP BY r.rule ORDER BY fail_count DESC`,
      [agentName, dateFrom, dateTo]
    );
    return result.rows.map((row) => {
      const failCount = number(row.fail_count);
      const total = number(row.total);
      return { rule: row.rule as EtiquetteRule, fail_count: failCount, total,
        fail_rate_percent: total === 0 ? 0 : Math.round((failCount / total) * 100) };
    });
  }

  async getTeamEtiquetteFailureRates(dateFrom: string, dateTo: string): Promise<
    Array<{ rule: EtiquetteRule; fail_count: number; total: number; fail_rate_percent: number }>
  > {
    const result = await this.pool.query(
      `SELECT r.rule, count(*) FILTER (WHERE NOT r.passed)::int AS fail_count, count(*)::int AS total
       FROM call_recordings c
       JOIN call_evaluations e ON e.call_recording_id = c.id,
       LATERAL (VALUES
         ('greeted_customer', e.greeted_customer), ('introduced_self', e.introduced_self),
         ('showed_empathy', e.showed_empathy), ('offered_help', e.offered_help),
         ('provided_clear_guidance', e.provided_clear_guidance), ('thanked_customer', e.thanked_customer),
         ('wished_customer_good_day', e.wished_customer_good_day)
       ) AS r(rule, passed)
       WHERE c.started_at BETWEEN $1 AND $2 AND r.passed IS NOT NULL
       GROUP BY r.rule ORDER BY fail_count DESC`,
      [dateFrom, dateTo]
    );
    return result.rows.map((row) => {
      const failCount = number(row.fail_count);
      const total = number(row.total);
      return {
        rule: row.rule as EtiquetteRule, fail_count: failCount, total,
        fail_rate_percent: total === 0 ? 0 : Math.round((failCount / total) * 100)
      };
    });
  }

  async getIssueCategoryBreakdown(dateFrom: string, dateTo: string, limit: number): Promise<
    Array<{ issue_category: string; call_count: number }>
  > {
    const result = await this.pool.query(
      `SELECT issue_category, count(*)::int AS call_count
       FROM call_recordings WHERE started_at BETWEEN $1 AND $2 AND issue_category IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC LIMIT $3`,
      [dateFrom, dateTo, limit]
    );
    return result.rows.map((row) => ({ issue_category: String(row.issue_category), call_count: number(row.call_count) }));
  }

  async getResolutionBreakdown(dateFrom: string, dateTo: string): Promise<
    Array<{ resolution_status: string; call_count: number; percent: number }>
  > {
    const result = await this.pool.query(
      `SELECT resolution_status, count(*)::int AS call_count,
         round(count(*)::numeric / NULLIF(sum(count(*)) OVER (), 0) * 100) AS percent
       FROM call_recordings WHERE started_at BETWEEN $1 AND $2
       GROUP BY resolution_status ORDER BY call_count DESC`,
      [dateFrom, dateTo]
    );
    return result.rows.map((row) => ({
      resolution_status: String(row.resolution_status), call_count: number(row.call_count),
      percent: number(row.percent)
    }));
  }

  async getBankingProductBreakdown(dateFrom: string, dateTo: string, limit: number): Promise<
    Array<{ banking_product: string; call_count: number }>
  > {
    const result = await this.pool.query(
      `SELECT coalesce(nullif(btrim(banking_product), ''), 'GENERAL_BANKING') AS banking_product, count(*)::int AS call_count
       FROM call_recordings WHERE started_at BETWEEN $1 AND $2
       GROUP BY 1 ORDER BY 2 DESC LIMIT $3`,
      [dateFrom, dateTo, limit]
    );
    return result.rows.map((row) => ({ banking_product: String(row.banking_product), call_count: number(row.call_count) }));
  }

  async getCallDurationStats(dateFrom: string, dateTo: string, agentName: string | undefined): Promise<{
    call_count: number; avg_seconds: number | null; min_seconds: number | null; max_seconds: number | null;
    median_seconds: number | null;
  }> {
    const result = await this.pool.query(
      `SELECT count(t.duration_seconds)::int AS call_count,
         round(avg(t.duration_seconds)) AS avg_seconds, min(t.duration_seconds) AS min_seconds,
         max(t.duration_seconds) AS max_seconds,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY t.duration_seconds) AS median_seconds
       FROM call_recordings c
       JOIN agents a ON a.id = c.agent_id
       LEFT JOIN transcripts t ON t.call_recording_id = c.id
       WHERE c.started_at BETWEEN $1 AND $2 AND ($3::text IS NULL OR a.name ILIKE '%'||$3||'%' OR a.external_id = $3)`,
      [dateFrom, dateTo, agentName ?? null]
    );
    const row = result.rows[0] as Record<string, unknown>;
    return {
      call_count: number(row.call_count), avg_seconds: nullableNumber(row.avg_seconds),
      min_seconds: nullableNumber(row.min_seconds), max_seconds: nullableNumber(row.max_seconds),
      median_seconds: nullableNumber(row.median_seconds)
    };
  }

  async getFlaggedCallCounts(dateFrom: string, dateTo: string): Promise<{
    total: number; rude: number; escalated: number; recurring: number; dropped: number;
    urgency: Array<{ urgency_level: string; call_count: number }>;
  }> {
    const [flags, urgency] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS total,
           count(*) FILTER (WHERE 'RUDE' = ANY(call_statuses))::int AS rude,
           count(*) FILTER (WHERE 'ESCALATED' = ANY(call_statuses))::int AS escalated,
           count(*) FILTER (WHERE 'RECURRING' = ANY(call_statuses))::int AS recurring,
           count(*) FILTER (WHERE resolution_status = 'DROPPED')::int AS dropped
         FROM call_recordings WHERE started_at BETWEEN $1 AND $2`,
        [dateFrom, dateTo]
      ),
      this.pool.query(
        `SELECT urgency_level, count(*)::int AS call_count FROM call_recordings
         WHERE started_at BETWEEN $1 AND $2 AND urgency_level IS NOT NULL
         GROUP BY urgency_level ORDER BY call_count DESC`,
        [dateFrom, dateTo]
      )
    ]);
    const row = flags.rows[0] as Record<string, unknown>;
    return {
      total: number(row.total), rude: number(row.rude), escalated: number(row.escalated),
      recurring: number(row.recurring), dropped: number(row.dropped),
      urgency: urgency.rows.map((r) => ({ urgency_level: String(r.urgency_level), call_count: number(r.call_count) }))
    };
  }

  async getCustomerSentimentBreakdown(dateFrom: string, dateTo: string, speakerRole: 'AGENT' | 'CUSTOMER'): Promise<
    Array<{ textual_tone: string; segment_count: number; percent: number }>
  > {
    const result = await this.pool.query(
      `SELECT s.textual_tone, count(*)::int AS segment_count,
         round(count(*)::numeric / NULLIF(sum(count(*)) OVER (), 0) * 100) AS percent
       FROM transcript_segments s JOIN call_recordings c ON c.id = s.call_recording_id
       WHERE c.started_at BETWEEN $1 AND $2 AND s.speaker_role = $3 AND s.textual_tone IS NOT NULL
       GROUP BY s.textual_tone ORDER BY segment_count DESC`,
      [dateFrom, dateTo, speakerRole]
    );
    return result.rows.map((row) => ({
      textual_tone: String(row.textual_tone), segment_count: number(row.segment_count), percent: number(row.percent)
    }));
  }

  async getRepeatCustomers(dateFrom: string, dateTo: string, minCalls: number, limit: number): Promise<
    Array<{ customer_name: string; call_count: number }>
  > {
    const result = await this.pool.query(
      `SELECT coalesce(cu.name, cu.external_id) AS customer_name, count(c.id)::int AS call_count
       FROM customers cu JOIN call_recordings c ON c.customer_id = cu.id
       WHERE c.started_at BETWEEN $1 AND $2
       GROUP BY cu.id, cu.name, cu.external_id HAVING count(c.id) >= $3
       ORDER BY call_count DESC LIMIT $4`,
      [dateFrom, dateTo, minCalls, limit]
    );
    return result.rows.map((row) => ({ customer_name: String(row.customer_name), call_count: number(row.call_count) }));
  }

  async getManagerAlertStatus(dateFrom: string, dateTo: string): Promise<
    Array<{ status: string; urgency_level: string; alert_count: number }>
  > {
    const result = await this.pool.query(
      `SELECT ma.status, ma.urgency_level, count(*)::int AS alert_count
       FROM manager_alerts ma JOIN call_recordings c ON c.id = ma.call_recording_id
       WHERE c.started_at BETWEEN $1 AND $2
       GROUP BY ma.status, ma.urgency_level ORDER BY alert_count DESC`,
      [dateFrom, dateTo]
    );
    return result.rows.map((row) => ({
      status: String(row.status), urgency_level: String(row.urgency_level), alert_count: number(row.alert_count)
    }));
  }

  async getCallEvidence(filters: {
    agentName?: string; resolutionStatus?: string; issueCategory?: string;
    etiquetteRuleFailed?: EtiquetteRule; dateFrom?: string; dateTo?: string;
  }, limit: number): Promise<Array<{
    external_call_id: string; title: string | null; short_description: string | null;
    resolution_status: string; quality_feedback: string | null; agent_name: string;
  }>> {
    const result = await this.pool.query(
      `SELECT c.external_call_id, c.title, c.short_description, c.resolution_status,
         c.quality_feedback, a.name AS agent_name
       FROM call_recordings c
       JOIN agents a ON a.id = c.agent_id
       LEFT JOIN call_evaluations e ON e.call_recording_id = c.id
       WHERE ($1::text IS NULL OR a.name ILIKE '%'||$1||'%' OR a.external_id = $1)
         AND ($2::text IS NULL OR c.resolution_status = $2)
         AND ($3::text IS NULL OR c.issue_category = $3)
         AND ($4::text IS NULL OR (to_jsonb(e) ->> $4)::boolean = false)
         AND ($5::timestamptz IS NULL OR c.started_at >= $5)
         AND ($6::timestamptz IS NULL OR c.started_at <= $6)
       ORDER BY c.started_at DESC LIMIT $7`,
      [filters.agentName ?? null, filters.resolutionStatus ?? null, filters.issueCategory ?? null,
        filters.etiquetteRuleFailed ?? null, filters.dateFrom ?? null, filters.dateTo ?? null, limit]
    );
    return result.rows.map((row) => ({
      external_call_id: String(row.external_call_id), title: row.title ?? null,
      short_description: row.short_description ?? null, resolution_status: String(row.resolution_status),
      quality_feedback: row.quality_feedback ?? null, agent_name: String(row.agent_name)
    }));
  }

  async getRecurringVerdicts(issueCategory: string | undefined, limit: number): Promise<Array<{
    group_title: string; summary: string; verdict: string; recommended_action: string; outcome_status: string;
  }>> {
    const result = await this.pool.query(
      `SELECT group_title, summary, verdict, recommended_action, outcome_status
       FROM recurring_call_groups WHERE ($1::text IS NULL OR issue_category = $1)
       ORDER BY latest_call_at DESC LIMIT $2`,
      [issueCategory ?? null, limit]
    );
    return result.rows.map((row) => ({
      group_title: String(row.group_title), summary: String(row.summary), verdict: String(row.verdict),
      recommended_action: String(row.recommended_action), outcome_status: String(row.outcome_status)
    }));
  }

  /**
   * Escape hatch for questions the named functions above don't cover. Safety is layered:
   * 1. Text-level rejection of writes/DDL/dangerous functions/multiple statements (assertSafeReadonlySql).
   * 2. The query is only ever run wrapped as `SELECT * FROM (<sql>) AS _q LIMIT n` — Postgres will fail to
   *    parse anything that isn't a single valid SELECT-shaped statement in that position, so even a
   *    validation gap can't smuggle in DDL/DML.
   * 3. Runs inside an explicit `SET TRANSACTION READ ONLY` transaction that is always rolled back and never
   *    committed — enforced by Postgres itself, not by application logic, so it holds even if 1 and 2 don't.
   * 4. A short statement_timeout bounds worst-case query cost.
   */
  async runReadonlyQuery(sql: string, maxRows: number): Promise<{ rows: Record<string, unknown>[]; row_count: number }> {
    assertSafeReadonlySql(sql);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const result = await client.query(`SELECT * FROM (${sql}) AS _q LIMIT $1`, [maxRows]);
      return { rows: result.rows as Record<string, unknown>[], row_count: result.rowCount ?? result.rows.length };
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
}
