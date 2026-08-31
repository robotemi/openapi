import {
  TemiApiError,
  type TemiApiRequestOptions,
} from "./api";
import {
  API_OPERATION_CONTRACTS,
  TimelineStore,
  type ApiOperation,
  type TimelineOutcome,
} from "./timeline";
import type { RunState } from "./run-state";

export type RequestOrchestratorOptions = Readonly<{
  timeline?: TimelineStore;
  now?: () => number;
  timeoutMs?: number;
}>;

export type OrchestratedRequest = Readonly<{
  phase: RunState;
  operation: ApiOperation;
  requestSummary?: unknown;
  timeoutMs?: number;
}>;

export type ApiRequestInvoker<T> = (options: TemiApiRequestOptions) => Promise<T>;

export type RequestCompletion<T> = Readonly<{
  eventId: number;
  outcome: Exclude<TimelineOutcome, "queued" | "pending">;
  httpStatus: number | null;
  response?: T;
  error?: unknown;
}>;

export type RequestHooks<T> = Readonly<{
  validateResponse?: (response: T) => void;
  onSettled?: (completion: RequestCompletion<T>) => void;
}>;

type ActiveRequest = {
  id: number;
  phase: RunState;
  operation: ApiOperation;
  controller: AbortController;
};

export class RequestOrchestrator {
  readonly timeline: TimelineStore;
  #timeoutMs: number;
  #active = new Map<number, ActiveRequest>();

  constructor(options: RequestOrchestratorOptions = {}) {
    const now = options.now ?? (() => Date.now());
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.timeline = options.timeline ?? new TimelineStore(now);
  }

  execute<T>(
    request: OrchestratedRequest,
    invoke: ApiRequestInvoker<T>,
    hooks: RequestHooks<T> = {},
  ): Promise<T> {
    const id = this.timeline.enqueue(request);
    const controller = new AbortController();
    const active: ActiveRequest = {
      id,
      phase: request.phase,
      operation: request.operation,
      controller,
    };
    this.#active.set(id, active);
    this.timeline.start(id);

    let httpStatus: number | null = null;
    let timeoutTriggered = false;
    const timeoutMs = request.timeoutMs ?? this.#timeoutMs;
    const timeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? globalThis.setTimeout(() => {
            timeoutTriggered = true;
            controller.abort("timeout");
          }, timeoutMs)
        : null;

    const options: TemiApiRequestOptions = {
      signal: controller.signal,
      onResponseStatus: (status) => {
        httpStatus = status;
      },
    };

    let requestPromise: Promise<T>;
    try {
      requestPromise = invoke(options);
    } catch (error: unknown) {
      requestPromise = Promise.reject(error);
    }

    return requestPromise.then(
      (response) => {
        const forcedError = forcedAbortError(controller.signal, timeoutTriggered);
        if (forcedError !== null) {
          return this.finishFailure<T>(active, timeout, httpStatus, forcedError, hooks);
        }
        try {
          hooks.validateResponse?.(response);
        } catch (error: unknown) {
          return this.finishFailure<T>(active, timeout, httpStatus, error, hooks);
        }
        this.finishSuccess(active, timeout, httpStatus, response, hooks);
        return response;
      },
      (error: unknown) => this.finishFailure<T>(active, timeout, httpStatus, error, hooks),
    );
  }

  abortReads(): void {
    for (const active of this.#active.values()) {
      if (API_OPERATION_CONTRACTS[active.operation].sideEffect === "read") {
        active.controller.abort("reset");
      }
    }
  }

  abort(id: number): void {
    this.#active.get(id)?.controller.abort("abort");
  }

  private finishSuccess<T>(
    active: ActiveRequest,
    timeout: ReturnType<typeof globalThis.setTimeout> | null,
    httpStatus: number | null,
    response: T,
    hooks: RequestHooks<T>,
  ): void {
    this.cleanup(active.id, timeout);
    if (this.timeline.has(active.id)) {
      this.timeline.complete(active.id, {
        outcome: "succeeded",
        httpStatus,
        response,
      });
    }
    notifySettled(hooks.onSettled, {
      eventId: active.id,
      outcome: "succeeded",
      httpStatus,
      response,
    });
  }

  private finishFailure<T>(
    active: ActiveRequest,
    timeout: ReturnType<typeof globalThis.setTimeout> | null,
    httpStatus: number | null,
    error: unknown,
    hooks: RequestHooks<T>,
  ): never {
    this.cleanup(active.id, timeout);
    const requestError = error instanceof Error ? error : new Error("Request failed.");
    const outcome = outcomeFor(active.operation, active.phase, requestError);
    if (this.timeline.has(active.id)) {
      this.timeline.complete(active.id, {
        outcome,
        httpStatus: httpStatus ?? errorStatus(requestError),
        error: requestError,
      });
    }
    notifySettled(hooks.onSettled, {
      eventId: active.id,
      outcome,
      httpStatus: httpStatus ?? errorStatus(requestError),
      error,
    });
    throw error;
  }

  private cleanup(id: number, timeout: ReturnType<typeof globalThis.setTimeout> | null): void {
    if (timeout !== null) {
      globalThis.clearTimeout(timeout);
    }
    this.#active.delete(id);
  }
}

function notifySettled<T>(
  hook: ((completion: RequestCompletion<T>) => void) | undefined,
  completion: RequestCompletion<T>,
): void {
  try {
    hook?.(completion);
  } catch {
    // Timeline annotations must not change the request's result.
  }
}

function forcedAbortError(signal: AbortSignal, timeoutTriggered: boolean): TemiApiError | null {
  if (!signal.aborted) return null;
  return new TemiApiError(timeoutTriggered ? "timeout" : "aborted", null);
}

function outcomeFor(
  operation: ApiOperation,
  phase: RunState,
  error: Error,
): Exclude<TimelineOutcome, "queued" | "pending"> {
  const kind = error instanceof TemiApiError ? error.kind : "unknown";
  if (
    kind === "http" ||
    kind === "unauthorized" ||
    (error instanceof TemiApiError && error.status !== null && error.status >= 400)
  ) {
    return "failed";
  }
  if (kind === "aborted") {
    return API_OPERATION_CONTRACTS[operation].sideEffect === "write" ? "unknown" : "cancelled";
  }
  if (
    kind === "network" ||
    kind === "timeout" ||
    kind === "invalid_response" ||
    kind === "unknown"
  ) {
    return API_OPERATION_CONTRACTS[operation].sideEffect === "write" || phase === "running"
      ? "unknown"
      : "failed";
  }
  return "failed";
}

function errorStatus(error: Error): number | null {
  if (error instanceof TemiApiError) return error.status;
  return null;
}
