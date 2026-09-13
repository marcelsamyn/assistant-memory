import { defineNitroPlugin } from "nitropack/runtime";

/** Start the worker when a Nitro replica starts, before it receives traffic. */
export default defineNitroPlugin(async (nitroApp) => {
  // Route tests intentionally avoid importing queues because a live worker
  // would compete with their isolated fixture queues.
  if (
    process.env["NODE_ENV"] === "test" ||
    process.env["VITEST"] !== undefined
  ) {
    return;
  }
  const { closeQueues } = await import("~/lib/queues");
  nitroApp.hooks.hook("close", closeQueues);
});
