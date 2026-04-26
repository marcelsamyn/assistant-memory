import { defineConfig } from "nitro-test-utils/config";
import { fileURLToPath } from "node:url";
import { configDefaults } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
  nitro: {
    global: {
      mode: "production",
    },
  },
});
