import { Context } from "hono";

export interface ApiResponse<T = unknown> {
  status: boolean;
  statusCode: number;
  message: string;
  data: T | null;
}

/**
 * Success response helper
 */
export function success<T>(
  c: Context,
  message: string,
  data: T,
  statusCode: number = 200
) {
  return c.json(
    {
      status: true,
      statusCode,
      message,
      data,
    } satisfies ApiResponse<T>,
    statusCode as 200
  );
}

/**
 * Error response helper
 */
export function error(
  c: Context,
  message: string,
  statusCode: number = 500,
  data: unknown = null
) {
  return c.json(
    {
      status: false,
      statusCode,
      message,
      data,
    } satisfies ApiResponse,
    statusCode as 500
  );
}
