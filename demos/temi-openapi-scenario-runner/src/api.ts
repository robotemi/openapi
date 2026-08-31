export const ENVIRONMENTS = ["production", "production-cn", "integration"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const ENVIRONMENT_BASE_URLS: Readonly<Record<Environment, string>> = Object.freeze({
  production: "https://api.robotemi.com/openapi/v1",
  "production-cn": "https://api.robotemi.cn/openapi/v1",
  integration: "https://integration.dev.temi.cloud/openapi/v1",
});

export type VerifyResponse = {
  status?: string;
  organizationId?: string;
  tokenId?: string;
  scopes?: string[];
  robotScope?: "all" | "selected";
  serialNumbers?: string[];
};

export type RobotSummary = {
  teminame?: string;
  serialNumber: string;
};

export type RobotsResponse = {
  robots?: RobotSummary[];
};

export type RobotMovementStatus = {
  type?: string;
  status?: string;
  location?: string;
};

export type RobotSequenceStatus = {
  status: string;
  name?: string;
  step?: number;
  total?: number;
  sequenceId?: string;
};

export type RobotCallStatus = {
  status: string;
  hostId?: string;
};

export type RobotBatteryStatus = {
  level?: number;
  isCharging?: boolean;
};

export type RobotStatus = RobotSummary & {
  status: "online" | "offline" | "busy" | "privacy";
  movement?: RobotMovementStatus;
  sequence?: RobotSequenceStatus;
  call?: RobotCallStatus;
  battery?: RobotBatteryStatus;
};

export type Location = {
  name?: string;
};

export type LocationsResponse = {
  serialNumber?: string;
  mapId?: string;
  mapName?: string;
  locations?: Location[];
};

export type StartCallContact = {
  temiId: string;
  platform?: "both" | "mobile" | "web";
};

export type Contact = {
  temiId?: string;
  name?: string;
  kind?: "member";
  source?: "organization";
};

export type ContactsResponse = {
  contacts?: Contact[];
};

export type SequenceActionType = "MOVEMENT" | "SPEAK" | "START_CALL";
export type ContactId = string | StartCallContact;

export type MovementExtra = {
  locationName: string;
  speed?: "high" | "medium";
  onError?: "skip" | "abort";
  personalLead?: boolean;
};

export type SpeakExtra = {
  tts: string;
  language?: string;
  display?: "none" | "text" | "talk";
  loop?: boolean;
};

export type SequenceAction = {
  type: SequenceActionType;
  step?: number;
  startStep?: number;
  endStep?: number;
  finalInEndStep?: boolean;
  delay?: number;
  actionId?: string;
  location?: string;
  tts?: string;
  language?: string;
  display?: "none" | "text" | "talk";
  contactIds?: ContactId[];
  platform?: "both" | "mobile" | "web";
  extra?: MovementExtra | SpeakExtra;
};

export type SequenceStopBy = {
  touchScreen?: boolean;
  wakeup?: boolean;
};

export type PlaySequenceRequest = {
  serialNumber: string;
  actions: SequenceAction[];
  name?: string;
  description?: string;
  volume?: number;
  fixedVolume?: boolean;
  startFromStep?: number;
  repeatSequence?: number;
  stopBy?: SequenceStopBy;
};

export type PlaySequenceResponse = {
  status?: string;
  sequenceId?: string;
  serialNumber?: string;
};

export type StopSequenceRequest = {
  sequenceId: string;
};

export type StopSequenceResponse = {
  status?: string;
  sequenceId?: string;
  serialNumber?: string;
};

export type ValidateSequenceResponse = {
  status?: string;
};

export type ErrorCode =
  | "validation_error"
  | "robot_privacy"
  | "robot_offline"
  | "robot_busy"
  | "not_found"
  | "sequence_not_running"
  | "internal_error";

export type ValidationHint = "sequence" | "MOVEMENT" | "SPEAK" | "START_CALL";

export type ErrorResponse = {
  error: string;
  error_code: ErrorCode;
};

export type TemiApiRequestOptions = Readonly<{
  signal?: AbortSignal;
  onResponseStatus?: (status: number) => void;
  onUnauthorized?: () => void;
}>;

export type TemiApiClientOptions = Readonly<{
  onReadableResponse?: (status: number) => void;
  onTransportFailure?: () => void;
}>;

export type TemiApiErrorKind =
  | "unauthorized"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "invalid_response";

export class TemiApiError extends Error {
  readonly kind: TemiApiErrorKind;
  readonly status: number | null;
  readonly code: ErrorCode | null;
  readonly validationHint: ValidationHint | null;

  constructor(
    kind: TemiApiErrorKind,
    status: number | null,
    code: ErrorCode | null = null,
    validationHint: ValidationHint | null = null,
  ) {
    super(errorMessage(kind, status));
    this.name = "TemiApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.validationHint = validationHint;
  }
}

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === "string" && (ENVIRONMENTS as readonly string[]).includes(value);
}

