import {
  TemiApiError,
  type Environment,
  type ErrorCode,
  type PlaySequenceRequest,
  type RobotStatus,
  type TemiApiClient,
  type TemiApiErrorKind,
  type TemiApiRequestOptions,
} from "./api";
import { RequestOrchestrator } from "./orchestrator";

export const POLL_INTERVAL_MS = 2_000;
export const OBSERVATION_TIMEOUT_MS = POLL_INTERVAL_MS * 5;

export type LifecycleClient = Pick<
  TemiApiClient,
  "getRobotStatus" | "playSequence" | "stopSequence" | "clearToken"
>;

export type LifecyclePhase =
  | "idle"
  | "preflighting"
  | "blocked"
  | "confirmation_required"
  | "starting"
  | "running"
  | "stopping"
  | "terminal"
  | "failed"
  | "unknown";

export type RunObservation =
  | "completed"
  | "aborted"
  | "stopped"
  | "observation_unknown"
  | "identity_mismatch";

export type LifecycleRunIdentity = Readonly<{
  environment: Environment;
  serialNumber: string;
  sequenceId: string | null;
}>;

export type LifecycleError = Readonly<{
  kind: TemiApiErrorKind | "unknown";
  status: number | null;
  code: ErrorCode | null;
}>;

export type LifecycleSnapshot = Readonly<{
  phase: LifecyclePhase;
  identity: LifecycleRunIdentity | null;
  observation: RunObservation | null;
  latestStatus: RobotStatus | null;
  nextPollAt: number | null;
  pollInFlight: boolean;
  playPending: boolean;
  stopPending: boolean;
  error: LifecycleError | null;
  warning: string | null;
}>;

export type PlayPollStopLifecycleOptions = Readonly<{
  client: LifecycleClient;
  environment: Environment;
  orchestrator: RequestOrchestrator;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  onChange?: (snapshot: LifecycleSnapshot) => void;
  onStatus?: (status: RobotStatus) => void;
  onWarning?: (message: string) => void;
}>;

export class PlayPollStopLifecycle {
  #client: LifecycleClient;
  #environment: Environment;
  #orchestrator: RequestOrchestrator;
  #now: () => number;
  #setTimeout: NonNullable<PlayPollStopLifecycleOptions["setTimeout"]>;
  #clearTimeout: NonNullable<PlayPollStopLifecycleOptions["clearTimeout"]>;
  #onChange: ((snapshot: LifecycleSnapshot) => void) | undefined;
  #onStatus: ((status: RobotStatus) => void) | undefined;
  #onWarning: ((message: string) => void) | undefined;
  #state: LifecycleSnapshot = initialSnapshot();
  #validatedRequest: PlaySequenceRequest | null = null;
  #preflightPromise: Promise<LifecycleSnapshot> | null = null;
  #playPromise: Promise<LifecycleSnapshot> | null = null;
  #pollPromise: Promise<LifecycleSnapshot> | null = null;
  #stopPromise: Promise<LifecycleSnapshot> | null = null;
  #pollTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #stopAccepted = false;
  #runObserved = false;
  #speakProgressObserved = false;
  #observationDeadlineAt: number | null = null;
  #disposed = false;

  constructor(options: PlayPollStopLifecycleOptions) {
    this.#client = options.client;
    this.#environment = options.environment;
    this.#orchestrator = options.orchestrator;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimeout = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.#clearTimeout = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
    this.#onChange = options.onChange;
    this.#onStatus = options.onStatus;
    this.#onWarning = options.onWarning;
  }

  get state(): LifecycleSnapshot {
    return this.#state;
  }

