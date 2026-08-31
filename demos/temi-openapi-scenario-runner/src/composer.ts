import {
  TemiApiError,
  type ContactId,
  type Environment,
  type ErrorCode,
  type PlaySequenceRequest,
  type SequenceAction,
  type SequenceActionType,
  type TemiApiClient,
  type TemiApiErrorKind,
  type ValidationHint,
} from "./api";
import { RequestOrchestrator } from "./orchestrator";

export type ComposerOption = Readonly<{
  value: string;
  label: string;
}>;

export type ComposerContext = Readonly<{
  environment: Environment;
  serialNumber: string;
  /** null means the corresponding discovery request did not succeed. */
  locations: readonly ComposerOption[] | null;
  /** null means the corresponding discovery request did not succeed. */
  contacts: readonly ComposerOption[] | null;
}>;

export type SequenceActionDraft =
  | Readonly<{
      id: string;
      type: "MOVEMENT";
      location: string;
    }>
  | Readonly<{
      id: string;
      type: "SPEAK";
      tts: string;
    }>
  | Readonly<{
      id: string;
      type: "START_CALL";
      contactIds: readonly string[];
    }>;

export type ComposerValidationIssue = Readonly<{
  actionId: string | null;
  step: number | null;
  field: "sequence" | "location" | "tts" | "contactIds" | "step";
  message: string;
}>;

export type ComposerValidationError = Readonly<{
  kind: TemiApiErrorKind | "unknown";
  status: number | null;
  code: ErrorCode | null;
  validationHint: ValidationHint | null;
  actionSteps: readonly number[];
}>;

export type SequenceComposerValidation = Readonly<{
  status: "unvalidated" | "pending" | "succeeded" | "failed";
  issues: readonly ComposerValidationIssue[];
  error: ComposerValidationError | null;
}>;

export type SequenceComposerState = Readonly<{
  context: ComposerContext | null;
  actions: readonly SequenceActionDraft[];
  validation: SequenceComposerValidation;
}>;

export type ComposerInspection = Readonly<{
  valid: boolean;
  request: PlaySequenceRequest | null;
  issues: readonly ComposerValidationIssue[];
}>;

export type SequenceComposerOptions = Readonly<{
  onChange?: (state: SequenceComposerState) => void;
}>;

export type ComposerValidationClient = Pick<TemiApiClient, "validateSequence">;

export class SequenceComposerError extends Error {
  readonly kind: "not_ready" | "resource_unavailable" | "validation_pending" | "unknown_action";

  constructor(
    kind: SequenceComposerError["kind"],
    message: string,
  ) {
    super(message);
    this.name = "SequenceComposerError";
    this.kind = kind;
  }
}

export class SequenceComposer {
  #context: ComposerContext | null = null;
  #actions: SequenceActionDraft[] = [];
  #validation: SequenceComposerValidation = unvalidatedValidation();
  #validatedRequest: PlaySequenceRequest | null = null;
  #pendingValidation: Promise<SequenceComposerValidation> | null = null;
  #version = 0;
  #nextActionId = 1;
  #onChange: ((state: SequenceComposerState) => void) | undefined;

  constructor(options: SequenceComposerOptions = {}) {
    this.#onChange = options.onChange;
  }

  get state(): SequenceComposerState {
    return this.snapshot();
  }

  setContext(context: ComposerContext): void {
    if (this.#pendingValidation !== null) {
      throw new SequenceComposerError(
        "validation_pending",
        "The sequence cannot change while validation is pending.",
      );
    }

    const nextContext = normaliseContext(context);
    const previousContext = this.#context;
    const contextChanged = !sameContext(previousContext, nextContext);
    if (!contextChanged) return;

    const robotChanged =
      previousContext?.environment !== nextContext.environment ||
      previousContext?.serialNumber !== nextContext.serialNumber;
    this.#context = nextContext;
    if (robotChanged) {
      this.#actions = [];
    }
    this.invalidateValidation();
  }

  addAction(type: SequenceActionType): string {
    this.assertEditable();
    const context = this.requireContext();
    ensureActionResource(context, type);

    const id = `action-${this.#nextActionId++}`;
    if (type === "MOVEMENT") {
      this.#actions.push({ id, type, location: "" });
    } else if (type === "SPEAK") {
      this.#actions.push({ id, type, tts: "" });
    } else {
      this.#actions.push({ id, type, contactIds: [] });
    }
    this.invalidateValidation();
    return id;
  }

