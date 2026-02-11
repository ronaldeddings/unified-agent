import type { Provider, ProviderResponse } from "./types";

export class MockProvider implements Provider {
  name = "mock" as const;
  async ask(prompt: string): Promise<ProviderResponse> {
    return { text: `mock: ${prompt}` };
  }
}

