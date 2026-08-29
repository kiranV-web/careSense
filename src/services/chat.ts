import OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { ChatRepository } from '../db/chat.repository.js';
import { CHAT_TOOLS, executeChatTool } from './chatTools.js';

export class ChatContractError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ChatContractError';
  }
}

const chatTableSchema = z.object({
  title: z.string().min(1),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(z.string()))
}).strict();

export const finalAnswerSchema = z.object({
  answer: z.string().min(1),
  cited_external_call_ids: z.array(z.string()),
  table: chatTableSchema.nullable()
}).strict();
export type ChatAnswer = z.infer<typeof finalAnswerSchema>;

const finalAnswerJsonSchema = {
  type: 'object', additionalProperties: false, required: ['answer', 'cited_external_call_ids', 'table'],
  properties: {
    answer: { type: 'string', description: 'A natural-language answer to the user, grounded only in tool results.' },
    cited_external_call_ids: {
      type: 'array', items: { type: 'string' },
      description: 'external_call_id values from get_call_evidence results that support this answer. Empty array if none were used.'
    },
    table: {
      type: ['object', 'null'], additionalProperties: false, required: ['title', 'columns', 'rows'],
      description: 'A structured table view of the same data backing the answer, for questions that are naturally a ranking/breakdown/comparison/list (2+ comparable rows). Every value must come from your tool results — never invent a row. Null for a single-fact or narrative-only answer.',
      properties: {
        title: { type: 'string', description: 'Short table caption, e.g. "Agents ranked by quality score".' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Column headers, e.g. ["Agent", "Quality score", "Calls"].' },
        rows: {
          type: 'array', items: { type: 'array', items: { type: 'string' } },
          description: 'One array per row, same length and order as columns. Format numbers as you would in prose (e.g. "87%", "42 calls").'
        }
      }
    }
  }
};

const instructions = `You are CareSense's call-center analytics assistant. You answer questions about call
recordings, agent performance, and customer issues for a bank's support team by calling the functions made
available to you — never from memory or assumption.

Choosing a function:
- Named functions (everything except run_readonly_query) are purpose-built, fast, and safe — reach for one of
  those first. They should cover roughly 80% of realistic questions.
- run_readonly_query is a last resort for the remaining ~20% of questions that genuinely don't fit any named
  function (an unusual cross-cut of the data, a one-off aggregation). Only reach for it after checking no
  named function applies, and always pass a short "reason" explaining why.
- get_open_manager_alerts lists actual actionable alerts; get_manager_alert_status only gives counts — prefer
  the former for "what should I look at" questions, the latter for "how many are open" questions.
- get_call_evidence also works as a lookup by customer name or a specific call ID, not just as a filter.
- get_data_overview answers meta questions about the dataset itself (how much data, is it up to date) — it's
  not a substitute for the analytics functions above.

Dates:
- There is no date-range concept anywhere else in this product — every function defaults to full history when
  date_from/date_to are omitted (pass null for both). Do this for any general or unqualified question.
- Only pass explicit dates when the user names a specific period themselves (e.g. "in June", "last 7 days").
  Never guess or narrow a range on your own.

Rules:
- Answer ONLY using data returned by your function calls. Never invent numbers, names, dates, or call IDs.
- Before naming or quoting a specific call, agent-name spelling, or verdict, confirm it via a function result.
- If you don't know an agent's exact name, call list_agents or rank_agents_by_quality first to find it rather
  than guessing a spelling.
- Only include a value in cited_external_call_ids if it was returned by get_call_evidence or
  get_open_manager_alerts in this conversation.
- If no available function or reasonable read-only query can answer the question (e.g. it's unrelated to
  calls/agents/customers), say so plainly and briefly describe what you can help with instead — do not guess.
- Be a little explanatory, not just a bare number: briefly say what the figure means in context (e.g. compared
  to the total, or what counts as a "failure") so the answer stands on its own. Stay concise — a couple of
  sentences, not a report. When asked for a suggestion or what to improve, base it on the actual failure/rate
  data you fetched, not generic advice.
- Populate the table field whenever the answer is naturally a ranking, breakdown, comparison, or list of 2+
  comparable rows — copy the exact values from your tool results into columns/rows, never invented or rounded
  differently than the source. Leave table null for a single-fact or purely narrative answer.`;

export class ChatService {
  private readonly openai: OpenAI;

  constructor(private readonly config: Config, private readonly repository: ChatRepository) {
    this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: config.CHAT_TIMEOUT_MS, maxRetries: 0 });
  }

  async answer(history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<ChatAnswer> {
    const input: ResponseInputItem[] = history.map((message) => ({ role: message.role, content: message.content }));

    for (let round = 0; round < this.config.CHAT_MAX_TOOL_ROUNDS; round++) {
      const response = await this.openai.responses.create({
        model: this.config.OPENAI_CHAT_MODEL,
        instructions,
        input,
        tools: CHAT_TOOLS,
        reasoning: { effort: this.config.CHAT_REASONING_EFFORT },
        store: false,
        text: { format: { type: 'json_schema', name: 'caresense_chat_answer', strict: true, schema: finalAnswerJsonSchema } }
      });

      const calls = response.output.filter((item): item is Extract<typeof item, { type: 'function_call' }> =>
        item.type === 'function_call');

      if (calls.length === 0) {
        if (!response.output_text) throw new ChatContractError('EMPTY_CHAT_RESPONSE', 'OpenAI returned no answer text');
        let raw: unknown;
        try {
          raw = JSON.parse(response.output_text);
        } catch {
          throw new ChatContractError('INVALID_CHAT_JSON', 'OpenAI returned malformed JSON');
        }
        const parsed = finalAnswerSchema.safeParse(raw);
        if (!parsed.success) throw new ChatContractError('INVALID_CHAT_SHAPE', parsed.error.message);
        return parsed.data;
      }

      for (const call of calls) {
        input.push(call);
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        let output: unknown;
        try {
          output = await executeChatTool(call.name, args, this.repository);
        } catch (error) {
          output = { error: error instanceof Error ? error.message : 'Tool execution failed' };
        }
        input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) });
      }
    }
    throw new ChatContractError('TOOL_LOOP_EXCEEDED', 'The assistant took too many steps without reaching an answer');
  }
}