  preparePlay(request: PlaySequenceRequest): Promise<LifecycleSnapshot> {
    if (this.#preflightPromise !== null) return this.#preflightPromise;
    if (!canPrepare(this.#state.phase)) {
      throw new Error("Play preparation is not available for the current run.");
    }

    const preparedRequest = cloneRequest(request);
    this.#validatedRequest = preparedRequest;
    this.#stopAccepted = false;
    this.#runObserved = false;
    this.#speakProgressObserved = false;
    this.#observationDeadlineAt = null;
    this.#setState({
      phase: "preflighting",
      identity: createIdentity(this.#environment, preparedRequest.serialNumber, null),
      observation: null,
      latestStatus: null,
      nextPollAt: null,
      pollInFlight: false,
      playPending: false,
      stopPending: false,
      error: null,
      warning: null,
    });

    const pending = this.#orchestrator
      .execute(
        {
          phase: "starting",
          operation: "getRobotStatus",
          requestSummary: { serialNumber: preparedRequest.serialNumber },
        },
        (options) => this.#client.getRobotStatus(preparedRequest.serialNumber, this.#withUnauthorized(options)),
      )
      .then((status) => {
        this.#onStatus?.(status);
        if (status.status === "online") {
          this.#setState({
            phase: "confirmation_required",
            latestStatus: status,
            error: null,
            warning: null,
          });
        } else {
          this.#setState({
            phase: "blocked",
            latestStatus: status,
            error: null,
            warning: null,
          });
        }
        return this.#state;
      })
      .catch((error: unknown) => {
        this.#validatedRequest = null;
        if (error instanceof TemiApiError && error.kind === "unauthorized") {
          this.#notifyUnauthorized();
        }
        this.#setState({
          phase: "failed",
          identity: null,
          latestStatus: null,
          nextPollAt: null,
          error: lifecycleError(error),
          warning: this.#state.warning,
        });
        throw error;
      })
      .finally(() => {
        if (this.#preflightPromise === pending) this.#preflightPromise = null;
      });

    this.#preflightPromise = pending;
    return pending;
  }

  confirmPlay(): Promise<LifecycleSnapshot> {
    if (this.#playPromise !== null) return this.#playPromise;
    if (this.#state.phase !== "confirmation_required" || this.#validatedRequest === null) {
      throw new Error("Play requires a fresh online preflight and explicit confirmation.");
    }

    const request = cloneRequest(this.#validatedRequest);
    this.#stopAccepted = false;
    this.#runObserved = false;
    this.#speakProgressObserved = false;
    this.#setState({
      phase: "starting",
      playPending: true,
      stopPending: false,
      observation: null,
      nextPollAt: null,
      error: null,
      warning: null,
    });

    const pending = this.#orchestrator
      .execute(
        {
          phase: "starting",
          operation: "playSequence",
          requestSummary: request,
        },
        (options) => this.#client.playSequence(request, this.#withUnauthorized(options)),
        { validateResponse: assertPlaySequenceResponse },
      )
      .then((response) => {
        const sequenceId = requiredSequenceId(response);
        this.#setState({
          phase: "running",
          identity: createIdentity(this.#environment, request.serialNumber, sequenceId),
          playPending: false,
          stopPending: false,
          observation: null,
          nextPollAt: this.#now() + POLL_INTERVAL_MS,
          error: null,
          warning: null,
        });
        this.#observationDeadlineAt = this.#now() + OBSERVATION_TIMEOUT_MS;
        this.#schedulePoll();
        return this.#state;
      })
      .catch((error: unknown) => {
        this.#validatedRequest = null;
        const unknownResult = isUnknownWriteResult(error);
        if (error instanceof TemiApiError && error.kind === "unauthorized") {
          this.#notifyUnauthorized();
        }
        this.#setState({
          phase: unknownResult ? "unknown" : "failed",
          identity: unknownResult
            ? this.#state.identity
            : null,
          playPending: false,
          stopPending: false,
          observation: unknownResult ? "observation_unknown" : null,
          nextPollAt: null,
          error: lifecycleError(error),
          warning: unknownResult
            ? "无法确认 Play 是否已被机器人接受；不会自动重试 Play。"
            : this.#state.warning,
        });
        throw error;
      })
      .finally(() => {
        if (this.#playPromise === pending) this.#playPromise = null;
      });

    this.#playPromise = pending;
    return pending;
  }

  pollNow(): Promise<LifecycleSnapshot> {
    if (this.#pollPromise !== null) return this.#pollPromise;
    const identity = this.#state.identity;
    if (
      identity === null ||
      identity.sequenceId === null ||
      !["running", "stopping", "unknown"].includes(this.#state.phase)
    ) {
      throw new Error("Polling requires an accepted, non-terminal run.");
    }
    const expectedSequenceId = identity.sequenceId;

    this.#clearPollTimer();
    this.#setState({ pollInFlight: true, nextPollAt: null, error: null });
    const phase = this.#state.phase === "stopping" ? "stopping" : "running";
    let pollEventId: number | null = null;
    const pending = this.#orchestrator
      .execute(
        {
          phase,
          operation: "getRobotStatus",
          requestSummary: { serialNumber: identity.serialNumber },
        },
        (options) => this.#client.getRobotStatus(identity.serialNumber, this.#withUnauthorized(options)),
        { onSettled: ({ eventId }) => { pollEventId = eventId; } },
      )
      .then((status) => {
        this.#onStatus?.(status);
        if (hasMatchingSequence(status, expectedSequenceId)) {
          this.#runObserved = true;
          this.#observationDeadlineAt = null;
          if (hasObservedNearFinalSequenceStep(status, this.#validatedRequest, expectedSequenceId)) {
            this.#speakProgressObserved = true;
          }
        }
        const observation = evaluateObservation(
          status,
          this.#validatedRequest,
          expectedSequenceId,
          this.#runObserved,
          this.#speakProgressObserved,
        );
        if (observation.terminal) {
          const terminalObservation = this.#stopAccepted && observation.kind !== "identity_mismatch"
            ? "stopped"
            : observation.kind;
          annotatePoll(
            this.#orchestrator,
            pollEventId,
            terminalObservation,
            observation.completionInferred === true && terminalObservation === "completed",
          );
          this.#setState({
            phase: "terminal",
            observation: terminalObservation,
            latestStatus: status,
            nextPollAt: null,
            pollInFlight: false,
            stopPending: false,
            error: null,
            warning: null,
          });
          return this.#state;
        }

        annotatePoll(this.#orchestrator, pollEventId, observation.kind);
        if (this.#observationTimedOut()) {
          this.#setState({
            phase: "unknown",
            observation: "observation_unknown",
            latestStatus: status,
            nextPollAt: null,
            pollInFlight: false,
            error: null,
            warning: "未观察到本次 sequence，无法确认运行结果；已停止自动轮询。",
          });
          return this.#state;
        }
        this.#setState({
          phase: this.#state.phase === "stopping" ? "stopping" : "running",
          observation: observation.kind,
          latestStatus: status,
          nextPollAt: this.#now() + POLL_INTERVAL_MS,
          pollInFlight: false,
          error: null,
        });
        this.#schedulePoll();
        return this.#state;
      })
      .catch((error: unknown) => {
        const unauthorized = error instanceof TemiApiError && error.kind === "unauthorized";
        if (unauthorized) {
          this.#notifyUnauthorized();
        }
        const observationTimedOut = this.#observationTimedOut();
        annotatePoll(this.#orchestrator, pollEventId, "observation_unknown");
        this.#setState({
          phase: this.#state.phase === "stopping" ? "stopping" : "unknown",
          observation: "observation_unknown",
          nextPollAt: unauthorized || observationTimedOut ? null : this.#now() + POLL_INTERVAL_MS,
          pollInFlight: false,
          error: lifecycleError(error),
          warning: unauthorized
            ? this.#state.warning
            : observationTimedOut
              ? "未观察到本次 sequence，无法确认运行结果；已停止自动轮询。"
            : "本次状态观察未知；只会重试 GET，不会自动重试 Play 或 Stop。",
        });
        if (!unauthorized && !observationTimedOut) this.#schedulePoll();
        return this.#state;
      })
      .finally(() => {
        if (this.#pollPromise === pending) this.#pollPromise = null;
      });

    this.#pollPromise = pending;
    return pending;
  }

  stop(): Promise<LifecycleSnapshot> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    const identity = this.#state.identity;
    if (
      identity === null ||
      identity.sequenceId === null ||
      !["running", "unknown"].includes(this.#state.phase)
    ) {
      throw new Error("Stop requires the current accepted run to be observable and non-terminal.");
    }

    this.#clearPollTimer();
    this.#setState({
      phase: "stopping",
      stopPending: true,
      nextPollAt: null,
      error: null,
      warning: null,
    });
    this.#observationDeadlineAt = null;
    const sequenceId = identity.sequenceId;
    const pending = this.#orchestrator
      .execute(
        {
          phase: "stopping",
          operation: "stopSequence",
          requestSummary: { sequenceId },
        },
        (options) => this.#client.stopSequence({ sequenceId }, this.#withUnauthorized(options)),
      )
      .then(() => {
        this.#stopAccepted = true;
        if (this.#state.phase === "terminal") return this.#state;
        this.#setState({
          phase: "stopping",
          stopPending: false,
          observation: null,
          nextPollAt: this.#now() + POLL_INTERVAL_MS,
          error: null,
          warning: null,
        });
        this.#schedulePoll();
        return this.#state;
      })
      .catch((error: unknown) => {
        if (this.#state.phase === "terminal") return this.#state;
        const unauthorized = error instanceof TemiApiError && error.kind === "unauthorized";
        if (unauthorized) {
          this.#notifyUnauthorized();
        }
        const unknownResult = isUnknownWriteResult(error);
        this.#setState({
          phase: unauthorized || unknownResult ? "unknown" : "running",
          stopPending: false,
          observation: unauthorized || unknownResult ? "observation_unknown" : this.#state.observation,
          nextPollAt: unauthorized ? null : this.#now() + POLL_INTERVAL_MS,
          error: lifecycleError(error),
          warning: unauthorized
            ? this.#state.warning
            : unknownResult
              ? "无法确认 Stop 是否已被接受；不会自动重发 Stop，只会继续 GET 状态观察。"
              : null,
        });
        if (!unauthorized) this.#schedulePoll();
        throw error;
      })
      .finally(() => {
        if (this.#stopPromise === pending) this.#stopPromise = null;
      });

    this.#stopPromise = pending;
    return pending;
  }

  cancelPreparation(): void {
    if (!["blocked", "confirmation_required", "failed"].includes(this.#state.phase)) return;
    this.#validatedRequest = null;
    this.#stopAccepted = false;
    this.#runObserved = false;
    this.#speakProgressObserved = false;
    this.#observationDeadlineAt = null;
    this.#clearPollTimer();
    this.#state = initialSnapshot();
    this.#onChange?.(this.#state);
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearPollTimer();
  }

  #setState(changes: Partial<LifecycleSnapshot>): void {
    if (this.#disposed) return;
    this.#state = Object.freeze({ ...this.#state, ...changes });
    this.#onChange?.(this.#state);
  }

  #schedulePoll(): void {
    if (this.#disposed) return;
    this.#clearPollTimer();
    const dueAt = this.#state.nextPollAt;
    if (dueAt === null) return;
    this.#pollTimer = this.#setTimeout(() => {
      void this.pollNow();
    }, Math.max(0, dueAt - this.#now()));
  }

  #clearPollTimer(): void {
    if (this.#pollTimer !== null) {
      this.#clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  #observationTimedOut(): boolean {
    return !this.#runObserved &&
      this.#observationDeadlineAt !== null &&
      this.#now() >= this.#observationDeadlineAt;
  }

  #notifyUnauthorized(): void {
    const message = "401：已清除内存 OAT；无法确认机器人当前是否仍在执行，不能自动重试 Play 或 Stop。";
    if (this.#state.warning === message) return;
    this.#setState({ warning: message });
    this.#onWarning?.(message);
    this.#client.clearToken();
  }

  #withUnauthorized(options: TemiApiRequestOptions): TemiApiRequestOptions {
    return {
      ...options,
      onUnauthorized: () => this.#notifyUnauthorized(),
    };
  }

}

