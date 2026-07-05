import { EventEmitter } from "events";
import type { OpenCodeClient } from "../bridge/openCodeClient";
import type { ProviderInfo, ProviderModelInfo, ModelSelection } from "../bridge/types";

interface RawModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  attachment?: boolean;
  tool_call?: boolean;
  cost?: { input: number; output: number };
  limit?: { context: number; output: number };
}

interface RawProvider {
  id: string;
  name?: string;
  env?: string[];
  models?: Record<string, RawModel>;
}

export class ModelService extends EventEmitter {
  private readonly client: OpenCodeClient;
  private providers: ProviderInfo[] = [];
  private defaultModel: ModelSelection | null = null;
  private selectedModel: ModelSelection | null = null;

  constructor(client: OpenCodeClient) {
    super();
    this.client = client;
  }

  getProviders(): ProviderInfo[] {
    return this.providers;
  }

  getDefaultModel(): ModelSelection | null {
    return this.defaultModel;
  }

  getSelectedModel(): ModelSelection | null {
    return this.selectedModel;
  }

  async refresh(): Promise<void> {
    const raw = await this.client.getProviders();
    const connectedSet = new Set<string>(raw.connected ?? []);

    this.providers = (raw.all as RawProvider[])
      .filter((provider) => connectedSet.has(provider.id))
      .map((provider): ProviderInfo => ({
        id: provider.id,
        name: provider.name ?? provider.id,
        connected: true,
        models: this.transformModels(provider.id, provider.models),
      }));

    this.defaultModel = null;
    for (const [providerID, modelID] of Object.entries(raw.default ?? {})) {
      if (connectedSet.has(providerID)) {
        this.defaultModel = { providerID, modelID };
        break;
      }
    }
    if (!this.defaultModel && this.providers.length > 0) {
      const p = this.providers[0];
      if (p.models.length > 0) {
        this.defaultModel = { providerID: p.id, modelID: p.models[0].modelID };
      }
    }
    if (!this.selectedModel) {
      this.selectedModel = this.defaultModel;
    } else {
      const stillConnected = this.providers.some(
        (p) =>
          p.id === this.selectedModel!.providerID &&
          p.models.some((m) => m.modelID === this.selectedModel!.modelID),
      );
      if (!stillConnected) {
        this.selectedModel = this.defaultModel;
      }
    }

    this.emit("modelsChanged");
  }

  selectModel(model: ModelSelection): void {
    this.selectedModel = model;
    this.emit("modelChanged");
  }

  /**
   * Applies the default model from the OpenCode config `model` field
   * (format "provider/modelID", e.g. "Tokenator/claude-sonnet-5").
   * The config model wins only if its provider is connected and the model
   * exists; otherwise the existing fallback default (computed in refresh) is kept.
   */
  applyConfigDefault(configModel: string | undefined | null): void {
    const parsed = this.parseModelString(configModel);
    if (parsed && this.modelExists(parsed)) {
      this.defaultModel = parsed;
      this.selectedModel = parsed;
      this.emit("modelsChanged");
    }
  }

  private parseModelString(value: string | undefined | null): ModelSelection | null {
    if (!value) return null;
    const idx = value.indexOf("/");
    if (idx <= 0) return null;
    const providerID = value.slice(0, idx);
    const modelID = value.slice(idx + 1);
    if (!providerID || !modelID) return null;
    return { providerID, modelID };
  }

  private modelExists(model: ModelSelection): boolean {
    return this.providers.some(
      (p) => p.id === model.providerID && p.models.some((m) => m.modelID === model.modelID),
    );
  }

  private transformModels(
    providerID: string,
    models: Record<string, RawModel> | undefined,
  ): ProviderModelInfo[] {
    if (!models) return [];
    return Object.entries(models).map(
      ([modelID, model]): ProviderModelInfo => ({
        providerID,
        modelID,
        name: model.name ?? modelID,
        reasoning: Boolean(model.reasoning),
        attachment: Boolean(model.attachment),
        toolCall: Boolean(model.tool_call),
        cost: model.cost ? { input: model.cost.input, output: model.cost.output } : undefined,
        limit: model.limit
          ? { context: model.limit.context, output: model.limit.output }
          : { context: 0, output: 0 },
      }),
    );
  }
}
