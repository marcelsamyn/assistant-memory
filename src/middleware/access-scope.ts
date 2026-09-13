import { defineEventHandler } from "h3";
import { getRequestAccessScope } from "~/lib/request-access";

/** Validate the optional SDK access header at the HTTP boundary. */
export default defineEventHandler((event) => {
  getRequestAccessScope(event);
});
