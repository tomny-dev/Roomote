import {
  getOpenAiCompatibleProviderInstance,
  isOpenAiCompatibleProviderId,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@roomote/types';

const OPENAI_COMPATIBLE_DEFAULT_FALLBACK_BASE_URL =
  'http://127.0.0.1:4000/v1';

const STATIC_OPENAI_COMPATIBLE_PROVIDER_CONFIGS = {
  [OPENAI_COMPATIBLE_PROVIDER_ID]: {
    name: 'OpenAI-compatible',
    baseUrlEnvVarName: 'OPENAI_COMPATIBLE_BASE_URL',
    fallbackBaseUrl: OPENAI_COMPATIBLE_DEFAULT_FALLBACK_BASE_URL,
    apiKeyEnvVarName: 'OPENAI_COMPATIBLE_API_KEY' as string | undefined,
    keyless: false,
    allowOpenAiEnvFallback: false,
  },
  ollama: {
    name: 'Ollama',
    baseUrlEnvVarName: 'OLLAMA_BASE_URL',
    fallbackBaseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyEnvVarName: undefined as string | undefined,
    keyless: true,
    allowOpenAiEnvFallback: false,
  },
  vllm: {
    name: 'vLLM',
    baseUrlEnvVarName: 'VLLM_BASE_URL',
    fallbackBaseUrl: 'http://127.0.0.1:8000/v1',
    apiKeyEnvVarName: 'VLLM_API_KEY' as string | undefined,
    keyless: false,
    allowOpenAiEnvFallback: true,
  },
  litellm: {
    name: 'LiteLLM',
    baseUrlEnvVarName: 'LITELLM_BASE_URL',
    fallbackBaseUrl: 'http://127.0.0.1:4000/v1',
    apiKeyEnvVarName: 'LITELLM_API_KEY' as string | undefined,
    keyless: false,
    allowOpenAiEnvFallback: true,
  },
} as const;

type StaticOpenAiCompatibleProviderId =
  keyof typeof STATIC_OPENAI_COMPATIBLE_PROVIDER_CONFIGS;

type OpenAiCompatibleProviderRuntimeConfig = {
  name: string;
  baseUrlEnvVarName: string;
  fallbackBaseUrl: string;
  apiKeyEnvVarName: string | undefined;
  keyless: boolean;
  allowOpenAiEnvFallback: boolean;
};

function resolveOpenAiCompatibleProviderRuntimeConfig(
  providerId: string,
  runtimeEnv: NodeJS.ProcessEnv,
): OpenAiCompatibleProviderRuntimeConfig | null {
  const staticProvider =
    STATIC_OPENAI_COMPATIBLE_PROVIDER_CONFIGS[
      providerId as StaticOpenAiCompatibleProviderId
    ];
  if (staticProvider) {
    return staticProvider;
  }

  if (!isOpenAiCompatibleProviderId(providerId)) {
    return null;
  }

  const instance = getOpenAiCompatibleProviderInstance(providerId);
  if (!instance?.slug) {
    return null;
  }

  const configuredLabel = instance.labelEnvVarName
    ? runtimeEnv[instance.labelEnvVarName]?.trim()
    : undefined;
  const resolvedInstance = configuredLabel
    ? (getOpenAiCompatibleProviderInstance(providerId, {
        label: configuredLabel,
      }) ?? instance)
    : instance;

  return {
    name: resolvedInstance.label,
    baseUrlEnvVarName: resolvedInstance.baseUrlEnvVarName,
    fallbackBaseUrl: OPENAI_COMPATIBLE_DEFAULT_FALLBACK_BASE_URL,
    apiKeyEnvVarName: resolvedInstance.apiKeyEnvVarName,
    keyless: false,
    allowOpenAiEnvFallback: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function mergeNonTaskOpenAiCompatibleProviderConfig(
  providerConfig: Record<string, unknown>,
  runtimeEnv: NodeJS.ProcessEnv,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  let merged = providerConfig;
  const providerIds = [
    ...new Set(
      modelIds.flatMap((modelId) => {
        const providerId = modelId?.trim().split('/')[0];
        return providerId ? [providerId] : [];
      }),
    ),
  ];

  for (const providerId of providerIds) {
    const provider = resolveOpenAiCompatibleProviderRuntimeConfig(
      providerId,
      runtimeEnv,
    );
    if (!provider) {
      continue;
    }

    const prefix = `${providerId}/`;
    const modelIdsForProvider = [
      ...new Set(
        modelIds.flatMap((modelId) => {
          const normalized = modelId?.trim();

          return normalized?.startsWith(prefix)
            ? [normalized.slice(prefix.length)]
            : [];
        }),
      ),
    ];

    const existingProvider = asRecord(merged[providerId]);
    const existingOptions = asRecord(existingProvider.options);
    const existingModels = asRecord(existingProvider.models);
    const directApiKey = provider.apiKeyEnvVarName
      ? runtimeEnv[provider.apiKeyEnvVarName]?.trim()
      : undefined;
    const baseURL =
      runtimeEnv[provider.baseUrlEnvVarName]?.trim() ||
      (provider.allowOpenAiEnvFallback
        ? runtimeEnv.OPENAI_BASE_URL?.trim()
        : '') ||
      provider.fallbackBaseUrl;
    const apiKeyOptions = directApiKey
      ? { apiKey: `{env:${provider.apiKeyEnvVarName}}` }
      : provider.keyless
        ? { apiKey: 'ollama' }
        : provider.allowOpenAiEnvFallback && runtimeEnv.OPENAI_API_KEY?.trim()
          ? { apiKey: '{env:OPENAI_API_KEY}' }
          : {};

    merged = {
      ...merged,
      [providerId]: {
        ...existingProvider,
        npm: '@ai-sdk/openai-compatible',
        name: provider.name,
        options: {
          ...existingOptions,
          baseURL,
          ...apiKeyOptions,
        },
        models: {
          ...existingModels,
          ...Object.fromEntries(
            modelIdsForProvider.map((modelId) => [
              modelId,
              {
                name: modelId,
                ...asRecord(existingModels[modelId]),
              },
            ]),
          ),
        },
      },
    };
  }

  return merged;
}
