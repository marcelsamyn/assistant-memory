import { formatISO } from "date-fns";

/**
 * Converts a value to a valid Date, returning the current time if invalid.
 */
function toValidDate(value: Date | string | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) {
    return new Date();
  }
  return date;
}

/**
 * Safely formats a date value as ISO 8601.
 * Falls back to the current time if the input is an invalid date,
 * preventing RangeError: Invalid time value crashes.
 */
export function safeFormatISO(value: Date | string | number): string {
  return formatISO(toValidDate(value));
}

/**
 * Safely converts a date value to an ISO string.
 * Falls back to the current time if the input is an invalid date.
 */
export function safeToISOString(value: Date | string | number): string {
  return toValidDate(value).toISOString();
}
