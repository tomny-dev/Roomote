import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildOpenCodeCliEnv,
  NON_TASK_TOOL_PERMISSION_DENIALS,
} from '../opencode-runtime';

const MODEL_ID = 'qwen3.6:35b-unsloth';
const SMALL_MODEL_ID = 'qwen3.6:8b';

describe('non-task OpenAI-compatible provider config', () => {
  const managedKeys = [
    'OPENCODE_CONFIG_CONTENT',
    'R_MODEL',
    'R_SMALL_MODEL',
    'R_MODEL_REASONING_EFFORT',
    'R_SMALL_MODEL_REASONING_EFFORT',
    'LITELLM_BASE_URL',
    'LITELLM_API_KEY',
    'OLLAMA_BASE_URL',
    'VLLM_BASE_URL',
    'VLLM_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_COMPATIBLE_BASE_URL',
    'OPENAI_COMPATIBLE_API_KEY',
    'OPENAI_COMPATIBLE_LOCAL_BASE_URL',
    'OPENAI_COMPATIBLE_LOCAL_API_KEY',
    'OPENAI_COMPATIBLE_LOCAL_LABEL',
  ] as const;
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of managedKeys) {
      originalValues.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of managedKeys) {
      const original = originalValues.get(key);

      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it('registers LiteLLM for distinct coding and helper models', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: `litellm/${MODEL_ID}`,
      R_SMALL_MODEL: `litellm/${SMALL_MODEL_ID}`,
      LITELLM_BASE_URL: 'http://litellm:4000/v1',
      LITELLM_API_KEY: 'super-secret-key',
    });

    const configContent = env.OPENCODE_CONFIG_CONTENT ?? '{}';

    expect(JSON.parse(configContent)).toEqual({
      model: `litellm/${MODEL_ID}`,
      small_model: `litellm/${SMALL_MODEL_ID}`,
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM',
          options: {
            baseURL: 'http://litellm:4000/v1',
            apiKey: '{env:LITELLM_API_KEY}',
          },
          models: {
            [MODEL_ID]: { name: MODEL_ID },
            [SMALL_MODEL_ID]: { name: SMALL_MODEL_ID },
          },
        },
      },
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
    expect(configContent).not.toContain('super-secret-key');
  });

  it('preserves generated LiteLLM reasoning options while adding endpoint metadata', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: `litellm/${MODEL_ID}`,
      R_MODEL_REASONING_EFFORT: 'high',
      LITELLM_BASE_URL: 'http://litellm:4000/v1',
      LITELLM_API_KEY: 'secret',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: `litellm/${MODEL_ID}`,
      small_model: `litellm/${MODEL_ID}`,
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM',
          options: {
            baseURL: 'http://litellm:4000/v1',
            apiKey: '{env:LITELLM_API_KEY}',
          },
          models: {
            [MODEL_ID]: {
              name: MODEL_ID,
              options: { reasoningEffort: 'high' },
            },
          },
        },
      },
      permission: NON_TASK_TOOL_PERMISSION_DENIALS,
    });
  });

  it('configures named OpenAI-compatible connections without inlining secrets', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: `openai-compatible-local/${MODEL_ID}`,
      OPENAI_COMPATIBLE_LOCAL_BASE_URL: 'http://lm-studio:1234/v1',
      OPENAI_COMPATIBLE_LOCAL_API_KEY: 'named-provider-secret',
      OPENAI_COMPATIBLE_LOCAL_LABEL: 'Local LM Studio',
    });

    const configContent = env.OPENCODE_CONFIG_CONTENT ?? '{}';
    const config = JSON.parse(configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider['openai-compatible-local']).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenAI-compatible (Local LM Studio)',
      options: {
        baseURL: 'http://lm-studio:1234/v1',
        apiKey: '{env:OPENAI_COMPATIBLE_LOCAL_API_KEY}',
      },
      models: {
        [MODEL_ID]: { name: MODEL_ID },
      },
    });
    expect(configContent).not.toContain('named-provider-secret');
  });

  it('does not inherit generic OpenAI credentials for the default compatible provider', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: `openai-compatible/${MODEL_ID}`,
      OPENAI_COMPATIBLE_BASE_URL: 'http://custom-provider:4000/v1',
      OPENAI_BASE_URL: 'http://generic-openai:4000/v1',
      OPENAI_API_KEY: 'generic-openai-secret',
    });

    const configContent = env.OPENCODE_CONFIG_CONTENT ?? '{}';
    const config = JSON.parse(configContent) as {
      provider: Record<string, { options: Record<string, unknown> }>;
    };

    expect(config.provider['openai-compatible'].options).toEqual({
      baseURL: 'http://custom-provider:4000/v1',
    });
    expect(configContent).not.toContain('generic-openai-secret');
  });

  it('allows vLLM to use the generic OpenAI credential fallback', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: `vllm/${MODEL_ID}`,
      VLLM_BASE_URL: 'http://vllm:8000/v1',
      OPENAI_API_KEY: 'fallback-secret',
    });

    const configContent = env.OPENCODE_CONFIG_CONTENT ?? '{}';
    const config = JSON.parse(configContent) as {
      provider: Record<string, unknown>;
    };

    expect(config.provider.vllm).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'vLLM',
      options: {
        baseURL: 'http://vllm:8000/v1',
        apiKey: '{env:OPENAI_API_KEY}',
      },
      models: {
        [MODEL_ID]: { name: MODEL_ID },
      },
    });
    expect(configContent).not.toContain('fallback-secret');
  });

  it('supplies the placeholder API key required by keyless Ollama', () => {
    const env = buildOpenCodeCliEnv({
      R_MODEL: `ollama/${MODEL_ID}`,
      OLLAMA_BASE_URL: 'http://ollama:11434/v1',
    });

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as {
      provider: Record<string, unknown>;
    };

    expect(config.provider.ollama).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama',
      options: {
        baseURL: 'http://ollama:11434/v1',
        apiKey: 'ollama',
      },
      models: {
        [MODEL_ID]: { name: MODEL_ID },
      },
    });
  });
});