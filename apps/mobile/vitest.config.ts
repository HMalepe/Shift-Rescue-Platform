import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    /*
     * Only `src/lib/attendance.ts` is tested here, and it imports nothing from
     * react-native on purpose — that is what makes the §16 signal rules
     * testable without a device or a native runtime.
     */
    include: ["test/**/*.test.ts"],
  },
});
