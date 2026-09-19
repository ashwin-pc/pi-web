import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["examples/pi-web-extensions/dictation/index.test.ts"],
    fileParallelism: false,
  },
});
