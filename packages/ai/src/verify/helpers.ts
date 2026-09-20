import { createClient, type Client } from "@libsql/client";
import path from "node:path";

export const DB_URL = process.env.MASTRA_P0_DB ?? "file:" + path.join(process.cwd(), "prisma", "dev.db");

export function openClient(): Client {
  return createClient({ url: DB_URL });
}

export function gate(name: string): void {
  console.log(`\n=== [${name}] ===`);
}

export function pass(name: string, detail: Record<string, unknown> = {}): never {
  console.log(`GATE_RESULT ${JSON.stringify({ gate: name, verdict: "PASS", ...detail })}`);
  process.exit(0);
}

export function fail(name: string, detail: Record<string, unknown>): never {
  console.log(`GATE_RESULT ${JSON.stringify({ gate: name, verdict: "FAIL", ...detail })}`);
  process.exit(1);
}

export function assert(name: string, condition: boolean, message: string): void {
  if (!condition) throw new Error(`assert failed: ${message}`);
}

export async function ensureFlagTables(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS p0_step_attempts (
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      at INTEGER NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS p0_cancel_flags (
      lease_key TEXT PRIMARY KEY,
      requested_at INTEGER NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS p0_leases (
      kind TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      taken_at INTEGER NOT NULL,
      released_at INTEGER
    )
  `);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GATE_RESULT 行解析（run-all 用）。 */
export function parseGateResult(line: string): { gate: string; verdict: string } | null {
  if (!line.startsWith("GATE_RESULT ")) return null;
  try {
    return JSON.parse(line.slice("GATE_RESULT ".length));
  } catch {
    return null;
  }
}
