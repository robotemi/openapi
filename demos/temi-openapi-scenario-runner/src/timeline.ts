import { isAbortError, TemiApiError, type ErrorCode, type ValidationHint } from "./api";
import type { RunState } from "./run-state";

export const API_OPERATION_CONTRACTS = {
  verify: { method: "GET", path: "/verify", sideEffect: "read" },
  listRobots: { method: "GET", path: "/robots", sideEffect: "read" },
  getRobotStatus: { method: "GET", path: "/robots/{serialNumber}", sideEffect: "read" },
  listRobotLocations: {
    method: "GET",
    path: "/robots/{serialNumber}/locations",
    sideEffect: "read",
  },
  listRobotContacts: {
    method: "GET",
    path: "/robots/{serialNumber}/contacts",
    sideEffect: "read",
  },
  validateSequence: { method: "POST", path: "/sequences/validate", sideEffect: "read" },
  playSequence: { method: "POST", path: "/sequences/play", sideEffect: "write" },
  stopSequence: { method: "POST", path: "/sequences/stop", sideEffect: "write" },
} as const;

export type ApiOperation = keyof typeof API_OPERATION_CONTRACTS;
export type TimelineOutcome =
  | "queued"
  | "pending"
  | "succeeded"
  | "failed"
  | "unknown"
  | "cancelled";

export type TimelineObservation =
  | "completed"
  | "aborted"
  | "stopped"
  | "observation_unknown"
  | "identity_mismatch";

export type SafeSummaryValue =
  | string
  | number
  | boolean
  | readonly (string | number)[];
export type SafeSummary = Readonly<Record<string, SafeSummaryValue>>;

export type TimelineErrorKind =
  | "unauthorized"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "invalid_response"
  | "unknown";

export type SafeErrorSummary = Readonly<{
  kind: TimelineErrorKind;
  status: number | null;
  code: ErrorCode | null;
  validationHint: ValidationHint | null;
}>;

export type TimelineEvent = Readonly<{
  id: number;
  phase: RunState;
  operation: ApiOperation;
  method: "GET" | "POST";
  path: string;
  requestSummary: SafeSummary;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  outcome: TimelineOutcome;
  responseSummary: SafeSummary | null;
  errorSummary: SafeErrorSummary | null;
  explanation: string;
}>;

export type TimelineEnqueueInput = Readonly<{
  phase: RunState;
  operation: ApiOperation;
  requestSummary?: unknown;
}>;

export type TimelineCompletionInput = Readonly<{
  outcome: Exclude<TimelineOutcome, "queued" | "pending">;
  httpStatus?: number | null;
  response?: unknown;
  error?: unknown;
}>;

export type TimelineAnnotation = Readonly<{
  observation?: TimelineObservation;
  explanation?: string;
}>;

type MutableTimelineEvent = {
  id: number;
  phase: RunState;
  operation: ApiOperation;
  method: "GET" | "POST";
  path: string;
  requestSummary: SafeSummary;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  outcome: TimelineOutcome;
  responseSummary: SafeSummary | null;
  errorSummary: SafeErrorSummary | null;
  explanation: string;
};

