import {
  type DailyReportStage,
  type DailyReportStageContext,
  type DailyReportStageValidationFeedback,
} from "@/lib/ai/provider";
import type { DailyReportViolation } from "@/lib/daily-report/types";

type StageViolation = DailyReportViolation;

export type DailyReportStageLoopResult<T> = {
  value: T;
  context: DailyReportStageContext;
  repairRounds: number;
  cleanRetryCount: number;
  violations: StageViolation[];
};

export class DailyReportStageLoopError extends Error {
  readonly stage: DailyReportStage;
  readonly context: DailyReportStageContext;
  readonly violations: StageViolation[];
  readonly cleanRetryCount: number;

  constructor(
    stage: DailyReportStage,
    context: DailyReportStageContext,
    violations: StageViolation[],
    cleanRetryCount: number,
    cause?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : `${stage.toUpperCase()} 阶段修复失败。`);
    this.name = "DailyReportStageLoopError";
    this.stage = stage;
    this.context = context;
    this.violations = violations;
    this.cleanRetryCount = cleanRetryCount;
    this.cause = cause;
  }
}

export type DailyReportStageLoopOptions<T> = {
  stage: DailyReportStage;
  inputHash?: string;
  maxRepairRounds?: number;
  maxCleanRetries?: number;
  run: (
    context: DailyReportStageContext,
    feedback?: DailyReportStageValidationFeedback,
  ) => Promise<T>;
  validate: (value: T) => StageViolation[] | Promise<StageViolation[]>;
  isRepairable?: (violations: StageViolation[]) => boolean;
  onContextUpdate?: (context: DailyReportStageContext) => Promise<void> | void;
};

function errorStage(stage: DailyReportStage): StageViolation["stage"] {
  return stage === "assess" ? "assess" : stage === "plan" ? "plan" : "draft";
}

function errorToViolation(stage: DailyReportStage, error: unknown): StageViolation {
  return {
    code: "stage_output_invalid",
    stage: errorStage(stage),
    message: error instanceof Error ? error.message : String(error),
  };
}

function isInvalidJsonModelResponseError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "InvalidJsonModelResponseError");
}

function buildValidationFeedback(
  stage: DailyReportStage,
  violations: StageViolation[],
): DailyReportStageValidationFeedback {
  return {
    type: "VALIDATION_FEEDBACK",
    stage,
    violations,
    instruction: "只修正反馈中列出的问题，返回完整的当前阶段结果。",
  };
}

function defaultIsRepairable(violations: StageViolation[]) {
  return violations.length > 0 && violations.length <= 20;
}

function createStageContext(stage: DailyReportStage, inputHash?: string): DailyReportStageContext {
  return {
    stage,
    messages: [],
    repairRound: 0,
    cleanRetryAttempt: 0,
    lastOutput: null,
    lastViolations: [],
    ...(inputHash ? { inputHash } : {}),
  };
}

export async function runDailyReportStageLoop<T>(options: DailyReportStageLoopOptions<T>): Promise<DailyReportStageLoopResult<T>> {
  const maxRepairRounds = options.maxRepairRounds ?? 2;
  const maxCleanRetries = options.maxCleanRetries ?? 1;
  const isRepairable = options.isRepairable ?? defaultIsRepairable;
  let cleanRetryCount = 0;
  let lastContext = createStageContext(options.stage, options.inputHash);
  let lastViolations: StageViolation[] = [];
  let lastError: unknown = null;
  stageLoop: while (cleanRetryCount <= maxCleanRetries) {
    const context = cleanRetryCount === 0
      ? lastContext
      : createStageContext(options.stage, options.inputHash);
    context.cleanRetryAttempt = cleanRetryCount;
    lastContext = context;

    let feedback: DailyReportStageValidationFeedback | undefined;
    for (let repairRound = 0; repairRound <= maxRepairRounds; repairRound += 1) {
      try {
        const value = await options.run(context, feedback);
        // The provider records this counter when it appends feedback to the
        // transcript. Keep the generic loop contract correct for test doubles
        // and alternate providers that do not mutate the context themselves.
        if (context.repairRound < repairRound) {
          context.repairRound = repairRound;
        }
        const violations = await options.validate(value);
        lastViolations = violations;
        context.lastViolations = violations;
        await options.onContextUpdate?.(context);

        if (violations.length === 0) {
          return {
            value,
            context,
            repairRounds: context.repairRound,
            cleanRetryCount,
            violations: [],
          };
        }

        if (repairRound >= maxRepairRounds || !isRepairable(violations)) {
          lastError = new Error(`${options.stage.toUpperCase()} 校验失败：${violations.map((violation) => violation.message).slice(0, 5).join("；")}`);
          break;
        }

        feedback = buildValidationFeedback(options.stage, violations);
        await options.onContextUpdate?.(context);
      } catch (error) {
        lastError = error;
        lastViolations = [errorToViolation(options.stage, error)];
        context.lastViolations = lastViolations;
        context.contextOverflow = /context\s*(length|window|limit)|maximum\s+context|too\s+many\s+tokens|token\s+limit|上下文.{0,8}(超|限制)|令牌.{0,8}(超|限制)/iu.test(
          error instanceof Error ? error.message : String(error),
        );
        await options.onContextUpdate?.(context);

        // A malformed JSON response already has its assistant message in the
        // stage transcript. Feed that parse error back through the same
        // conversation; transport failures and context overflow must use the
        // clean-retry path because there is no trustworthy assistant output to
        // repair in the current conversation.
        if (
          isInvalidJsonModelResponseError(error)
          && !context.contextOverflow
          && repairRound < maxRepairRounds
          && isRepairable(lastViolations)
        ) {
          feedback = buildValidationFeedback(options.stage, lastViolations);
          continue;
        }
        if (cleanRetryCount >= maxCleanRetries) {
          throw new DailyReportStageLoopError(
            options.stage,
            context,
            lastViolations,
            cleanRetryCount,
            lastError,
          );
        }
        cleanRetryCount += 1;
        continue stageLoop;
      }
    }

    if (cleanRetryCount >= maxCleanRetries) {
      throw new DailyReportStageLoopError(
        options.stage,
        lastContext,
        lastViolations,
        cleanRetryCount,
        lastError,
      );
    }

    cleanRetryCount += 1;
  }

  throw new DailyReportStageLoopError(
    options.stage,
    lastContext,
    lastViolations,
    cleanRetryCount,
    lastError,
  );
}
