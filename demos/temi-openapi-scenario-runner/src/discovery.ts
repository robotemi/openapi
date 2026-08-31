import {
  TemiApiError,
  type ContactsResponse,
  type ErrorCode,
  type LocationsResponse,
  type RobotStatus,
  type RobotSummary,
  type RobotsResponse,
  type TemiApiErrorKind,
  type TemiApiClient,
  type VerifyResponse,
} from "./api";
import { RequestOrchestrator } from "./orchestrator";
import type { RunState } from "./run-state";

export type DiscoveryClient = Pick<
  TemiApiClient,
  "verify" | "listRobots" | "getRobotStatus" | "listRobotLocations" | "listRobotContacts"
>;

export type DiscoverySlotStatus = "idle" | "pending" | "succeeded" | "failed";

export type DiscoveryFailure = Readonly<{
  kind: TemiApiErrorKind | "unknown";
  status: number | null;
  code: ErrorCode | null;
}>;

export type DiscoverySlot<T> = Readonly<{
  status: DiscoverySlotStatus;
  data: T | null;
  failure: DiscoveryFailure | null;
  receivedAt: number | null;
}>;

export type DiscoveryState = Readonly<{
  verify: DiscoverySlot<VerifyResponse>;
  robots: DiscoverySlot<readonly RobotSummary[]>;
  selectedRobot: RobotSummary | null;
  status: DiscoverySlot<RobotStatus>;
  locations: DiscoverySlot<LocationsResponse>;
  contacts: DiscoverySlot<ContactsResponse>;
}>;

export type DiscoveryControllerOptions = Readonly<{
  now?: () => number;
  onChange?: (state: DiscoveryState) => void;
}>;

export class RobotSelectionError extends Error {
  readonly kind = "robot_not_found";

  constructor() {
    super("The selected robot is not in the current robot list.");
    this.name = "RobotSelectionError";
  }
}

export class RobotDiscoveryController {
  #client: DiscoveryClient;
  #orchestrator: RequestOrchestrator;
  #now: () => number;
  #onChange: ((state: DiscoveryState) => void) | undefined;
  #state: DiscoveryState = initialDiscoveryState();
  #selectionVersion = 0;

  constructor(
    client: DiscoveryClient,
    orchestrator: RequestOrchestrator,
    options: DiscoveryControllerOptions = {},
  ) {
    this.#client = client;
    this.#orchestrator = orchestrator;
    this.#now = options.now ?? (() => Date.now());
    this.#onChange = options.onChange;
  }

  get state(): DiscoveryState {
    return this.#state;
  }

  async connect(onVerified?: () => void): Promise<DiscoveryState> {
    await this.verify();
    onVerified?.();
    await this.listRobots();
    return this.#state;
  }

