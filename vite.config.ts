import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Monaco's own module graph has to stay one copy. Vite pre-bundles dependencies, and a deep
  // import like `monaco-editor/platform/actions/common/actions` gets its *own* chunk next to the
  // bundled root — two live instances of `MenuRegistry` and `CommandsRegistry`, so anything
  // `src/lib/editorMenu.ts` registers lands in a registry the editor never reads. Excluding the
  // package leaves both the root and the deep paths as the real ESM files at one URL each.
  optimizeDeps: { exclude: ["monaco-editor"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1520,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1521,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