export class TemiApiClient {
  #oat: string | null;
  #environment: Environment;
  #onReadableResponse: ((status: number) => void) | undefined;
  #onTransportFailure: (() => void) | undefined;

  constructor(
    environment: Environment,
    oat: string,
    options: TemiApiClientOptions = {},
  ) {
    if (!isEnvironment(environment)) {
      throw new Error("Unsupported environment");
    }
    if (typeof oat !== "string" || oat.trim().length === 0) {
      throw new Error("OAT is required");
    }
    this.#environment = environment;
    this.#oat = oat;
    this.#onReadableResponse = options.onReadableResponse;
    this.#onTransportFailure = options.onTransportFailure;
  }

  clearToken(): void {
    this.#oat = null;
  }

  hasToken(): boolean {
    return this.#oat !== null;
  }

  verify(options?: TemiApiRequestOptions): Promise<VerifyResponse> {
    return this.request<VerifyResponse>("GET", "/verify", undefined, options);
  }

  listRobots(options?: TemiApiRequestOptions): Promise<RobotsResponse> {
    return this.request<RobotsResponse>("GET", "/robots", undefined, options);
  }

  getRobotStatus(serialNumber: string, options?: TemiApiRequestOptions): Promise<RobotStatus> {
    return this.request<RobotStatus>(
      "GET",
      `/robots/${encodeURIComponent(serialNumber)}`,
      undefined,
      options,
    );
  }

  listRobotLocations(
    serialNumber: string,
    options?: TemiApiRequestOptions,
  ): Promise<LocationsResponse> {
    return this.request<LocationsResponse>(
      "GET",
      `/robots/${encodeURIComponent(serialNumber)}/locations`,
      undefined,
      options,
    );
  }

  listRobotContacts(
    serialNumber: string,
    options?: TemiApiRequestOptions,
  ): Promise<ContactsResponse> {
    return this.request<ContactsResponse>(
      "GET",
      `/robots/${encodeURIComponent(serialNumber)}/contacts`,
      undefined,
      options,
    );
  }

  validateSequence(
    request: PlaySequenceRequest,
    options?: TemiApiRequestOptions,
  ): Promise<ValidateSequenceResponse> {
    return this.request<ValidateSequenceResponse>("POST", "/sequences/validate", request, options);
  }

  playSequence(
    request: PlaySequenceRequest,
    options?: TemiApiRequestOptions,
  ): Promise<PlaySequenceResponse> {
    return this.request<PlaySequenceResponse>("POST", "/sequences/play", request, options);
  }

