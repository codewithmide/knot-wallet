export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, 401, "AUTHENTICATION_ERROR");
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = "Not authorized") {
    super(message, 403, "AUTHORIZATION_ERROR");
    this.name = "AuthorizationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(message, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class PolicyError extends AppError {
  constructor(message: string) {
    super(message, 403, "POLICY_VIOLATION");
    this.name = "PolicyError";
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message: string) {
    super(message, 400, "INSUFFICIENT_FUNDS");
    this.name = "InsufficientFundsError";
  }
}

export class TransactionError extends AppError {
  constructor(message: string, public signature?: string) {
    super(message, 500, "TRANSACTION_ERROR");
    this.name = "TransactionError";
  }
}

export class TradeError extends AppError {
  constructor(message: string, statusCode: number = 400) {
    super(message, statusCode, "TRADE_ERROR");
    this.name = "TradeError";
  }
}

export class DatabaseUnavailableError extends AppError {
  constructor(message: string = "Database temporarily unavailable") {
    super(message, 503, "DATABASE_UNAVAILABLE");
    this.name = "DatabaseUnavailableError";
  }
}

export const errorToResponse = (error: unknown): { message: string; code?: string; statusCode: number } => {
  if (error instanceof AppError) {
    return {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      statusCode: 500,
    };
  }

  return {
    message: "An unexpected error occurred",
    statusCode: 500,
  };
};
