import OpenAI from 'openai';
import { z } from 'zod';
import type { Config } from '../config.js';

const insightSchema = z.object({ insight: z.string().min(1) }).strict();

const insightJsonSchema = {
  type: 'object', additionalProperties: false, required: ['insight'],
  properties: {
    insight: {
      type: 'string',
      description: 'A 2-3 sentence coaching insight for the support team, grounded only in the provided stats.'
    }
  }
};

const instructions = `You are a call-center coaching advisor. You are given real, aggregated team performance
stats — etiquette rule failure rates, call resolution outcomes, and customer tone during calls. Identify the
single biggest coaching opportunity and write a short, specific, actionable insight for the team lead.

Rules:
- Ground every claim strictly in the numbers given. Never invent a rule name, percentage, or trend not present
  in the data.
- Name the specific weak area (e.g. a named etiquette rule with a high fail rate, or a tone/resolution pattern)
  and cite its actual number.
- Keep it to 2-3 short sentences, plain language, addressed to a team lead deciding what to coach on next.
- If the data shows the team is performing well across the board (all rates comfortably within target), say so
  briefly instead of manufacturing a problem.`;

export interface TeamCoachingSignals {
  total_calls: number;
  etiquette: Array<{ rule: string; label: string; fail_count: number; total: number; fail_rate_percent: number }>;
  resolution: Array<{ status: string; status_label: string; call_count: number; percent: number }>;
  customer_tone: Array<{ tone: string; segment_count: number; percent: number }>;
}

export class CoachingInsightService {
  private readonly openai: OpenAI;

  constructor(private readonly config: Config) {
    this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: config.COACHING_TIMEOUT_MS, maxRetries: 0 });
  }

  async generate(signals: TeamCoachingSignals): Promise<string> {
    if (signals.total_calls === 0 || signals.etiquette.length === 0) {
      return 'Not enough analyzed calls yet to generate a coaching insight.';
    }

    const response = await this.openai.responses.create({
      model: this.config.OPENAI_COACHING_MODEL,
      instructions,
      input: JSON.stringify(signals),
      reasoning: { effort: this.config.COACHING_REASONING_EFFORT },
      store: false,
      text: { format: { type: 'json_schema', name: 'caresense_coaching_insight', strict: true, schema: insightJsonSchema } }
    });

    if (!response.output_text) return 'Coaching insight unavailable right now.';
    let raw: unknown;
    try {
      raw = JSON.parse(response.output_text);
    } catch {
      return 'Coaching insight unavailable right now.';
    }
    const parsed = insightSchema.safeParse(raw);
    return parsed.success ? parsed.data.insight : 'Coaching insight unavailable right now.';
  }
}
