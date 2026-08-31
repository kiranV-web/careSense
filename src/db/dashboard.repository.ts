import type pg from 'pg';
import type { TeamCoachingSignals } from '../services/coachingInsight.js';

export interface DashboardPeriod {
  date: string;
  timezone: string;
}

export interface TeamPeriod extends DashboardPeriod {
  dateFrom: string;
  dateTo: string;
}

function number(value: unknown): number {
  return Number(value ?? 0);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function metric(count: number, denominator: number) {
  return { count, percent: denominator === 0 ? 0 : Math.round((count / denominator) * 10_000) / 100 };
}

export class DashboardRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getHome(period: DashboardPeriod): Promise<Record<string, unknown>> {
    const parameters = [period.date, period.timezone];
    const [metricsResult, weekResult, productsResult, issuesResult, flaggedResult, settingsResult] = await Promise.all([
      this.pool.query(
        `WITH bounds AS (
           SELECT $1::date AS selected_date,
             (($1::date - 1)::timestamp AT TIME ZONE $2) AS yesterday_start,
             ($1::date::timestamp AT TIME ZONE $2) AS today_start,
             (($1::date + 1)::timestamp AT TIME ZONE $2) AS today_end
         )
         SELECT
           count(c.id) FILTER (WHERE c.started_at>=b.today_start AND c.started_at<b.today_end)::integer AS calls_today,
           count(c.id) FILTER (WHERE c.started_at>=b.yesterday_start AND c.started_at<b.today_start)::integer AS calls_yesterday,
           avg(t.duration_seconds) FILTER (WHERE c.started_at>=b.today_start AND c.started_at<b.today_end) AS avg_duration_seconds,
           count(c.id) FILTER (WHERE c.started_at>=b.today_start AND c.started_at<b.today_end
             AND c.resolution_status IN ('RESOLVED','RESOLVED_BUT_IMPROVE_QUALITY'))::integer AS resolved_count,
           count(c.id) FILTER (WHERE c.started_at>=b.today_start AND c.started_at<b.today_end
             AND 'RECURRING'=ANY(c.call_statuses))::integer AS recurring_count,
           count(c.id) FILTER (WHERE c.started_at>=b.today_start AND c.started_at<b.today_end
             AND 'RUDE'=ANY(c.call_statuses))::integer AS rude_count,
           count(c.id) FILTER (WHERE c.started_at>=b.today_start AND c.started_at<b.today_end
             AND c.resolution_status='UNRESOLVED')::integer AS unresolved_count,
           count(c.id) FILTER (WHERE c.started_at>=b.today_start AND c.started_at<b.today_end
             AND c.needs_manager_attention=true)::integer AS attention_count
         FROM bounds b LEFT JOIN call_recordings c
           ON c.started_at>=b.yesterday_start AND c.started_at<b.today_end
         LEFT JOIN transcripts t ON t.call_recording_id=c.id
         GROUP BY b.selected_date`, parameters
      ),
      this.pool.query(
        `WITH selected AS (
           SELECT $1::date - (extract(isodow FROM $1::date)::integer - 1) AS week_start
         ), days AS (
           SELECT generate_series(s.week_start,s.week_start+6,interval '1 day')::date AS day FROM selected s
         ), counts AS (
           SELECT (started_at AT TIME ZONE $2)::date AS day,count(*)::integer AS count
           FROM call_recordings,selected
           WHERE (started_at AT TIME ZONE $2)::date BETWEEN selected.week_start AND selected.week_start+6
           GROUP BY 1
         )
         SELECT to_char(d.day,'YYYY-MM-DD') AS day,to_char(d.day,'Dy') AS day_name,
           coalesce(c.count,0)::integer AS count
         FROM days d LEFT JOIN counts c USING(day) ORDER BY d.day`, parameters
      ),
      this.pool.query(
        `WITH ranked AS (
           SELECT coalesce(nullif(btrim(banking_product),''),'GENERAL_BANKING') AS banking_product,count(*)::integer AS call_count
           FROM call_recordings
           WHERE (started_at AT TIME ZONE $2)::date=$1::date
           GROUP BY 1
         )
         SELECT banking_product,call_count,
           CASE WHEN max(call_count) OVER()=0 THEN 0
             ELSE round(call_count::numeric/max(call_count) OVER()*100,2) END AS percent_of_highest
         FROM ranked ORDER BY call_count DESC,banking_product LIMIT 10`, parameters
      ),
      this.pool.query(
        `WITH ranked AS (
           SELECT coalesce(issue_category,'GENERAL') AS issue_category,count(*)::integer AS call_count
           FROM call_recordings
           WHERE (started_at AT TIME ZONE $2)::date=$1::date
           GROUP BY 1
         )
         SELECT issue_category,call_count,
           CASE WHEN max(call_count) OVER()=0 THEN 0
             ELSE round(call_count::numeric/max(call_count) OVER()*100,2) END AS percent_of_highest
         FROM ranked ORDER BY call_count DESC,issue_category LIMIT 10`, parameters
      ),
      this.pool.query(
        `SELECT c.id,c.external_call_id,c.started_at,c.title,c.short_description,
           coalesce(nullif(btrim(c.device_model),''),'GENERAL') AS device_model,
           coalesce(nullif(btrim(c.banking_product),''),'GENERAL_BANKING') AS banking_product,
           c.issue_category,c.resolution_status,c.call_statuses,c.needs_manager_attention,c.urgency_level,
           t.duration_seconds,cu.external_id AS customer_external_id,cu.name AS customer_name,
           a.id AS agent_id,a.external_id AS agent_external_id,a.name AS agent_name
         FROM call_recordings c
         JOIN customers cu ON cu.id=c.customer_id JOIN agents a ON a.id=c.agent_id
         LEFT JOIN transcripts t ON t.call_recording_id=c.id
         WHERE (c.started_at AT TIME ZONE $2)::date=$1::date
           AND ('RECURRING'=ANY(c.call_statuses) OR 'RUDE'=ANY(c.call_statuses))
         ORDER BY c.needs_manager_attention DESC,c.urgency_level DESC,c.started_at DESC
         LIMIT 100`, parameters
      ),
      this.pool.query('SELECT ideal_call_duration_seconds FROM application_settings WHERE id=1')
    ]);

    const row = metricsResult.rows[0] as Record<string, unknown> | undefined;
    const today = number(row?.calls_today);
    const yesterday = number(row?.calls_yesterday);
    const resolved = number(row?.resolved_count);
    const recurring = number(row?.recurring_count);
    const rude = number(row?.rude_count);
    const averageDuration = row?.avg_duration_seconds === null || row?.avg_duration_seconds === undefined
      ? null : Math.round(number(row.avg_duration_seconds));
    const idealDuration = number(settingsResult.rows[0]?.ideal_call_duration_seconds);
    const week = weekResult.rows.map((item: Record<string, unknown>) => ({
      date: item.day, day: item.day_name, count: number(item.count)
    }));
    const peak = week.reduce<{ date: unknown; day: unknown; count: number } | null>((current, item) =>
      current === null || item.count > current.count ? item : current, null);

    return {
      period: {
        date: period.date, timezone: period.timezone,
        week_start: week[0]?.date ?? null, week_end: week[6]?.date ?? null
      },
      calls_today: {
        count: today, yesterday_count: yesterday,
        delta_percent: yesterday === 0 ? null : Math.round(((today - yesterday) / yesterday) * 10_000) / 100
      },
      average_duration: {
        seconds: averageDuration,
        target_seconds: idealDuration,
        difference_seconds: averageDuration === null ? null : averageDuration - idealDuration
      },
      rates: {
        denominator: today,
        resolved: metric(resolved, today), recurring: metric(recurring, today), rude: metric(rude, today)
      },
      attention: {
        total: number(row?.attention_count), recurring, rude, unresolved: number(row?.unresolved_count)
      },
      weekly_calls: {
        total: week.reduce((sum, item) => sum + item.count, 0),
        peak_day: peak?.date ?? null, days: week
      },
      banking_products: productsResult.rows.map((item: Record<string, unknown>) => ({
        banking_product: item.banking_product, call_count: number(item.call_count),
        percent_of_highest: number(item.percent_of_highest)
      })),
      issues: issuesResult.rows.map((item: Record<string, unknown>) => ({
        issue_category: item.issue_category, call_count: number(item.call_count),
        percent_of_highest: number(item.percent_of_highest)
      })),
      flagged_calls: flaggedResult.rows.map((item: Record<string, unknown>) => ({
        ...item, status: resolutionStatusValue(item.resolution_status),
        status_label: resolutionStatusLabel(item.resolution_status), duration_seconds: nullableNumber(item.duration_seconds)
      }))
    };
  }

  async getTeam(period: TeamPeriod): Promise<Record<string, unknown>> {
    const [result, activityResult, qualityAgentsResult] = await Promise.all([this.pool.query(
      `SELECT a.id,a.external_id,a.name,a.speaker_ids_seen,
         count(c.id)::integer AS call_count,
         count(c.id) FILTER (WHERE c.resolution_status IN ('RESOLVED','RESOLVED_BUT_IMPROVE_QUALITY'))::integer AS resolved_count,
         count(c.id) FILTER (WHERE c.resolution_status='UNRESOLVED')::integer AS unresolved_count,
         count(c.id) FILTER (WHERE c.resolution_status='DROPPED')::integer AS dropped_count,
         count(c.id) FILTER (WHERE c.resolution_status='ESCALATED')::integer AS escalated_count,
         count(c.id) FILTER (WHERE c.needs_manager_attention=true)::integer AS attention_count,
         avg(t.duration_seconds) AS average_duration_seconds,
         coalesce(sum(t.duration_seconds),0) AS total_duration_seconds,
         avg(CASE WHEN e.id IS NULL THEN NULL ELSE
           ((e.greeted_customer::integer + e.introduced_self::integer + coalesce(e.showed_empathy::integer,0) +
             e.offered_help::integer + e.provided_clear_guidance::integer + e.thanked_customer::integer +
             e.wished_customer_good_day::integer)::numeric /
             (6 + e.showed_empathy_applicable::integer)) * 100 END) AS quality_score_percent
       FROM agents a LEFT JOIN call_recordings c ON c.agent_id=a.id
         AND (c.started_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
       LEFT JOIN transcripts t ON t.call_recording_id=c.id
       LEFT JOIN call_evaluations e ON e.call_recording_id=c.id
       GROUP BY a.id,a.external_id,a.name,a.speaker_ids_seen
       ORDER BY call_count DESC,coalesce(a.name,a.external_id)`, [period.dateFrom, period.dateTo, period.timezone]),
      this.pool.query(
        `SELECT c.id,c.agent_id,c.external_call_id,c.started_at,c.resolution_status,
           c.call_statuses,c.needs_manager_attention
         FROM call_recordings c
         WHERE (c.started_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
         ORDER BY c.started_at,c.id`, [period.dateFrom, period.dateTo, period.timezone]
      ),
      this.pool.query(
        `SELECT coalesce(nullif(btrim(c.source_agent_speaker_id),''),a.external_id) AS id,
           coalesce(array_agg(DISTINCT coalesce(nullif(btrim(a.name),''),a.external_id)
             ORDER BY coalesce(nullif(btrim(a.name),''),a.external_id)),'{}'::text[]) AS logged_names,
           count(c.id)::integer AS call_count
         FROM call_recordings c JOIN agents a ON a.id=c.agent_id
         WHERE (c.started_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
         GROUP BY coalesce(nullif(btrim(c.source_agent_speaker_id),''),a.external_id)
         ORDER BY call_count DESC,id`, [period.dateFrom, period.dateTo, period.timezone]
      )
    ]);
    const activity = activityResult.rows.map((row: Record<string, unknown>) => ({
      ...row,
      status: resolutionStatusValue(row.resolution_status), status_label: resolutionStatusLabel(row.resolution_status),
      call_statuses: Array.isArray(row.call_statuses) ? row.call_statuses : []
    }));
    return {
      period,
      totals: {
        agents: result.rows.length,
        calls: result.rows.reduce((sum: number, row: Record<string, unknown>) => sum + number(row.call_count), 0),
        resolved: result.rows.reduce((sum: number, row: Record<string, unknown>) => sum + number(row.resolved_count), 0)
      },
      activity,
      quality_agents: qualityAgentsResult.rows.map((row: Record<string, unknown>) => ({
        id: String(row.id), logged_names: Array.isArray(row.logged_names) ? row.logged_names : [],
        call_count: number(row.call_count)
      })),
      agents: result.rows.map((row: Record<string, unknown>) => {
        const calls = number(row.call_count);
        const resolved = number(row.resolved_count);
        return {
          ...row,
          call_count: calls, resolved_count: resolved,
          unresolved_count: number(row.unresolved_count), dropped_count: number(row.dropped_count),
          escalated_count: number(row.escalated_count), attention_count: number(row.attention_count),
          average_duration_seconds: row.average_duration_seconds === null || row.average_duration_seconds === undefined
            ? null : Math.round(number(row.average_duration_seconds)),
          total_duration_seconds: Math.round(number(row.total_duration_seconds)),
          quality_score_percent: row.quality_score_percent === null || row.quality_score_percent === undefined
            ? null : Math.round(number(row.quality_score_percent)),
          resolution_rate_percent: calls === 0 ? 0 : Math.round((resolved / calls) * 10_000) / 100
        };
      })
    };
  }

  async getAgentCalls(agentId: string, period: DashboardPeriod, page: number, pageSize: number) {
    const agentResult = await this.pool.query(
      'SELECT id,external_id,name FROM agents WHERE id::text=$1 OR external_id=$1', [agentId]
    );
    if (!agentResult.rows[0]) return undefined;
    const agent = agentResult.rows[0] as Record<string, unknown>;
    const offset = (page - 1) * pageSize;
    const result = await this.pool.query(
      `SELECT c.id,c.external_call_id,c.started_at,c.title,c.short_description,
         coalesce(nullif(btrim(c.device_model),''),'GENERAL') AS device_model,
         coalesce(nullif(btrim(c.banking_product),''),'GENERAL_BANKING') AS banking_product,
         c.issue_category,c.issue_cause,c.resolution_status,c.call_statuses,
         c.needs_manager_attention,c.urgency_level,
         CASE
           WHEN c.transcription_status='FAILED' OR c.analysis_status='FAILED' OR c.recurrence_status='FAILED' THEN 'FAILED'
           WHEN c.transcription_status IN ('PENDING','QUEUED','TRANSCRIBING') THEN 'TRANSCRIBING'
           WHEN c.analysis_status IN ('PENDING','QUEUED','ANALYZING') THEN 'ANALYZING'
           WHEN c.recurrence_status IN ('PENDING','QUEUED','LINKING') THEN 'LINKING_RECURRING_CALLS'
           ELSE 'COMPLETED' END AS processing_state,
         t.duration_seconds,cu.external_id AS customer_external_id,cu.name AS customer_name,
         CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object(
           'greeted_customer',e.greeted_customer,'introduced_self',e.introduced_self,
           'showed_empathy',e.showed_empathy,'showed_empathy_applicable',e.showed_empathy_applicable,
           'showed_empathy_reason',e.showed_empathy_reason,'offered_help',e.offered_help,
           'provided_clear_guidance',e.provided_clear_guidance,'thanked_customer',e.thanked_customer,
           'wished_customer_good_day',e.wished_customer_good_day) END AS rules,
         count(*) OVER()::integer AS total_count,
         count(*) FILTER (WHERE c.resolution_status IN ('RESOLVED','RESOLVED_BUT_IMPROVE_QUALITY')) OVER()::integer AS total_resolved_count
       FROM call_recordings c JOIN customers cu ON cu.id=c.customer_id
       LEFT JOIN transcripts t ON t.call_recording_id=c.id
       LEFT JOIN call_evaluations e ON e.call_recording_id=c.id
       WHERE c.agent_id=$1 AND (c.started_at AT TIME ZONE $3)::date=$2::date
       ORDER BY c.started_at DESC,c.id LIMIT $4 OFFSET $5`,
      [agent.id, period.date, period.timezone, pageSize, offset]
    );
    const total = number(result.rows[0]?.total_count);
    const resolved = number(result.rows[0]?.total_resolved_count);
    const items = result.rows.map((row: Record<string, unknown>) => {
      const { total_count: _total, total_resolved_count: _resolved, ...item } = row;
      return { ...item, status: resolutionStatusValue(item.resolution_status),
        status_label: resolutionStatusLabel(item.resolution_status), duration_seconds: nullableNumber(item.duration_seconds) };
    });
    return {
      period, agent,
      summary: { call_count: total, resolved_count: resolved },
      items,
      pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) }
    };
  }

  async getAgentConversationQuality(agentId: string): Promise<Record<string, unknown> | undefined> {
    const agentResult = await this.pool.query(
      `WITH identities AS (
         SELECT coalesce(nullif(btrim(c.source_agent_speaker_id),''),a.external_id) AS id,
           coalesce(array_agg(DISTINCT coalesce(nullif(btrim(a.name),''),a.external_id)
             ORDER BY coalesce(nullif(btrim(a.name),''),a.external_id)),'{}'::text[]) AS logged_names,
           count(c.id)::integer AS call_count
         FROM call_recordings c JOIN agents a ON a.id=c.agent_id
         GROUP BY coalesce(nullif(btrim(c.source_agent_speaker_id),''),a.external_id)
       ) SELECT id AS external_id,id,logged_names,call_count FROM identities
       WHERE id=$1 ORDER BY call_count DESC LIMIT 1`, [agentId]
    );
    if (!agentResult.rows[0]) return undefined;
    const agent = agentResult.rows[0] as Record<string, unknown>;
    const result = await this.pool.query(
      `SELECT r.rule,
         round(100.0 * avg(CASE WHEN coalesce(nullif(btrim(c.source_agent_speaker_id),''),a.external_id)=$1
           THEN r.passed::int END)) AS agent_pass_percent,
         count(*) FILTER (WHERE coalesce(nullif(btrim(c.source_agent_speaker_id),''),a.external_id)=$1)::int AS agent_total_calls,
         count(*) FILTER (WHERE coalesce(nullif(btrim(c.source_agent_speaker_id),''),a.external_id)=$1
           AND NOT r.passed)::int AS agent_fail_count,
         round(100.0 * avg(r.passed::int)) AS team_pass_percent
       FROM call_recordings c
       JOIN agents a ON a.id=c.agent_id
       JOIN call_evaluations e ON e.call_recording_id=c.id,
       LATERAL (VALUES
         ('greeted_customer',e.greeted_customer), ('introduced_self',e.introduced_self),
         ('showed_empathy',e.showed_empathy), ('offered_help',e.offered_help),
         ('provided_clear_guidance',e.provided_clear_guidance), ('thanked_customer',e.thanked_customer),
         ('wished_customer_good_day',e.wished_customer_good_day)
       ) AS r(rule,passed)
       WHERE r.passed IS NOT NULL
       GROUP BY r.rule`, [agent.id]
    );
    const byRule = new Map(result.rows.map((row: Record<string, unknown>) => [String(row.rule), row]));
    const rules = ETIQUETTE_RULE_ORDER.map(({ key, label }) => {
      const row = byRule.get(key) as Record<string, unknown> | undefined;
      return {
        rule: key, label,
        agent_pass_percent: nullableNumber(row?.agent_pass_percent),
        team_pass_percent: nullableNumber(row?.team_pass_percent) ?? 0,
        fail_count: number(row?.agent_fail_count),
        total_calls: number(row?.agent_total_calls)
      };
    }).filter((rule) => rule.total_calls > 0);
    const agentPercents = rules.map((rule) => rule.agent_pass_percent).filter((value): value is number => value !== null);
    const overallAdherencePercent = agentPercents.length === 0
      ? 0 : Math.round(agentPercents.reduce((sum, value) => sum + value, 0) / agentPercents.length);
    return { agent, overall_adherence_percent: overallAdherencePercent, rules };
  }

  async getTeamCoachingSignals(): Promise<TeamCoachingSignals> {
    const [etiquetteResult, resolutionResult, toneResult, totalResult] = await Promise.all([
      this.pool.query(
        `SELECT r.rule, count(*) FILTER (WHERE NOT r.passed)::int AS fail_count, count(*)::int AS total
         FROM call_recordings c
         JOIN call_evaluations e ON e.call_recording_id=c.id,
         LATERAL (VALUES
           ('greeted_customer',e.greeted_customer), ('introduced_self',e.introduced_self),
           ('showed_empathy',e.showed_empathy), ('offered_help',e.offered_help),
           ('provided_clear_guidance',e.provided_clear_guidance), ('thanked_customer',e.thanked_customer),
           ('wished_customer_good_day',e.wished_customer_good_day)
         ) AS r(rule,passed)
         WHERE r.passed IS NOT NULL
         GROUP BY r.rule`
      ),
      this.pool.query(
        `SELECT resolution_status, count(*)::int AS call_count,
           round(count(*)::numeric / NULLIF(sum(count(*)) OVER (),0) * 100) AS percent
         FROM call_recordings
         GROUP BY resolution_status ORDER BY call_count DESC`
      ),
      this.pool.query(
        `SELECT s.textual_tone, count(*)::int AS segment_count,
           round(count(*)::numeric / NULLIF(sum(count(*)) OVER (),0) * 100) AS percent
         FROM transcript_segments s
         WHERE s.speaker_role='CUSTOMER' AND s.textual_tone IS NOT NULL
         GROUP BY s.textual_tone ORDER BY segment_count DESC`
      ),
      this.pool.query('SELECT count(*)::int AS total_calls FROM call_recordings')
    ]);
    const byRule = new Map(etiquetteResult.rows.map((row: Record<string, unknown>) => [String(row.rule), row]));
    const etiquette = ETIQUETTE_RULE_ORDER.map(({ key, label }) => {
      const row = byRule.get(key) as Record<string, unknown> | undefined;
      const failCount = number(row?.fail_count);
      const total = number(row?.total);
      return {
        rule: key, label, fail_count: failCount, total,
        fail_rate_percent: total === 0 ? 0 : Math.round((failCount / total) * 100)
      };
    }).filter((rule) => rule.total > 0);
    return {
      total_calls: number(totalResult.rows[0]?.total_calls),
      etiquette,
      resolution: resolutionResult.rows.map((row: Record<string, unknown>) => ({
        status: resolutionStatusValue(row.resolution_status), status_label: resolutionStatusLabel(row.resolution_status),
        call_count: number(row.call_count), percent: number(row.percent)
      })),
      customer_tone: toneResult.rows.map((row: Record<string, unknown>) => ({
        tone: String(row.textual_tone), segment_count: number(row.segment_count), percent: number(row.percent)
      }))
    };
  }

  /** Cached coaching insight — regenerated by the worker when a batch finishes
   * processing, not computed fresh on every dashboard read. */
  async getCachedCoachingInsight(): Promise<{ insight: string; generated_at: string } | undefined> {
    const result = await this.pool.query<{ insight: string; generated_at: string }>(
      'SELECT insight,generated_at FROM team_coaching_insight WHERE id=1'
    );
    return result.rows[0];
  }

  async saveCoachingInsight(insight: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO team_coaching_insight (id,insight,generated_at) VALUES (1,$1,now())
       ON CONFLICT (id) DO UPDATE SET insight=EXCLUDED.insight,generated_at=EXCLUDED.generated_at`,
      [insight]
    );
  }
}

const ETIQUETTE_RULE_ORDER = [
  { key: 'greeted_customer', label: 'Greeting' },
  { key: 'introduced_self', label: 'Introduction' },
  { key: 'showed_empathy', label: 'Empathy' },
  { key: 'offered_help', label: 'Offered help' },
  { key: 'provided_clear_guidance', label: 'Clear guidance' },
  { key: 'thanked_customer', label: 'Thanked customer' },
  { key: 'wished_customer_good_day', label: 'Closing' }
] as const;

function resolutionStatusValue(value: unknown): string {
  return String(value ?? 'UNKNOWN').toLowerCase();
}

function resolutionStatusLabel(value: unknown): string {
  if (value === 'RESOLVED_BUT_IMPROVE_QUALITY') return 'Resolved but Improve Quality';
  return String(value ?? 'UNKNOWN').toLowerCase().replaceAll('_', ' ').replace(/^./u, (letter) => letter.toUpperCase());
}
