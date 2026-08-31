export const RUN_STATES = [
  "idle",
  "verifying",
  "discovering",
  "composing",
  "validating",
  "ready",
  "starting",
  "running",
  "stopping",
  "terminal",
  "failed",
  "unknown",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export type RunIdentity = Readonly<{
  serialNumber: string;
  sequenceId: string | null;
}>;

export type RunStateSnapshot = Readonly<{
  phase: RunState;
  activeRun: RunIdentity | null;
}>;

type TransitionOptions = {
  activeRun?: RunIdentity | null;
};

const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze({
  idle: ["verifying"],
  verifying: ["discovering", "failed", "unknown"],
  discovering: ["composing", "failed", "unknown"],
  composing: ["validating", "failed", "unknown"],
  validating: ["ready", "composing", "failed", "unknown"],
  ready: ["starting", "composing", "failed", "unknown"],
  starting: ["running", "failed", "unknown"],
  running: ["stopping", "terminal", "unknown", "failed"],
  stopping: ["running", "terminal", "failed", "unknown"],
  terminal: ["composing", "validating", "starting"],
  failed: [],
  unknown: ["running", "stopping", "failed"],
});

export function createRunState(): RunStateSnapshot {
  return freezeState({ phase: "idle", activeRun: null });
}

export function canTransitionRunState(from: RunState, to: RunState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionRunState(
  current: RunStateSnapshot,
  next: RunState,
  options: TransitionOptions = {},
): RunStateSnapshot {
  if (!canTransitionRunState(current.phase, next)) {
    throw new Error(`Illegal run state transition: ${current.phase} -> ${next}.`);
  }

  const requestedRun = Object.prototype.hasOwnProperty.call(options, "activeRun")
    ? options.activeRun ?? null
    : current.activeRun;

  if (next === "starting" && !isStartingIdentity(requestedRun)) {
    throw new Error("Starting a run requires a serial number.");
  }

  if (next === "running" && !isAcceptedIdentity(requestedRun)) {
    throw new Error("Running a run requires a sequence identity.");
  }

  if (next === "stopping" && !isAcceptedIdentity(requestedRun)) {
    throw new Error("Stopping a run requires a sequence identity.");
  }

  return freezeState({
    phase: next,
    activeRun: activeRunForState(next, requestedRun),
  });
}

export function beginRun(current: RunStateSnapshot, serialNumber: string): RunStateSnapshot {
  if (serialNumber.trim().length === 0) {
    throw new Error("Starting a run requires a serial number.");
  }
  return transitionRunState(current, "starting", {
    activeRun: { serialNumber, sequenceId: null },
  });
}

export function acceptRun(current: RunStateSnapshot, sequenceId: string): RunStateSnapshot {
  if (sequenceId.trim().length === 0) {
    throw new Error("Accepting a run requires a sequence identity.");
  }
  if (current.activeRun === null) {
    throw new Error("Accepting a run requires an active starting run.");
  }
  return transitionRunState(current, "running", {
    activeRun: { ...current.activeRun, sequenceId },
  });
}

export function requestStop(current: RunStateSnapshot): RunStateSnapshot {
  return transitionRunState(current, "stopping");
}

export function recoverUnknown(current: RunStateSnapshot): RunStateSnapshot {
  if (current.phase !== "unknown" || !isAcceptedIdentity(current.activeRun)) {
    throw new Error("Only an unknown active run can resume observation.");
  }
  return transitionRunState(current, "running");
}

export function resetRunState(): RunStateSnapshot {
  return createRunState();
}

export function hasActiveRun(state: RunStateSnapshot): boolean {
  return (
    (state.phase === "starting" ||
      state.phase === "running" ||
      state.phase === "stopping" ||
      state.phase === "unknown") &&
    state.activeRun !== null
  );
}

export function canStartPlay(state: RunStateSnapshot): boolean {
  return (state.phase === "ready" || state.phase === "terminal") && !hasActiveRun(state);
}

export function canStopRun(state: RunStateSnapshot): boolean {
  return (
    (state.phase === "running" || state.phase === "unknown") &&
    isAcceptedIdentity(state.activeRun)
  );
}

function activeRunForState(next: RunState, run: RunIdentity | null): RunIdentity | null {
  if (
    next === "idle" ||
    next === "composing" ||
    next === "ready" ||
    next === "terminal" ||
    next === "failed"
  ) {
    return null;
  }
  return run;
}

function isStartingIdentity(run: RunIdentity | null): run is RunIdentity {
  return run !== null && run.serialNumber.trim().length > 0 && run.sequenceId === null;
}

function isAcceptedIdentity(run: RunIdentity | null): run is RunIdentity {
  return run !== null && run.serialNumber.trim().length > 0 && run.sequenceId !== null && run.sequenceId.trim().length > 0;
}

function freezeState(state: { phase: RunState; activeRun: RunIdentity | null }): RunStateSnapshot {
  if (state.activeRun !== null) {
    Object.freeze(state.activeRun);
  }
  return Object.freeze(state);
}