  async verify(): Promise<VerifyResponse> {
    this.update({ verify: pendingSlot(this.#state.verify) });
    try {
      const response = await this.#orchestrator.execute(
        { phase: "verifying", operation: "verify" },
        (options) => this.#client.verify(options),
      );
      this.update({ verify: succeededSlot(response, this.#now()) });
      return response;
    } catch (error: unknown) {
      this.update({ verify: failedSlot(error) });
      throw error;
    }
  }

  async listRobots(): Promise<readonly RobotSummary[]> {
    if (this.#state.verify.status !== "succeeded") {
      throw new Error("Robot discovery requires successful verification.");
    }

    this.update({
      robots: pendingSlot(this.#state.robots),
      selectedRobot: null,
      status: emptySlot(),
      locations: emptySlot(),
      contacts: emptySlot(),
    });
    try {
      const response = await this.#orchestrator.execute(
        { phase: "discovering", operation: "listRobots" },
        (options) => this.#client.listRobots(options),
      );
      const robots = normaliseRobots(response);
      this.update({ robots: succeededSlot(robots, this.#now()) });
      return robots;
    } catch (error: unknown) {
      this.update({ robots: failedSlot(error) });
      throw error;
    }
  }

  async selectRobot(
    serialNumber: string,
    phase: RunState = "discovering",
  ): Promise<DiscoveryState> {
    const robot = this.#state.robots.data?.find(
      (candidate) => candidate.serialNumber === serialNumber,
    );
    if (robot === undefined) {
      throw new RobotSelectionError();
    }

    const version = ++this.#selectionVersion;
    this.update({
      selectedRobot: robot,
      status: emptySlot(),
      locations: emptySlot(),
      contacts: emptySlot(),
    });

    const [statusResult, locationsResult, contactsResult] = await Promise.allSettled([
      this.#orchestrator.execute(
        { phase, operation: "getRobotStatus", requestSummary: { serialNumber } },
        (options) => this.#client.getRobotStatus(serialNumber, options),
      ),
      this.#orchestrator.execute(
        { phase, operation: "listRobotLocations", requestSummary: { serialNumber } },
        (options) => this.#client.listRobotLocations(serialNumber, options),
      ),
      this.#orchestrator.execute(
        { phase, operation: "listRobotContacts", requestSummary: { serialNumber } },
        (options) => this.#client.listRobotContacts(serialNumber, options),
      ),
    ]);

    const unauthorized = [statusResult, locationsResult, contactsResult].find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" && discoveryFailure(result.reason).kind === "unauthorized",
    );
    if (unauthorized !== undefined) {
      if (version === this.#selectionVersion) {
        this.update({
          status: slotFromResult(statusResult, this.#now()),
          locations: slotFromResult(locationsResult, this.#now()),
          contacts: slotFromResult(contactsResult, this.#now()),
        });
      }
      throw unauthorized.reason;
    }

    if (version !== this.#selectionVersion) {
      return this.#state;
    }

    this.update({
      status: slotFromResult(statusResult, this.#now()),
      locations: slotFromResult(locationsResult, this.#now()),
      contacts: slotFromResult(contactsResult, this.#now()),
    });
    return this.#state;
  }

  async refreshStatus(phase: RunState = "composing"): Promise<DiscoveryState> {
    const robot = this.#state.selectedRobot;
    if (robot === null) {
      throw new RobotSelectionError();
    }

    const version = this.#selectionVersion;
    const previous = this.#state.status;
    this.update({ status: pendingSlot(previous) });
    try {
      const response = await this.#orchestrator.execute(
        {
          phase,
          operation: "getRobotStatus",
          requestSummary: { serialNumber: robot.serialNumber },
        },
        (options) => this.#client.getRobotStatus(robot.serialNumber, options),
      );
      if (version !== this.#selectionVersion) return this.#state;
      this.update({ status: succeededSlot(response, this.#now()) });
      return this.#state;
    } catch (error: unknown) {
      if (discoveryFailure(error).kind === "unauthorized") {
        throw error;
      }
      if (version !== this.#selectionVersion) return this.#state;
      this.update({
        status: {
          status: "failed",
          data: previous.data,
          failure: discoveryFailure(error),
          receivedAt: previous.receivedAt,
        },
      });
      throw error;
    }
  }

  recordStatusSnapshot(response: RobotStatus, receivedAt = this.#now()): void {
    const selectedRobot = this.#state.selectedRobot;
    if (selectedRobot === null || response.serialNumber !== selectedRobot.serialNumber) return;
    this.update({ status: succeededSlot(response, receivedAt) });
  }

  clearSelection(): void {
    this.#selectionVersion += 1;
    this.update({
      selectedRobot: null,
      status: emptySlot(),
      locations: emptySlot(),
      contacts: emptySlot(),
    });
  }

  private update(changes: Partial<DiscoveryState>): void {
    this.#state = { ...this.#state, ...changes };
    this.#onChange?.(this.#state);
  }
}

export function initialDiscoveryState(): DiscoveryState {
  return {
    verify: emptySlot(),
    robots: emptySlot(),
    selectedRobot: null,
    status: emptySlot(),
    locations: emptySlot(),
    contacts: emptySlot(),
  };
}

export function discoveryFailure(error: unknown): DiscoveryFailure {
  if (error instanceof TemiApiError) {
    return { kind: error.kind, status: error.status, code: error.code };
  }
  return { kind: "unknown", status: null, code: null };
}

export type DiscoveryAction = "MOVEMENT" | "SPEAK" | "START_CALL";

export type ActionAvailability = Readonly<{
  enabled: boolean;
  reason: string;
  requiredScope?: string;
}>;

export type PlayReadiness = Readonly<{
  ready: boolean;
  reason: string;
  requiredScope?: string;
}>;

export function actionAvailability(
  state: DiscoveryState,
  action: DiscoveryAction,
): ActionAvailability {
  if (state.selectedRobot === null) {
    return { enabled: false, reason: "Select a robot before preparing an action." };
  }

  if (action === "SPEAK") {
    return { enabled: true, reason: "SPEAK does not depend on locations or contacts." };
  }

  const requiredScope =
    action === "MOVEMENT" ? "read:robot:locations" : "read:robot:contact";
  const verify = state.verify.data;
  if (verify?.robotScope === "selected" && Array.isArray(verify.serialNumbers)) {
    if (!verify.serialNumbers.includes(state.selectedRobot.serialNumber)) {
      return {
        enabled: false,
        requiredScope,
        reason: "The selected robot is outside this token's robot scope.",
      };
    }
  }
  if (Array.isArray(verify?.scopes) && !verify.scopes.includes(requiredScope)) {
    return {
      enabled: false,
      requiredScope,
      reason: `The token does not advertise ${requiredScope}; the server remains the final authorization authority.`,
    };
  }

  const slot = action === "MOVEMENT" ? state.locations : state.contacts;
  if (slot.status === "pending") {
    return { enabled: false, requiredScope, reason: "The required resource is still loading." };
  }
  if (slot.status === "failed") {
    return {
      enabled: false,
      requiredScope,
      reason: "The required resource could not be read; retry it before using this action.",
    };
  }
  if (slot.status !== "succeeded") {
    return { enabled: false, requiredScope, reason: "The required resource is unavailable." };
  }

  const resourceCount = action === "MOVEMENT"
    ? Array.isArray(state.locations.data?.locations)
      ? state.locations.data.locations.filter((location) => hasText(location?.name)).length
      : 0
    : Array.isArray(state.contacts.data?.contacts)
      ? state.contacts.data.contacts.filter((contact) => hasText(contact?.temiId)).length
      : 0;
  if (resourceCount === 0) {
    return {
      enabled: false,
      requiredScope,
      reason: "The robot returned no selectable items for this action.",
    };
  }
  return { enabled: true, requiredScope, reason: "The required resource is available." };
}

export function playReadiness(state: DiscoveryState): PlayReadiness {
  if (state.selectedRobot === null) {
    return { ready: false, reason: "Select a robot before preparing Play." };
  }

  const requiredScope = "read:robot:status";
  const scopes = state.verify.data?.scopes;
  if (Array.isArray(scopes) && !scopes.includes(requiredScope)) {
    return {
      ready: false,
      requiredScope,
      reason: `The token does not advertise ${requiredScope}; the server remains the final authorization authority.`,
    };
  }
  if (state.status.status === "pending") {
    return { ready: false, requiredScope, reason: "Status is still loading." };
  }
  if (state.status.status === "failed") {
    return { ready: false, requiredScope, reason: "Status is unavailable; refresh the last-known snapshot." };
  }
  if (state.status.status !== "succeeded" || state.status.data === null) {
    return { ready: false, requiredScope, reason: "Status is unknown / unavailable." };
  }
  if (state.status.data.status === "online") {
    return { ready: true, requiredScope, reason: "Robot is online and can enter Play preparation." };
  }
  if (state.status.data.status === "offline") {
    return { ready: false, requiredScope, reason: "Play is blocked while the robot is offline; refresh status." };
  }
  if (state.status.data.status === "busy") {
    return { ready: false, requiredScope, reason: "Play is blocked while the robot is busy; refresh status." };
  }
  if (state.status.data.status === "privacy") {
    return { ready: false, requiredScope, reason: "Play is blocked while the robot is in privacy; refresh status." };
  }
  return { ready: false, requiredScope, reason: "Status is unknown / unavailable; refresh status." };
}

function emptySlot<T>(): DiscoverySlot<T> {
  return { status: "idle", data: null, failure: null, receivedAt: null };
}

function pendingSlot<T>(previous: DiscoverySlot<T>): DiscoverySlot<T> {
  return { status: "pending", data: previous.data, failure: null, receivedAt: previous.receivedAt };
}

function succeededSlot<T>(data: T, receivedAt: number): DiscoverySlot<T> {
  return { status: "succeeded", data, failure: null, receivedAt };
}

function failedSlot<T>(error: unknown): DiscoverySlot<T> {
  return { status: "failed", data: null, failure: discoveryFailure(error), receivedAt: null };
}

function slotFromResult<T>(
  result: PromiseSettledResult<T>,
  receivedAt: number,
): DiscoverySlot<T> {
  return result.status === "fulfilled"
    ? succeededSlot(result.value, receivedAt)
    : failedSlot(result.reason);
}

function normaliseRobots(response: RobotsResponse): readonly RobotSummary[] {
  if (!Array.isArray(response.robots)) return [];
  const seen = new Set<string>();
  return response.robots.flatMap((robot) => {
    if (
      typeof robot.serialNumber !== "string" ||
      robot.serialNumber.trim().length === 0 ||
      seen.has(robot.serialNumber)
    ) {
      return [];
    }
    seen.add(robot.serialNumber);
    return [
      {
        serialNumber: robot.serialNumber,
        ...(typeof robot.teminame === "string" ? { teminame: robot.teminame } : {}),
      },
    ];
  });
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
