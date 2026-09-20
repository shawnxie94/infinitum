/**
 * G3（node 侧）：tsx 进程内跑通 hello workflow。
 * G1（workspace build）与 G2（钉版）由 run-all 单独执行。
 */
import { createP0Runtime } from "../runtime";
import { assert, fail, gate, pass } from "./helpers";

async function main() {
  gate("g3-hello-node");
  const mastra = createP0Runtime();
  const startedAt = Date.now();
  const run = await mastra.getWorkflow("p0_hello").createRun();
  const result = (await run.start({ inputData: { name: "node" } })) as unknown as {
    status: string;
    result?: { message?: string };
  };
  const elapsed = Date.now() - startedAt;
  const output = result;
  assert("g3", output.status === "success", `status=${output.status}`);
  assert("g3", output.result?.message === "HELLO NODE!", `output=${JSON.stringify(output.result)}`);
  pass("g3-hello-node", { elapsedMs: elapsed, output: output.result });
}

main().catch((error: unknown) => {
  fail("g3-hello-node", { error: error instanceof Error ? error.message : String(error) });
});
