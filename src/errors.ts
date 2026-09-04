import {
  DaykeeperApiError,
  DaykeeperTransportError,
} from "@skyporch/daykeeper";

export class McpAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DaykeeperMcpError";
  }
}

export interface SafeError {
  kind: "adapter" | "api" | "transport";
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  fields: string[];
  nextActions: string[];
  correlationId?: string;
  mutationOutcome?: "unknown";
}

export function safeError(error: unknown, secret: string): SafeError {
  if (error instanceof McpAdapterError) {
    return {
      kind: "adapter",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      fields: [],
      nextActions: [],
    };
  }
  if (error instanceof DaykeeperApiError) {
    const hidden = [401, 403, 404].includes(error.status);
    const correlationId = safeValue(
      error.correlationId,
      /^[A-Za-z0-9._:-]{1,128}$/,
      secret,
    );
    return {
      kind: "api",
      code:
        safeValue(error.code, /^[A-Z][A-Z0-9_]{0,79}$/, secret) ?? "API_ERROR",
      message: hidden
        ? "The request is not authorized or the resource is unavailable."
        : "The Daykeeper API rejected the request. Inspect the error code and next actions.",
      retryable: hidden ? false : error.retryable === true,
      status: error.status,
      fields: hidden
        ? []
        : safeList(error.fields, /^[A-Za-z0-9_.[\]-]{1,120}$/, secret),
      nextActions: hidden
        ? []
        : safeList(error.nextActions, /^[a-z][a-z0-9_]{0,79}$/, secret),
      ...(correlationId ? { correlationId } : {}),
    };
  }
  if (error instanceof DaykeeperTransportError) {
    return {
      kind: "transport",
      code:
        safeValue(error.code, /^[A-Z][A-Z0-9_]{0,79}$/, secret) ??
        "TRANSPORT_ERROR",
      message: "The Daykeeper request could not be completed.",
      retryable: error.retryable === true,
      fields: [],
      nextActions: [],
    };
  }
  return {
    kind: "adapter",
    code: "INTERNAL_ERROR",
    message:
      "The tool could not be completed. No diagnostic details were logged.",
    retryable: false,
    fields: [],
    nextActions: [],
  };
}

function safeValue(
  value: unknown,
  pattern: RegExp,
  secret: string,
): string | undefined {
  return typeof value === "string" &&
    pattern.test(value) &&
    !value.includes(secret)
    ? value
    : undefined;
}

function safeList(values: unknown, pattern: RegExp, secret: string): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.slice(0, 32).flatMap((value) => {
        const safe = safeValue(value, pattern, secret);
        return safe === undefined ? [] : [safe];
      }),
    ),
  ];
}