  removeAction(id: string): void {
    this.assertEditable();
    const index = this.actionIndex(id);
    this.#actions.splice(index, 1);
    this.invalidateValidation();
  }

  moveAction(id: string, direction: "up" | "down"): void {
    this.assertEditable();
    const index = this.actionIndex(id);
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= this.#actions.length) return;
    const current = this.#actions[index];
    this.#actions[index] = this.#actions[nextIndex];
    this.#actions[nextIndex] = current;
    this.invalidateValidation();
  }

  setMovementLocation(id: string, location: string): void {
    this.assertEditable();
    const action = this.action(id);
    if (action.type !== "MOVEMENT") {
      throw new SequenceComposerError("unknown_action", "The selected action is not MOVEMENT.");
    }
    if (action.location === location) return;
    this.#actions[this.actionIndex(id)] = { ...action, location };
    this.invalidateValidation();
  }

  setSpeakText(id: string, tts: string): void {
    this.assertEditable();
    const action = this.action(id);
    if (action.type !== "SPEAK") {
      throw new SequenceComposerError("unknown_action", "The selected action is not SPEAK.");
    }
    if (action.tts === tts) return;
    this.#actions[this.actionIndex(id)] = { ...action, tts };
    this.invalidateValidation();
  }

  setCallContacts(id: string, contactIds: readonly string[]): void {
    this.assertEditable();
    const action = this.action(id);
    if (action.type !== "START_CALL") {
      throw new SequenceComposerError("unknown_action", "The selected action is not START_CALL.");
    }
    if (sameStringArray(action.contactIds, contactIds)) return;
    this.#actions[this.actionIndex(id)] = { ...action, contactIds: [...contactIds] };
    this.invalidateValidation();
  }

