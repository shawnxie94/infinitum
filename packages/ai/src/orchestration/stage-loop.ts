export type StageLoopContext = {
  stage: string;
  repairRound: number;
  cleanRetryAttempt: number;
  lastViolations: unknown[];
  contextOverflow?: boolean;
};

export class StageLoopError<TContext extends StageLoopContext = StageLoopContext> extends Error {
  readonly stage: string;
  readonly context: TContext;
  readonly violations: unknown[];
  readonly cleanRetryCount: number;

  constructor(input: { stage: string; context: TContext; violations: unknown[]; cleanRetryCount: number; cause?: unknown }) {
    super(input.cause instanceof Error ? input.cause.message : `${input.stage} stage repair failed.`);
    this.name = "StageLoopError";
    this.stage = input.stage;
    this.context = input.context;
    this.violations = input.violations;
    this.cleanRetryCount = input.cleanRetryCount;
    this.cause = input.cause;
  }
}

export type StageLoopOptions<T, TViolation, TContext extends StageLoopContext> = {
  stage: string;
  inputHash?: string;
  maxRepairRounds?: number;
  maxCleanRetries?: number;
  createContext: (stage: string, inputHash?: string) => TContext;
  run: (context: TContext, feedback?: unknown) => Promise<T>;
  validate: (value: T) => TViolation[] | Promise<TViolation[]>;
  buildFeedback: (stage: string, violations: TViolation[]) => unknown;
  errorToViolation: (stage: string, error: unknown) => TViolation;
  isRepairable?: (violations: TViolation[]) => boolean;
  stopOnValidation?: (violations: TViolation[]) => boolean;
  isRepairableError?: (error: unknown, context: TContext) => boolean;
  onContextUpdate?: (context: TContext) => Promise<void> | void;
};

function defaultIsRepairable<T>(violations: T[]) {
  return violations.length > 0 && violations.length <= 20;
}

export async function runStageLoop<T, TViolation, TContext extends StageLoopContext>(
  options: StageLoopOptions<T, TViolation, TContext>,
): Promise<{ value: T; context: TContext; repairRounds: number; cleanRetryCount: number; violations: TViolation[] }> {
  const maxRepairRounds = options.maxRepairRounds ?? 2;
  const maxCleanRetries = options.maxCleanRetries ?? 1;
  const isRepairable = options.isRepairable ?? defaultIsRepairable;
  let cleanRetryCount = 0;
  let lastContext = options.createContext(options.stage, options.inputHash);
  let lastViolations: TViolation[] = [];
  let lastError: unknown = null;

  while (cleanRetryCount <= maxCleanRetries) {
    const context = cleanRetryCount === 0 ? lastContext : options.createContext(options.stage, options.inputHash);
    context.cleanRetryAttempt = cleanRetryCount;
    lastContext = context;
    let feedback: unknown;
    let requestedCleanRetry = false;

    for (let repairRound = 0; repairRound <= maxRepairRounds; repairRound += 1) {
      try {
        const value = await options.run(context, feedback);
        if (context.repairRound < repairRound) context.repairRound = repairRound;
        const violations = await options.validate(value);
        lastViolations = violations;
        context.lastViolations = violations;
        await options.onContextUpdate?.(context);

        if (violations.length === 0) {
          return { value, context, repairRounds: context.repairRound, cleanRetryCount, violations: [] };
        }
        if (options.stopOnValidation?.(violations)) {
          throw new StageLoopError({
            stage: options.stage,
            context,
            violations,
            cleanRetryCount,
            cause: new Error(`${options.stage.toUpperCase()} 校验需要执行局部修复。`),
          });
        }
        if (repairRound >= maxRepairRounds || !isRepairable(violations)) {
          lastError = new Error(`${options.stage.toUpperCase()} 校验失败。`);
          break;
        }
        feedback = options.buildFeedback(options.stage, violations);
        await options.onContextUpdate?.(context);
      } catch (error) {
        if (error instanceof StageLoopError) throw error;
        lastError = error;
        lastViolations = [options.errorToViolation(options.stage, error)];
        context.lastViolations = lastViolations;
        await options.onContextUpdate?.(context);
        if (options.isRepairableError?.(error, context) && repairRound < maxRepairRounds && isRepairable(lastViolations)) {
          feedback = options.buildFeedback(options.stage, lastViolations);
          continue;
        }
        if (cleanRetryCount >= maxCleanRetries) {
          throw new StageLoopError({ stage: options.stage, context, violations: lastViolations, cleanRetryCount, cause: lastError });
        }
        cleanRetryCount += 1;
        requestedCleanRetry = true;
        break;
      }
    }

    if (requestedCleanRetry) continue;
    if (cleanRetryCount >= maxCleanRetries) {
      throw new StageLoopError({ stage: options.stage, context: lastContext, violations: lastViolations, cleanRetryCount, cause: lastError });
    }
    cleanRetryCount += 1;
  }

  throw new StageLoopError({ stage: options.stage, context: lastContext, violations: lastViolations, cleanRetryCount, cause: lastError });
}