  stopSequence(
    request: StopSequenceRequest,
    options?: TemiApiRequestOptions,
  ): Promise<StopSequenceResponse> {
    return this.request<StopSequenceResponse>("POST", "/sequences/stop", request, options);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: TemiApiRequestOptions,
  ): Promise<T> {
    const oat = this.#oat;
    if (oat === null) {
      throw new TemiApiError("unauthorized", 401);
    }

    const headers: Record<string, string> = { "x-api-key": oat };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(`${ENVIRONMENT_BASE_URLS[this.#environment]}${path}`, {
        method,
        headers,
        credentials: "omit",
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error: unknown) {
      if (options?.signal?.aborted || isAbortError(error)) {
        throw new TemiApiError(
          options?.signal?.reason === "timeout" ? "timeout" : "aborted",
          null,
        );
      }
      this.#onTransportFailure?.();
      throw new TemiApiError("network", null);
    }

    options?.onResponseStatus?.(response.status);
    this.#onReadableResponse?.(response.status);

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      if (response.status === 401) {
        options?.onUnauthorized?.();
        this.clearToken();
        throw new TemiApiError("unauthorized", 401);
      }
      throw new TemiApiError("invalid_response", response.status);
    }

    if (!response.ok) {
      if (response.status === 401) {
        options?.onUnauthorized?.();
        this.clearToken();
        throw new TemiApiError("unauthorized", 401);
      }
      const code = readErrorCode(payload);
      throw new TemiApiError(
        "http",
        response.status,
        code,
        code === "validation_error" ? readValidationHint(payload) : null,
      );
    }

    if (!isValidSuccessPayload(path, payload)) {
      throw new TemiApiError("invalid_response", response.status);
    }

    return redactToken(payload, oat) as T;
  }
}

function errorMessage(kind: TemiApiErrorKind, status: number | null): string {
  if (kind === "unauthorized") return "Request unauthorized.";
  if (kind === "network") return "Temi API request could not be completed.";
  if (kind === "timeout") return "Temi API request timed out.";
  if (kind === "aborted") return "Temi API request was aborted.";
  if (kind === "invalid_response") return "Temi API returned an invalid JSON response.";
  return `Temi API request failed with HTTP ${status ?? "unknown"}.`;
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function readErrorCode(payload: unknown): ErrorCode | null {
  if (typeof payload !== "object" || payload === null || !("error_code" in payload)) {
    return null;
  }
  const code = payload.error_code;
  return isErrorCode(code) ? code : null;
}

function readValidationHint(payload: unknown): ValidationHint | null {
  if (!isRecord(payload) || typeof payload.error !== "string") return null;
  const error = payload.error.toLowerCase();
  if (error.includes("contact") || error.includes("start_call")) return "START_CALL";
  if (error.includes("location") || error.includes("movement")) return "MOVEMENT";
  if (error.includes("tts") || error.includes("speak")) return "SPEAK";
  if (error.includes("action") || error.includes("step") || error.includes("sequence")) {
    return "sequence";
  }
  return null;
}

function isValidSuccessPayload(path: string, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (path === "/sequences/play") {
    return typeof payload.sequenceId === "string" && payload.sequenceId.trim().length > 0;
  }
  if (path === "/robots" && "robots" in payload) {
    return isRobotArray(payload.robots);
  }
  if (path.endsWith("/locations") && "locations" in payload) {
    return isObjectArray(payload.locations);
  }
  if (path.endsWith("/contacts") && "contacts" in payload) {
    return isObjectArray(payload.contacts);
  }
  if (path.startsWith("/robots/")) {
    return isRobotStatus(payload);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

function isRobotArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => isRecord(item) && typeof item.serialNumber === "string",
    )
  );
}

function isRobotStatus(value: Record<string, unknown>): boolean {
  return (
    typeof value.serialNumber === "string" &&
    /^[0-9]{11}$/.test(value.serialNumber) &&
    isRobotStatusValue(value.status)
  );
}

function isRobotStatusValue(value: unknown): value is RobotStatus["status"] {
  return value === "online" || value === "offline" || value === "busy" || value === "privacy";
}

function isErrorCode(value: unknown): value is ErrorCode {
  return (
    value === "validation_error" ||
    value === "robot_privacy" ||
    value === "robot_offline" ||
    value === "robot_busy" ||
    value === "not_found" ||
    value === "sequence_not_running" ||
    value === "internal_error"
  );
}

function redactToken(value: unknown, oat: string): unknown {
  if (typeof value === "string") {
    return value.split(oat).join("[redacted]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactToken(item, oat));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redactToken(key, oat), redactToken(item, oat)]),
    );
  }
  return value;
}