  previewRequest(): PlaySequenceRequest | null {
    if (this.#context === null) return null;
    return buildPlaySequenceRequest(this.#context.serialNumber, this.#actions);
  }

  inspect(): ComposerInspection {
    const request = this.previewRequest();
    if (this.#context === null || request === null) {
      return {
        valid: false,
        request: null,
        issues: [issue(null, null, "sequence", "Select a robot before preparing a sequence.")],
      };
    }

    const issues = collectValidationIssues(this.#context, this.#actions, request);
    return {
      valid: issues.length === 0,
      request: issues.length === 0 ? request : null,
      issues,
    };
  }

  validate(
    client: ComposerValidationClient,
    orchestrator: RequestOrchestrator,
  ): Promise<SequenceComposerValidation> {
    if (this.#pendingValidation !== null) return this.#pendingValidation;

    const inspection = this.inspect();
    if (!inspection.valid || inspection.request === null) {
      this.#validatedRequest = null;
      this.#validation = freezeValidation({
        status: "failed",
        issues: inspection.issues,
        error: null,
      });
      this.notify();
      return Promise.resolve(this.#validation);
    }

    const request = inspection.request;
    const version = this.#version;
    this.#validatedRequest = null;
    this.#validation = freezeValidation({ status: "pending", issues: [], error: null });
    this.notify();

    let pending: Promise<SequenceComposerValidation>;
    pending = orchestrator
      .execute(
        {
          phase: "validating",
          operation: "validateSequence",
          requestSummary: request,
        },
        (options) => client.validateSequence(request, options),
      )
      .then(
        () => {
          if (version !== this.#version) return this.#validation;
          this.#validatedRequest = cloneRequest(request);
          this.#validation = freezeValidation({ status: "succeeded", issues: [], error: null });
          this.notify();
          return this.#validation;
        },
        (error: unknown) => {
          if (version === this.#version) {
            this.#validatedRequest = null;
            this.#validation = freezeValidation({
              status: "failed",
              issues: [],
              error: safeValidationError(error, request),
            });
            this.notify();
          }
          throw error;
        },
      )
      .finally(() => {
        if (this.#pendingValidation === pending) {
          this.#pendingValidation = null;
        }
      });
    this.#pendingValidation = pending;
    return pending;
  }

  getValidatedRequest(): PlaySequenceRequest | null {
    return this.#validatedRequest === null ? null : cloneRequest(this.#validatedRequest);
  }

  private requireContext(): ComposerContext {
    if (this.#context === null) {
      throw new SequenceComposerError("not_ready", "Select a robot before adding an action.");
    }
    return this.#context;
  }

  private assertEditable(): void {
    if (this.#pendingValidation !== null) {
      throw new SequenceComposerError(
        "validation_pending",
        "The sequence cannot change while validation is pending.",
      );
    }
  }

  private action(id: string): SequenceActionDraft {
    const action = this.#actions.find((candidate) => candidate.id === id);
    if (action === undefined) {
      throw new SequenceComposerError("unknown_action", `Unknown sequence action: ${id}.`);
    }
    return action;
  }

  private actionIndex(id: string): number {
    const index = this.#actions.findIndex((candidate) => candidate.id === id);
    if (index < 0) {
      throw new SequenceComposerError("unknown_action", `Unknown sequence action: ${id}.`);
    }
    return index;
  }

  private invalidateValidation(): void {
    this.#version += 1;
    this.#validatedRequest = null;
    this.#validation = unvalidatedValidation();
    this.notify();
  }

  private snapshot(): SequenceComposerState {
    return Object.freeze({
      context: this.#context,
      actions: Object.freeze(this.#actions.map(freezeDraft)),
      validation: this.#validation,
    });
  }

  private notify(): void {
    this.#onChange?.(this.snapshot());
  }
}

export function buildPlaySequenceRequest(
  serialNumber: string,
  actions: readonly SequenceActionDraft[],
): PlaySequenceRequest {
  if (serialNumber.trim().length === 0) {
    throw new SequenceComposerError("not_ready", "A selected robot serialNumber is required.");
  }
  return {
    serialNumber,
    actions: actions.map((action, index) => actionToSequenceAction(action, index + 1)),
  };
}

function actionToSequenceAction(action: SequenceActionDraft, step: number): SequenceAction {
  if (action.type === "MOVEMENT") {
    return { type: action.type, step, location: action.location };
  }
  if (action.type === "SPEAK") {
    return { type: action.type, step, tts: action.tts };
  }
  return {
    type: action.type,
    step,
    contactIds: action.contactIds.map((contactId): ContactId => contactId),
  };
}

function collectValidationIssues(
  context: ComposerContext,
  actions: readonly SequenceActionDraft[],
  request: PlaySequenceRequest,
): readonly ComposerValidationIssue[] {
  const issues: ComposerValidationIssue[] = [];
  if (actions.length === 0) {
    issues.push(issue(null, null, "sequence", "Add at least one action before validation."));
    return issues;
  }

  if (!hasContiguousSteps(request)) {
    issues.push(issue(null, null, "step", "Sequence steps must start at 1 and be consecutive."));
  }

  actions.forEach((action, index) => {
    const step = index + 1;
    if (action.type === "MOVEMENT") {
      if (context.locations === null) {
        issues.push(issue(action.id, step, "location", "Locations must load successfully before MOVEMENT can be validated."));
      } else if (!hasOption(context.locations, action.location)) {
        issues.push(issue(action.id, step, "location", "Choose a location from the current robot locations."));
      }
    }

    if (action.type === "SPEAK" && action.tts.trim().length === 0) {
      issues.push(issue(action.id, step, "tts", "SPEAK requires non-empty tts."));
    }

    if (action.type === "START_CALL") {
      if (context.contacts === null) {
        issues.push(issue(action.id, step, "contactIds", "Contacts must load successfully before START_CALL can be validated."));
        return;
      }
      if (action.contactIds.length === 0) {
        issues.push(issue(action.id, step, "contactIds", "Choose at least one contact for START_CALL."));
        return;
      }
      const trimmedIds = action.contactIds.map((contactId) => contactId.trim());
      if (trimmedIds.some((contactId) => contactId.length === 0)) {
        issues.push(issue(action.id, step, "contactIds", "START_CALL contacts cannot be empty."));
      }
      if (new Set(trimmedIds).size !== trimmedIds.length) {
        issues.push(issue(action.id, step, "contactIds", "START_CALL contacts must be unique."));
      }
      if (trimmedIds.some((contactId) => !hasOption(context.contacts!, contactId))) {
        issues.push(issue(action.id, step, "contactIds", "Choose contacts from the current robot contacts."));
      }
    }
  });

  return issues;
}

function hasContiguousSteps(request: PlaySequenceRequest): boolean {
  return request.actions.length > 0 && request.actions.every((action, index) => action.step === index + 1);
}

function ensureActionResource(context: ComposerContext, type: SequenceActionType): void {
  if (type === "MOVEMENT" && (context.locations === null || context.locations.length === 0)) {
    throw new SequenceComposerError(
      "resource_unavailable",
      "MOVEMENT requires successfully loaded robot locations.",
    );
  }
  if (type === "START_CALL" && (context.contacts === null || context.contacts.length === 0)) {
    throw new SequenceComposerError(
      "resource_unavailable",
      "START_CALL requires successfully loaded robot contacts.",
    );
  }
}

function normaliseContext(context: ComposerContext): ComposerContext {
  if (context.serialNumber.trim().length === 0) {
    throw new SequenceComposerError("not_ready", "A selected robot serialNumber is required.");
  }
  return Object.freeze({
    environment: context.environment,
    serialNumber: context.serialNumber,
    locations: normaliseOptions(context.locations),
    contacts: normaliseOptions(context.contacts),
  });
}

function normaliseOptions(options: readonly ComposerOption[] | null): readonly ComposerOption[] | null {
  if (options === null) return null;
  const seen = new Set<string>();
  const normalised: ComposerOption[] = [];
  for (const option of options) {
    if (option.value.trim().length === 0 || seen.has(option.value)) continue;
    seen.add(option.value);
    normalised.push(Object.freeze({
      value: option.value,
      label: option.label.trim().length === 0 ? option.value : option.label,
    }));
  }
  return Object.freeze(normalised);
}

function sameContext(left: ComposerContext | null, right: ComposerContext): boolean {
  if (left === null) return false;
  return (
    left.environment === right.environment &&
    left.serialNumber === right.serialNumber &&
    sameOptions(left.locations, right.locations) &&
    sameOptions(left.contacts, right.contacts)
  );
}

function sameOptions(
  left: readonly ComposerOption[] | null,
  right: readonly ComposerOption[] | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every(
    (option, index) => option.value === right[index]?.value && option.label === right[index]?.label,
  );
}

function hasOption(options: readonly ComposerOption[], value: string): boolean {
  return options.some((option) => option.value === value);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function issue(
  actionId: string | null,
  step: number | null,
  field: ComposerValidationIssue["field"],
  message: string,
): ComposerValidationIssue {
  return Object.freeze({ actionId, step, field, message });
}

function safeValidationError(
  error: unknown,
  request: PlaySequenceRequest,
): ComposerValidationError {
  if (error instanceof TemiApiError) {
    return Object.freeze({
      kind: error.kind,
      status: error.status,
      code: error.code,
      validationHint: error.validationHint,
      actionSteps: matchingActionSteps(request, error.validationHint),
    });
  }
  return Object.freeze({
    kind: "unknown",
    status: null,
    code: null,
    validationHint: null,
    actionSteps: [],
  });
}

function matchingActionSteps(
  request: PlaySequenceRequest,
  hint: ValidationHint | null,
): readonly number[] {
  if (hint === null) return [];
  return request.actions.flatMap((action, index) => {
    if (hint !== "sequence" && action.type !== hint) return [];
    return [action.step ?? index + 1];
  });
}

function unvalidatedValidation(): SequenceComposerValidation {
  return freezeValidation({ status: "unvalidated", issues: [], error: null });
}

function freezeValidation(validation: {
  status: SequenceComposerValidation["status"];
  issues: readonly ComposerValidationIssue[];
  error: ComposerValidationError | null;
}): SequenceComposerValidation {
  return Object.freeze({
    status: validation.status,
    issues: Object.freeze([...validation.issues]),
    error: validation.error,
  });
}

function freezeDraft(action: SequenceActionDraft): SequenceActionDraft {
  if (action.type === "START_CALL") {
    return Object.freeze({ ...action, contactIds: Object.freeze([...action.contactIds]) });
  }
  return Object.freeze({ ...action });
}

function cloneRequest(request: PlaySequenceRequest): PlaySequenceRequest {
  return {
    serialNumber: request.serialNumber,
    actions: request.actions.map((action) => ({
      ...action,
      ...(action.contactIds === undefined
        ? {}
        : { contactIds: action.contactIds.map((contactId) => typeof contactId === "string" ? contactId : { ...contactId }) }),
    })),
  };
}
