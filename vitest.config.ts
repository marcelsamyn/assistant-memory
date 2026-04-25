import { defineConfig } from "nitro-test-utils/config";
import { configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
  nitro: {
    global: {
      mode: "production",
    },
  },
});
