import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../infra/logger.js';

export interface LLMConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface ReasoningRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export interface ReasoningResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export class LLMClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly logger: Logger;

  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCalls = 0;

  constructor(config: LLMConfig, logger: Logger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.logger = logger;
  }

  async reason(request: ReasoningRequest): Promise<ReasoningResponse> {
    const startMs = Date.now();

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: request.temperature ?? 0.3,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: request.userPrompt }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;

      this.totalInputTokens += inputTokens;
      this.totalOutputTokens += outputTokens;
      this.totalCalls++;

      this.logger.debug(
        {
          model: this.model,
          inputTokens,
          outputTokens,
          durationMs: Date.now() - startMs,
        },
        'LLM reasoning complete',
      );

      return { text, inputTokens, outputTokens };
    } catch (err) {
      this.logger.error({ err, model: this.model }, 'LLM reasoning failed');
      throw err;
    }
  }

  async reasonJSON<T>(request: ReasoningRequest): Promise<T> {
    const augmented: ReasoningRequest = {
      ...request,
      userPrompt: `${request.userPrompt}\n\nRespond with valid JSON only. No markdown, no explanation, just the JSON object.`,
    };

    const response = await this.reason(augmented);

    // Extract JSON from response (handle possible markdown wrapping)
    let jsonStr = response.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    return JSON.parse(jsonStr) as T;
  }

  getUsage(): LLMUsage {
    return {
      totalCalls: this.totalCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
    };
  }
}

export interface LLMUsage {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}
