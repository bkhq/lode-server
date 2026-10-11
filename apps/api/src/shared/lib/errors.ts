export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = "INTERNAL_ERROR",
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON(): { success: false; error: { code: string; message: string; details?: unknown } } {
    return {
      success: false,
      error: { code: this.code, message: this.message },
    };
  }
}

export class NotFoundError extends AppError {
  // `id` is included in the message for debuggability. All ids passed here are
  // opaque nanoids / ULIDs (no PII), so surfacing them is safe.
  constructor(resource: string, id?: string) {
    super(id ? `${resource} ${id} not found` : `${resource} not found`, 404, "NOT_FOUND");
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly details: unknown,
  ) {
    super(message, 422, "VALIDATION_ERROR");
  }

  toJSON(): { success: false; error: { code: string; message: string; details?: unknown } } {
    return {
      success: false,
      error: { code: this.code, message: this.message, details: this.details },
    };
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

/**
 * True when `err` is (or wraps) a SQLite UNIQUE violation. Drizzle wraps the
 * driver error in `DrizzleQueryError`, so the libsql `code` / message sit on
 * `.cause`; walk the chain rather than trusting the outermost error.
 */
export function isUniqueViolation(err: unknown): boolean {
  return matchesInCauseChain(err, code => code === "SQLITE_CONSTRAINT_UNIQUE", /UNIQUE constraint failed/i);
}

/** Any SQLite constraint (UNIQUE / CHECK / FOREIGN KEY / NOT NULL), walking `.cause`. */
export function isConstraintViolation(err: unknown): boolean {
  return matchesInCauseChain(
    err,
    code => code.startsWith("SQLITE_CONSTRAINT"),
    /\b(?:UNIQUE|CHECK|FOREIGN KEY|NOT NULL) constraint failed\b/i,
  );
}

/**
 * The first `AppError` in `err`'s cause chain, if any. drizzle wraps anything
 * thrown beneath a query — including an `AppError` a database adapter raises,
 * such as the write lock's DB_BUSY — in `DrizzleQueryError`, so a status meant
 * for the client can sit a level or two down.
 */
export function findAppError(err: unknown): AppError | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    if (cur instanceof AppError)
      return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Drizzle wraps the driver error in `DrizzleQueryError`, so the libsql
 * `code` / message sit on `.cause`; walk the chain rather than trusting
 * the outermost error.
 */
function matchesInCauseChain(err: unknown, codeOk: (code: string) => boolean, re: RegExp): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const { code, message, cause } = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === "string" && codeOk(code))
      return true;
    if (typeof message === "string" && re.test(message))
      return true;
    cur = cause;
  }
  return false;
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403, "FORBIDDEN");
  }
}
