import { createModelGateway, type ModelGateway } from "./gateway";
import type { ModelGatewayOptions } from "./types";

/**
 * Application-neutral AI runtime. Product code supplies the resolved config,
 * transport and operation-specific prompt/schema; this layer owns the model
 * gateway and its cross-cutting call mechanics.
 */
export type AiModelRuntime = {
  gateway: ModelGateway;
};

export function createAiModelRuntime(options: ModelGatewayOptions): AiModelRuntime {
  return { gateway: createModelGateway(options) };
}