function initialSnapshot(): LifecycleSnapshot {
  return Object.freeze({
    phase: "idle",
    identity: null,
    observation: null,
    latestStatus: null,
    nextPollAt: null,
    pollInFlight: false,
    playPending: false,
    stopPending: false,
    error: null,
    warning: null,
  });
}

function canPrepare(phase: LifecyclePhase): boolean {
  return phase === "idle" || phase === "blocked" || phase === "failed";
}

function createIdentity(
  environment: Environment,
  serialNumber: string,
  sequenceId: string | null,
): LifecycleRunIdentity {
  return Object.freeze({ environment, serialNumber, sequenceId });
}

function lifecycleError(error: unknown): LifecycleError {
  if (error instanceof TemiApiError) {
    return Object.freeze({ kind: error.kind, status: error.status, code: error.code });
  }
  return Object.freeze({ kind: "unknown", status: null, code: null });
}

function requiredSequenceId(response: { sequenceId?: unknown }): string {
  if (typeof response.sequenceId !== "string" || response.sequenceId.trim().length === 0) {
    throw new TemiApiError("invalid_response", 202);
  }
  return response.sequenceId;
}

function assertPlaySequenceResponse(response: { sequenceId?: unknown }): void {
  requiredSequenceId(response);
}

function isUnknownWriteResult(error: unknown): boolean {
  if (!(error instanceof TemiApiError)) return true;
  if (error.kind === "network" || error.kind === "timeout" || error.kind === "aborted") return true;
  return error.kind === "invalid_response" && (error.status === null || error.status < 400);
}

