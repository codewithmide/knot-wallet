import { describe, it, expect } from "vitest";
import {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  PolicyError,
  InsufficientFundsError,
  TransactionError,
  TradeError,
  LiquidityError,
  DatabaseUnavailableError,
  errorToResponse,
} from "../../src/utils/errors.js";

// =============================================================================
// AppError base class
// =============================================================================

describe("AppError", () => {
  it("creates error with default status 500", () => {
    const err = new AppError("something broke");
    expect(err.message).toBe("something broke");
    expect(err.statusCode).toBe(500);
    expect(err.code).toBeUndefined();
    expect(err.name).toBe("AppError");
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts custom status code and code", () => {
    const err = new AppError("nope", 418, "TEAPOT");
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe("TEAPOT");
  });
});

// =============================================================================
// Specialized error subclasses
// =============================================================================

describe("ValidationError", () => {
  it("is 400 with VALIDATION_ERROR code", () => {
    const err = new ValidationError("bad input");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.name).toBe("ValidationError");
    expect(err).toBeInstanceOf(AppError);
  });
});

describe("AuthenticationError", () => {
  it("defaults to 401 with custom message", () => {
    const err = new AuthenticationError("token expired");
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("AUTHENTICATION_ERROR");
    expect(err.message).toBe("token expired");
  });

  it("uses default message if none provided", () => {
    const err = new AuthenticationError();
    expect(err.message).toBe("Authentication required");
  });
});

describe("AuthorizationError", () => {
  it("is 403", () => {
    const err = new AuthorizationError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("AUTHORIZATION_ERROR");
  });
});

describe("NotFoundError", () => {
  it("is 404", () => {
    const err = new NotFoundError("wallet not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("wallet not found");
  });
});

describe("PolicyError", () => {
  it("is 403 with POLICY_VIOLATION code", () => {
    const err = new PolicyError("exceeds daily limit");
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("POLICY_VIOLATION");
    expect(err.name).toBe("PolicyError");
  });
});

describe("InsufficientFundsError", () => {
  it("is 400 with INSUFFICIENT_FUNDS code", () => {
    const err = new InsufficientFundsError("need more SOL");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("INSUFFICIENT_FUNDS");
  });
});

describe("TransactionError", () => {
  it("includes optional signature", () => {
    const err = new TransactionError("broadcast failed", "abc123");
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("TRANSACTION_ERROR");
    expect(err.signature).toBe("abc123");
  });
});

describe("TradeError", () => {
  it("accepts custom status code", () => {
    const err = new TradeError("slippage exceeded", 422);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("TRADE_ERROR");
  });

  it("defaults to 400", () => {
    const err = new TradeError("no route");
    expect(err.statusCode).toBe(400);
  });
});

describe("LiquidityError", () => {
  it("defaults to 400", () => {
    const err = new LiquidityError("pool not found");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("LIQUIDITY_ERROR");
  });
});

describe("DatabaseUnavailableError", () => {
  it("is 503", () => {
    const err = new DatabaseUnavailableError();
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("DATABASE_UNAVAILABLE");
  });
});

// =============================================================================
// errorToResponse
// =============================================================================

describe("errorToResponse", () => {
  it("maps AppError to structured response", () => {
    const err = new PolicyError("over limit");
    const res = errorToResponse(err);
    expect(res).toEqual({
      message: "over limit",
      code: "POLICY_VIOLATION",
      statusCode: 403,
    });
  });

  it("maps plain Error to 500", () => {
    const err = new Error("oops");
    const res = errorToResponse(err);
    expect(res).toEqual({
      message: "oops",
      statusCode: 500,
    });
  });

  it("maps unknown value to generic 500", () => {
    const res = errorToResponse("string error");
    expect(res).toEqual({
      message: "An unexpected error occurred",
      statusCode: 500,
    });
  });

  it("maps null to generic 500", () => {
    const res = errorToResponse(null);
    expect(res.statusCode).toBe(500);
  });
});
