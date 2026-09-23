const API_PROVIDERS = [
  {
    id: "ollama",
    label: "Ollama Local",
    protocol: "ollama",
    hint: "No API key required",
    baseUrl: "http://127.0.0.1:11434",
    models: ["qwen2.5:0.5b", "llama3.1:8b-instruct-q4_K_M", "smollm2:135m-instruct-q8_0"],
    defaultModel: "qwen2.5:0.5b",
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    hint: "Usually starts with sk-",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "o3-mini"],
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    hint: "Usually starts with sk-ant-",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-5"],
    defaultModel: "claude-sonnet-4-6",
  },
  {
    id: "google",
    label: "Google Gemini",
    protocol: "gemini",
    hint: "Paste your Gemini API key",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
    defaultModel: "gemini-2.5-flash",
  },
  {
    id: "groq",
    label: "Groq",
    protocol: "openai",
    hint: "Usually starts with gsk_",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen-qwq-32b"],
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    hint: "Usually starts with sk-or-",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001"],
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    id: "mistral",
    label: "Mistral",
    protocol: "openai",
    hint: "Paste your Mistral API key",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-small-latest", "mistral-large-latest", "codestral-latest"],
    defaultModel: "mistral-small-latest",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    hint: "Usually starts with sk-",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
  },
  {
    id: "xai",
    label: "xAI",
    protocol: "openai",
    hint: "Paste your xAI API key",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-3-mini", "grok-3"],
    defaultModel: "grok-3-mini",
  },
  {
    id: "together",
    label: "Together AI",
    protocol: "openai",
    hint: "Paste your Together API key",
    baseUrl: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    protocol: "openai",
    hint: "Paste your Fireworks API key",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: ["accounts/fireworks/models/llama-v3p1-8b-instruct", "accounts/fireworks/models/llama-v3p3-70b-instruct"],
    defaultModel: "accounts/fireworks/models/llama-v3p1-8b-instruct",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    protocol: "openai",
    hint: "Paste the API key for your provider",
    custom: true,
    models: [],
    defaultModel: "",
  },
];

function providerById(id) {
  return API_PROVIDERS.find((provider) => provider.id === id) || null;
}

function publicProviders() {
  return API_PROVIDERS.map(({ id, label, protocol, hint, baseUrl, models, defaultModel, custom }) => ({
    id,
    label,
    protocol,
    hint,
    baseUrl: baseUrl || null,
    models,
    defaultModel,
    custom: Boolean(custom),
  }));
}

export { API_PROVIDERS, providerById, publicProviders };
