import { describe, expect, test } from "bun:test";
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "./errors";

describe("AppError", () => {
  test("defaults to 500 INTERNAL_ERROR", () => {
    const e = new AppError("boom");
    expect(e.statusCode).toBe(500);
    expect(e.code).toBe("INTERNAL_ERROR");
    expect(e.name).toBe("AppError");
    expect(e instanceof Error).toBe(true);
  });

  test("toJSON returns the wire-shape envelope with success:false", () => {
    expect(new AppError("boom", 418, "TEAPOT").toJSON()).toEqual({
      success: false,
      error: { code: "TEAPOT", message: "boom" },
    });
  });

  test("ValidationError.toJSON includes details", () => {
    expect(new ValidationError("nope", { field: ["bad"] }).toJSON()).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "nope", details: { field: ["bad"] } },
    });
  });
});

describe("specialized errors", () => {
  test("NotFoundError", () => {
    const e = new NotFoundError("user", "42");
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toBe("user 42 not found");
  });

  test("NotFoundError without an id", () => {
    const e = new NotFoundError("user");
    expect(e.message).toBe("user not found");
  });

  test("ValidationError attaches details", () => {
    const e = new ValidationError("invalid", { field: ["required"] });
    expect(e.statusCode).toBe(422);
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.details).toEqual({ field: ["required"] });
  });

  test("UnauthorizedError default + custom message", () => {
    expect(new UnauthorizedError()).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED", message: "Unauthorized" });
    expect(new UnauthorizedError("session expired").message).toBe("session expired");
  });

  test("ForbiddenError default + custom message", () => {
    expect(new ForbiddenError()).toMatchObject({ statusCode: 403, code: "FORBIDDEN", message: "Forbidden" });
    expect(new ForbiddenError("admin only").message).toBe("admin only");
  });
});