type ObservationEvaluation = Readonly<{
  terminal: boolean;
  kind: RunObservation;
  completionInferred?: boolean;
}>;

function evaluateObservation(
  status: RobotStatus,
  request: PlaySequenceRequest | null,
  expectedSequenceId: string,
  runObserved: boolean,
  speakProgressObserved: boolean,
): ObservationEvaluation {
  const observedSequenceId = status.sequence?.sequenceId;
  if (observedSequenceId !== undefined) {
    if (typeof observedSequenceId !== "string" || observedSequenceId.trim().length === 0) {
      return { terminal: false, kind: "observation_unknown" };
    }
    if (observedSequenceId !== expectedSequenceId) {
      return { terminal: false, kind: "identity_mismatch" };
    }
  }

  if (!runObserved) return { terminal: false, kind: "observation_unknown" };

  const sequenceStatus = normaliseStatus(status.sequence?.status);
  const callStatus = normaliseStatus(status.call?.status);
  const movementActive = isMovementActive(status.movement);
  const finalAction = request?.actions.at(-1);
  const finalMovement = finalAction?.type === "MOVEMENT" ? finalAction : null;
  const sequenceKind = terminalSequenceKind(sequenceStatus);

  if (finalMovement !== null) {
    if (sequenceKind === "aborted" || sequenceKind === "stopped") {
      return { terminal: true, kind: sequenceKind };
    }
    const movement = status.movement;
    const atIdle = movement?.type === "idle";
    const atExpectedLocation =
      movement?.type === "go_to" &&
      movement.status === "complete" &&
      movement.location === finalMovement.location;
    if (sequenceStatus === "start") {
      return { terminal: false, kind: "observation_unknown" };
    }
    if (atIdle || atExpectedLocation) {
      return { terminal: true, kind: "completed" };
    }
    return { terminal: false, kind: "observation_unknown" };
  }

  const sequenceMissing = status.sequence === undefined || status.sequence === null;
  if (finalAction?.type === "SPEAK" && sequenceMissing && speakProgressObserved && !movementActive && callStatus !== "start") {
    if (sequenceKind === "aborted" || sequenceKind === "stopped") {
      return { terminal: true, kind: sequenceKind };
    }
    return { terminal: true, kind: "completed", completionInferred: true };
  }

  if (finalAction?.type === "START_CALL" && sequenceStatus === null && callStatus !== "start") {
    return { terminal: true, kind: "completed", completionInferred: true };
  }

  if (sequenceKind !== null) return { terminal: true, kind: sequenceKind };
  return { terminal: false, kind: "observation_unknown" };
}

