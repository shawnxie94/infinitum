import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const helperPath = path.join(process.cwd(), "tests/integration/fixtures/mastra-crash-recovery-process.ts");

function launchRecoveryProcess(databasePath: string, taskRunId: string, markerPath: string, mode: "start" | "recover") {
  return spawn(process.execPath, ["--import", "tsx", helperPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: `file:${databasePath}`,
      CRASH_TEST_TASK_ID: taskRunId,
      CRASH_TEST_MARKER: markerPath,
      CRASH_TEST_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForFile(filePath: string, child: ReturnType<typeof spawn>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    if (child.exitCode !== null) throw new Error(`Crash fixture exited early (${child.exitCode}).`);
    await delay(50);
  }
  throw new Error("Timed out waiting for the workflow side effect before process termination.");
}

describe("Mastra LibSQL crash recovery", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("restarts an interrupted active step without pre-failing its task row", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinitum-mastra-crash-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.db");
    const markerPath = path.join(directory, "side-effect.json");
    const taskRunId = `crash-recovery-${Date.now()}`;

    const setup = spawnSync(process.execPath, ["scripts/setup-sqlite.mjs", databasePath, "--reset"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(setup.status, setup.stderr).toBe(0);

    const crashedWorker = launchRecoveryProcess(databasePath, taskRunId, markerPath, "start");
    await waitForFile(markerPath, crashedWorker);
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toEqual({ calls: 1, attempts: [1] });
    crashedWorker.kill("SIGKILL");
    await once(crashedWorker, "exit");

    const recoveryWorker = launchRecoveryProcess(databasePath, taskRunId, markerPath, "recover");
    let recoveryStdout = "";
    let recoveryStderr = "";
    recoveryWorker.stdout.on("data", (chunk: Buffer) => { recoveryStdout += chunk.toString(); });
    recoveryWorker.stderr.on("data", (chunk: Buffer) => { recoveryStderr += chunk.toString(); });
    const [exitCode] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        recoveryWorker.kill("SIGKILL");
        reject(new Error(`Recovery process timed out. stdout=${recoveryStdout} stderr=${recoveryStderr}`));
      }, 30_000);
      recoveryWorker.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve([code, signal]);
      });
    });
    expect(exitCode, recoveryStderr).toBe(0);
    expect(recoveryStdout).toContain("recovery-complete");
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toEqual({ calls: 2, attempts: [1, 2] });

    const prisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
    try {
      const taskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRunId } });
      const checkpoint = JSON.parse(taskRun.pipelineCheckpointJson ?? "{}");
      expect(taskRun.status).toBe("succeeded");
      expect(checkpoint.__mastra.step.attempt).toBe(2);
      expect(checkpoint.__mastra.step.status).toBe("succeeded");
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);
});