export class TimelineStore {
  #events: MutableTimelineEvent[] = [];
  #nextId = 1;
  #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  enqueue(input: TimelineEnqueueInput): number {
    const contract = API_OPERATION_CONTRACTS[input.operation];
    const event: MutableTimelineEvent = {
      id: this.#nextId++,
      phase: input.phase,
      operation: input.operation,
      method: contract.method,
      path: contract.path,
      requestSummary: sanitizeRequestSummary(input.operation, input.requestSummary),
      startedAt: null,
      endedAt: null,
      durationMs: null,
      httpStatus: null,
      outcome: "queued",
      responseSummary: null,
      errorSummary: null,
      explanation: "Request queued.",
    };
    this.#events.push(event);
    return event.id;
  }

  start(id: number): void {
    const event = this.find(id);
    if (event.outcome !== "queued") {
      throw new Error(`Timeline event ${id} is already started.`);
    }
    event.startedAt = this.#now();
    event.outcome = "pending";
    event.explanation = "Request is pending.";
  }

  complete(id: number, input: TimelineCompletionInput): void {
    const event = this.find(id);
    if (event.startedAt === null || event.endedAt !== null) {
      throw new Error(`Timeline event ${id} is not pending.`);
    }

    event.endedAt = this.#now();
    event.durationMs = Math.max(0, event.endedAt - event.startedAt);
    event.httpStatus = safeHttpStatus(input.httpStatus);
    event.outcome = input.outcome;
    event.responseSummary =
      input.response === undefined
        ? null
        : sanitizeResponseSummary(event.operation, input.response);
    event.errorSummary = input.error === undefined ? null : sanitizeErrorSummary(input.error);
    event.explanation = explainOutcome(
      event.operation,
      event.outcome,
      event.httpStatus,
      event.responseSummary,
    );
  }

  annotate(id: number, input: TimelineAnnotation): void {
    const event = this.find(id);
    if (event.endedAt === null) {
      throw new Error(`Timeline event ${id} is not complete.`);
    }
    if (input.observation !== undefined) {
      event.responseSummary = freezeSummary({
        ...(event.responseSummary ?? {}),
        observation: input.observation,
      });
    }
    if (input.explanation !== undefined) {
      event.explanation = input.explanation;
    }
  }

  has(id: number): boolean {
    return this.#events.some((event) => event.id === id);
  }

  clear(): void {
    this.#events = [];
  }

  getEvents(): readonly TimelineEvent[] {
    return this.#events.map(copyEvent);
  }

  private find(id: number): MutableTimelineEvent {
    const event = this.#events.find((candidate) => candidate.id === id);
    if (!event) {
      throw new Error(`Timeline event ${id} does not exist.`);
    }
    return event;
  }
}

export function sanitizeRequestSummary(operation: ApiOperation, input: unknown = {}): SafeSummary {
  const record = asRecord(input);
  if (operation === "validateSequence" || operation === "playSequence") {
    const actions = Array.isArray(record.actions) ? record.actions : [];
    const actionRecords = actions.map(asRecord);
    return freezeSummary({
      actionCount: actions.length,
      actionTypes: actionRecords.flatMap((action) =>
        isSequenceActionType(action.type) ? [action.type] : [],
      ),
      steps: actionRecords.flatMap((action) => isStep(action.step) ? [action.step] : []),
    });
  }

  if (operation === "stopSequence") {
    return freezeSummary({ sequenceIdPresent: hasNonEmptyString(record.sequenceId) });
  }

  if (
    operation === "getRobotStatus" ||
    operation === "listRobotLocations" ||
    operation === "listRobotContacts"
  ) {
    return freezeSummary({ serialNumberPresent: hasNonEmptyString(record.serialNumber) });
  }

  return freezeSummary({});
}

export function sanitizeResponseSummary(operation: ApiOperation, input: unknown): SafeSummary {
  const record = asRecord(input);
  if (operation === "listRobots") {
    return freezeSummary({ robotCount: arrayLength(record.robots) });
  }
  if (operation === "listRobotLocations") {
    return freezeSummary({ locationCount: arrayLength(record.locations) });
  }
  if (operation === "listRobotContacts") {
    return freezeSummary({ contactCount: arrayLength(record.contacts) });
  }
  if (operation === "getRobotStatus") {
    const sequenceKnown = record.sequence !== undefined && record.sequence !== null;
    const sequence = asRecord(record.sequence);
    return freezeSummary({
      status: safeStatus(record.status) ?? "unknown / unavailable",
      movementKnown: record.movement !== undefined && record.movement !== null,
      sequenceKnown,
      sequenceStatus: sequenceKnown ? safeStatus(sequence.status) ?? "unknown / unavailable" : "absent",
      callKnown: record.call !== undefined && record.call !== null,
      batteryKnown: record.battery !== undefined && record.battery !== null,
    });
  }
  if (operation === "verify") {
    return freezeSummary({
      status: safeStatus(record.status) ?? "unknown / unavailable",
      scopeCount: arrayLength(record.scopes),
      robotScope: safeRobotScope(record.robotScope) ?? "unknown / unavailable",
      selectedRobotCount: arrayLength(record.serialNumbers),
    });
  }
  if (operation === "validateSequence") {
    return optionalSummary({ status: safeStatus(record.status) });
  }
  return freezeSummary({ sequenceIdPresent: hasNonEmptyString(record.sequenceId) });
}