function normaliseStatus(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.toLowerCase() : null;
}

function isMovementActive(movement: RobotStatus["movement"] | undefined): boolean {
  if (movement === undefined || movement.type === "idle") return false;
  return normaliseStatus(movement.status) !== "complete";
}

function terminalSequenceKind(status: string | null): Exclude<RunObservation, "completed" | "observation_unknown" | "identity_mismatch"> | null {
  if (status === "abort" || status === "aborted" || status === "cancelled" || status === "canceled" || status === "failed") {
    return "aborted";
  }
  if (status === "stop" || status === "stopped") return "stopped";
  return null;
}

function hasMatchingSequence(status: RobotStatus, expectedSequenceId: string): boolean {
  return status.sequence?.sequenceId === expectedSequenceId;
}

function hasObservedNearFinalSequenceStep(
  status: RobotStatus,
  request: PlaySequenceRequest | null,
  expectedSequenceId: string,
): boolean {
  const sequence = status.sequence;
  const finalStep = request === null ? null : finalSequenceStep(request);
  if (sequence === undefined || sequence === null || finalStep === null || !hasMatchingSequence(status, expectedSequenceId)) return false;

  if (!isPositiveInteger(sequence.step)) return false;
  const total = isPositiveInteger(sequence.total) ? sequence.total : finalStep;
  const nearFinalStep = Math.max(1, total - 1);
  return sequence.step >= nearFinalStep && sequence.step >= Math.max(1, finalStep - 1);
}

