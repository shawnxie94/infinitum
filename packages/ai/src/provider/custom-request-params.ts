const forbiddenNames = new Set(["__proto__", "prototype", "constructor"]);
const protectedNames = new Set([
  "model", "messages", "input", "stream", "tools", "tool_choice", "response_format",
  "functions", "function_call", "json_schema", "schema", "headers", "authorization",
  "n", "best_of", "max_tokens", "max_completion_tokens", "max_output_tokens",
]);
const credentialName = /(?:api.?key|authorization|^auth(?:entication)?$|credential|password|secret|access.?token|refresh.?token)/i;
const budgetName = /^(?:max.?tokens?|max.?output.?tokens?|max.?completion.?tokens?|output.?token.?limit|token.?budget)$/i;

function normalizedKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[-.\s]/g, "_");
}

export function canonicalizeCustomRequestParams(value: unknown): Record<string, unknown> {
  if (value == null || (typeof value === "string" && !value.trim())) return {};
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown; }
    catch { throw new Error("Invalid custom request parameters JSON."); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error("Custom request parameters must be a JSON object.");
  }
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 8) throw new Error("Custom request parameters exceed allowed depth.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Custom request parameters contain an invalid number.");
      return item;
    }
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new Error("Custom request parameters must contain JSON values only.");
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) {
      const normalized = normalizedKey(key);
      if (forbiddenNames.has(key.toLowerCase()) || credentialName.test(normalized) || protectedNames.has(normalized) || budgetName.test(normalized)) {
        throw new Error("Custom request parameters contain a protected key.");
      }
      Object.defineProperty(output, key, { value: visit((item as Record<string, unknown>)[key], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return output;
  };
  const result = visit(parsed, 0) as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 8192) throw new Error("Custom request parameters exceed allowed size.");
  return result;
}
