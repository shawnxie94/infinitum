import {
  type DailyReportStage,
  type DailyReportStageContext,
  type DailyReportStageValidationFeedback,
} from "@/lib/ai/provider";
import { runStageLoop, StageLoopError } from "@infinitum/ai/orchestration/stage-loop";
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
  stopOnValidation?: (violations: StageViolation[]) => boolean;
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
  const missingNotes = violations
    .filter((violation) => violation.code === "draft_required_note_missing" && violation.topicId && violation.noteLabel)
    .map((violation) => ({
      topicId: violation.topicId!,
      noteLabel: violation.noteLabel!,
      ...(violation.blockKey ? { blockKey: violation.blockKey } : {}),
      ...(violation.noteInstruction ? { noteInstruction: violation.noteInstruction } : {}),
    }));
  return {
    type: "VALIDATION_FEEDBACK",
    stage,
    violations,
    ...(missingNotes.length > 0 ? { missingNotes } : {}),
    instruction: missingNotes.length > 0
      ? "反馈中的 missingNotes 已按 topicId + noteLabel 精确定位。只补齐这些 notes；不要删除、重写或重排其他条目，不要返回新的主题。"
      : "只修正反馈中列出的问题，返回完整的当前阶段结果。",
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
  try {
    return await runStageLoop<T, StageViolation, DailyReportStageContext>({
      stage: options.stage,
      inputHash: options.inputHash,
      maxRepairRounds: options.maxRepairRounds,
      maxCleanRetries: options.maxCleanRetries,
      createContext: (stage, inputHash) => createStageContext(stage as DailyReportStage, inputHash),
      run: (context, feedback) => options.run(context, feedback as DailyReportStageValidationFeedback | undefined),
      validate: options.validate,
      buildFeedback: (stage, violations) => buildValidationFeedback(stage as DailyReportStage, violations),
      errorToViolation: (stage, error) => errorToViolation(stage as DailyReportStage, error),
      isRepairable: options.isRepairable ?? defaultIsRepairable,
      stopOnValidation: options.stopOnValidation,
      isRepairableError: (error, context) => {
        context.contextOverflow = /context\s*(length|window|limit)|maximum\s+context|too\s+many\s+tokens|token\s+limit|上下文.{0,8}(超|限制)|令牌.{0,8}(超|限制)/iu.test(
          error instanceof Error ? error.message : String(error),
        );
        return isInvalidJsonModelResponseError(error) && !context.contextOverflow;
      },
      onContextUpdate: options.onContextUpdate,
    });
  } catch (error) {
    if (error instanceof StageLoopError) {
      throw new DailyReportStageLoopError(
        error.stage as DailyReportStage,
        error.context,
        error.violations as StageViolation[],
        error.cleanRetryCount,
        error.cause,
      );
    }
    throw error;
  }
}
