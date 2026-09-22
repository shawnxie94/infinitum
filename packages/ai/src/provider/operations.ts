import type { ZodType } from "zod";

import type { ModelGateway } from "./gateway";
import type { JsonCompleteRequest } from "./types";

export type AiOperationRetryPolicy = {
  jsonParseRetryCount?: number;
};

export type AiOperationDefinition = {
  key: string;
  label: string;
  /** Optional business-owned structured output schema. */
  schema?: ZodType;
  retryPolicy?: AiOperationRetryPolicy;
};

export type AiOperationRegistry = {
  get(key: string): AiOperationDefinition;
  has(key: string): boolean;
  list(): AiOperationDefinition[];
};

export function createAiOperationRegistry(
  definitions: readonly AiOperationDefinition[],
): AiOperationRegistry {
  const byKey = new Map<string, AiOperationDefinition>();
  for (const definition of definitions) {
    if (!definition.key.trim() || byKey.has(definition.key)) {
      throw new Error(`Duplicate or empty AI operation key: ${definition.key}`);
    }
    byKey.set(definition.key, { ...definition });
  }

  return {
    get(key) {
      const definition = byKey.get(key);
      if (!definition) throw new Error(`Unknown AI operation: ${key}`);
      return {
        ...definition,
        retryPolicy: definition.retryPolicy ? { ...definition.retryPolicy } : undefined,
      };
    },
    has: (key) => byKey.has(key),
    list: () => [...byKey.values()].map((definition) => ({
      ...definition,
      retryPolicy: definition.retryPolicy ? { ...definition.retryPolicy } : undefined,
    })),
  };
}

/**
 * Binds an operation contract to the model gateway. The caller still supplies
 * the product-specific parser; the runner owns operation identity, schema and
 * retry policy propagation.
 */
export function createAiOperationRunner(input: {
  gateway: ModelGateway;
  registry: AiOperationRegistry;
}) {
  return {
    completeJson<T>(request: JsonCompleteRequest, parse: (output: string) => T): Promise<T | null> {
      const key = request.usageKey ?? request.taskType;
      const operation = input.registry.get(key);
      if (request.taskType !== operation.key || request.usageKey !== operation.key) {
        throw new Error(`AI operation/request mismatch: ${operation.key}`);
      }
      return input.gateway.completeJson({
        ...request,
        taskType: operation.key,
        usageKey: operation.key,
        schema: request.schema ?? operation.schema,
        jsonParseRetryCount: request.jsonParseRetryCount ?? operation.retryPolicy?.jsonParseRetryCount,
      }, parse);
    },
  };
}
