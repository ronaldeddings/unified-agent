import type { Provider, ProviderAskOptions, ProviderResponse } from "./types";

export class MockProvider implements Provider {
  name = "mock" as const;
  capabilities = {
    supportsSetModel: true,
    supportsInterrupt: false,
    supportsPermissionMode: true,
  };

  async ask(prompt: string, _opts: ProviderAskOptions): Promise<ProviderResponse> {
    return { text: `mock: ${prompt}` };
  }
}