function finalSequenceStep(request: PlaySequenceRequest): number | null {
  const steps = request.actions
    .map((action) => action.endStep ?? action.step ?? action.startStep)
    .filter(isPositiveInteger);
  return steps.length === 0 ? null : Math.max(...steps);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function annotatePoll(
  orchestrator: RequestOrchestrator,
  eventId: number | null,
  observation: RunObservation,
  completionInferred = false,
): void {
  if (eventId === null) return;
  orchestrator.timeline.annotate(eventId, {
    observation,
    explanation: observationExplanation(observation, completionInferred),
  });
}

function observationExplanation(observation: RunObservation, completionInferred = false): string {
  if (observation === "completed") {
    return completionInferred
      ? "Poll inferred the final action completed after final sequence progress was observed and sequence.status was absent."
      : "Poll observed the current sequence completed.";
  }
  if (observation === "aborted") return "Poll observed the current sequence aborted.";
  if (observation === "stopped") return "Poll observed the current sequence stopped after Stop.";
  if (observation === "identity_mismatch") {
    return "Poll observed an identity mismatch; the different sequence was not treated as this run and was not used for Stop.";
  }
  return "Poll observation is unknown; only GET status may be retried and no completion was inferred.";
}

function cloneRequest(request: PlaySequenceRequest): PlaySequenceRequest {
  return {
    ...request,
    actions: request.actions.map((action) => ({
      ...action,
      ...(action.contactIds === undefined
        ? {}
        : {
            contactIds: action.contactIds.map((contactId) =>
              typeof contactId === "string" ? contactId : { ...contactId },
            ),
          }),
      ...(action.extra === undefined ? {} : { extra: { ...action.extra } }),
    })),
    ...(request.stopBy === undefined ? {} : { stopBy: { ...request.stopBy } }),
  };
}