export function sanitizeErrorSummary(error: unknown): SafeErrorSummary {
  if (error instanceof TemiApiError) {
    return freezeErrorSummary({
      kind: error.kind,
      status: safeHttpStatus(error.status),
      code: error.code,
      validationHint: error.validationHint,
    });
  }

  if (isAbortError(error)) {
    return freezeErrorSummary({ kind: "aborted", status: null, code: null, validationHint: null });
  }

  return freezeErrorSummary({ kind: "unknown", status: null, code: null, validationHint: null });
}

function explainOutcome(
  operation: ApiOperation,
  outcome: Exclude<TimelineOutcome, "queued" | "pending">,
  status: number | null,
  response: SafeSummary | null,
): string {
  if (outcome === "succeeded") {
    switch (operation) {
      case "verify":
        return "verify succeeded; continue with GET /robots.";
      case "listRobots":
        if (response?.robotCount === 0) {
          return "robots returned no accessible PRO robots; no hardware serialNumber can be selected and no downstream reads will start.";
        }
        return "robots succeeded; choose a hardware serialNumber to read status, locations, and contacts in parallel.";
      case "getRobotStatus":
        return "status succeeded; only online enters Play preparation. Missing facts stay unknown/unavailable; this is last-known, not realtime.";
      case "listRobotLocations":
        if (response?.locationCount === 0) {
          return "locations returned no selectable items; MOVEMENT remains unavailable.";
        }
        return "locations succeeded; these choices can enable MOVEMENT only.";
      case "listRobotContacts":
        if (response?.contactCount === 0) {
          return "contacts returned no selectable items; START_CALL remains unavailable.";
        }
        return "contacts succeeded; these choices can enable START_CALL only.";
      default:
        return `${operation} completed.`;
    }
  }
  if (outcome === "failed") {
    const rejection = status === null
      ? `${operation} failed with a known request error.`
      : `${operation} was rejected with HTTP ${status}.`;
    switch (operation) {
      case "verify":
        return `${rejection} No GET /robots request will be sent.`;
      case "listRobots":
        return `${rejection} Robot selection and the three robot reads cannot start.`;
      case "getRobotStatus":
        return `${rejection} Play preparation stays blocked; the operator can refresh status.`;
      case "listRobotLocations":
        return `${rejection} MOVEMENT is disabled; SPEAK and successful contacts are unaffected.`;
      case "listRobotContacts":
        return `${rejection} START_CALL is disabled; SPEAK and successful locations are unaffected.`;
      default:
        return rejection;
    }
  }
  if (outcome === "cancelled") return `${operation} was cancelled before completion.`;
  return `${operation} may have had a side effect; the result is not confirmed.`;
}

function copyEvent(event: MutableTimelineEvent): TimelineEvent {
  return Object.freeze({
    ...event,
    requestSummary: cloneSummary(event.requestSummary),
    responseSummary: event.responseSummary === null ? null : cloneSummary(event.responseSummary),
    errorSummary: event.errorSummary === null ? null : Object.freeze({ ...event.errorSummary }),
  });
}

function cloneSummary(summary: SafeSummary): SafeSummary {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(summary).map(([key, value]) => [
        key,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ]),
    ),
  );
}

function freezeSummary(summary: Record<string, SafeSummaryValue>): SafeSummary {
  return cloneSummary(summary);
}

function optionalSummary(values: Record<string, SafeSummaryValue | undefined>): SafeSummary {
  return freezeSummary(
    Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<
      string,
      SafeSummaryValue
    >,
  );
}

function freezeErrorSummary(summary: SafeErrorSummary): SafeErrorSummary {
  return Object.freeze(summary);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isSequenceActionType(value: unknown): value is "MOVEMENT" | "SPEAK" | "START_CALL" {
  return value === "MOVEMENT" || value === "SPEAK" || value === "START_CALL";
}

function isStep(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function safeStatus(value: unknown): string | undefined {
  if (
    value === "ok" ||
    value === "success" ||
    value === "online" ||
    value === "offline" ||
    value === "busy" ||
    value === "privacy" ||
    value === "start" ||
    value === "running" ||
    value === "succeeded" ||
    value === "complete" ||
    value === "completed" ||
    value === "abort" ||
    value === "stop" ||
    value === "idle" ||
    value === "stopped" ||
    value === "aborted" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "canceled"
  ) {
    return value;
  }
  return undefined;
}

function safeRobotScope(value: unknown): "all" | "selected" | undefined {
  return value === "all" || value === "selected" ? value : undefined;
}

function safeHttpStatus(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}
