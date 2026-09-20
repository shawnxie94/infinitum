/**
 * G7：事件机制实测（1.67.0）。
 * - workflow 级 onStart/onFinish/onError 回调（D4 主机制候选）实测触发与负载键
 * - Mastra 实例事件面内省：pubsub getter、EventEmitterPubSub
 * - mastra.on 事件名清单：1.67 类型面无公开 mastra.on(topic) API（记录为负结论）
 */
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { Mastra as MastraClass } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { DB_URL, fail, gate, pass } from "./helpers";

type Fired = { onStart?: unknown; onFinish?: unknown; onError?: unknown };

async function main() {
  gate("g7-events");
  const fired: Fired = {};

  const echo = createStep({
    id: "echo",
    inputSchema: z.object({ v: z.string() }),
    outputSchema: z.object({ v: z.string() }),
    execute: async ({ inputData }) => ({ v: inputData.v }),
  });
  const wf = createWorkflow({
    id: "p0_events",
    inputSchema: z.object({ v: z.string() }),
    outputSchema: z.object({ v: z.string() }),
    options: {
      onStart: async (info: unknown) => {
        fired.onStart = info;
      },
      onFinish: async (result: unknown) => {
        fired.onFinish = result;
      },
      onError: async (errorInfo: unknown) => {
        fired.onError = errorInfo;
      },
    },
  })
    .then(echo)
    .commit();

  const storage = new LibSQLStore({ id: "p0-store", url: DB_URL });
  const mastra = new MastraClass({ storage, logger: false, workflows: { p0_events: wf } });

  // 内省事件面
  const surface = {
    hasPubSubGetter: "pubsub" in mastra,
    pubsubConstructor: mastra.pubsub?.constructor?.name ?? null,
    protoEventMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(mastra)).filter((m) =>
      /^(on|off|emit|once|subscribe|publish)/i.test(m),
    ),
  };
  console.log("event surface:", JSON.stringify(surface));
  console.log(
    "run-level stream/watch available:",
    ["watch", "stream", "resumeStream"].map((m) => `${m}:${typeof (wf as unknown as Record<string, unknown>)[m]}`).join(", "),
  );

  const run = await mastra.getWorkflow("p0_events").createRun();
  const result = (await run.start({ inputData: { v: "evt" } })) as unknown as {
    status: string;
  };

  // 失败路径：触发 onError（步 throw）
  const boom = createStep({
    id: "boom",
    inputSchema: z.object({ v: z.string() }),
    outputSchema: z.object({ v: z.string() }),
    execute: async () => {
      throw new Error("g7 intentional failure");
    },
  });
  const wfFail = createWorkflow({
    id: "p0_events_fail",
    inputSchema: z.object({ v: z.string() }),
    outputSchema: z.object({ v: z.string() }),
    options: {
      onError: async (errorInfo: unknown) => {
        fired.onError = errorInfo;
      },
      onFinish: async (result2: unknown) => {
        fired.onFinish = result2;
      },
    },
  })
    .then(boom)
    .commit();
  const mastraFail = new MastraClass({
    storage: new LibSQLStore({ id: "p0-store", url: DB_URL }),
    logger: false,
    workflows: { p0_events_fail: wfFail },
  });
  const failRun = await mastraFail.getWorkflow("p0_events_fail").createRun();
  const failResult = (await failRun.start({
    inputData: { v: "evt" },
  })) as unknown as { status: string };

  console.log("success run status:", result.status, "| fail run status:", failResult.status);
  console.log(
    "fired keys:",
    Object.keys(fired),
    "| onFinish keys:",
    fired.onFinish && typeof fired.onFinish === "object" ? Object.keys(fired.onFinish) : String(fired.onFinish).slice(0, 80),
  );

  const onFired = fired.onStart !== undefined;
  const finishFired = fired.onFinish !== undefined;
  const errorFired = fired.onError !== undefined;
  if (!finishFired) return fail("g7-events", { fired: Object.keys(fired), note: "onFinish 未触发" });
  pass("g7-events", {
    onStart: onFired,
    onFinish: finishFired,
    onError: errorFired,
    pubsub: surface.pubsubConstructor,
    protoEventMethods: surface.protoEventMethods,
    note: "mastra.on(topic) 无公开类型面；D4 以 run/工作流级回调 + wrapper 采集为准",
  });
}

main().catch((error: unknown) => {
  fail("g7-events", { error: error instanceof Error ? error.message : String(error) });
});
