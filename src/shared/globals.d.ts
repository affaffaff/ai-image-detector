/**
 * Build-time constants injected by esbuild `define` (tools/build.mjs).
 *
 * __DEV_BUILD__ is true ONLY for `npm run build:dev`. Release builds
 * (`npm run build`, the one CI verifies and maintainers reproduce) hardcode
 * it to false, so anything gated on it is dead code eliminated from the
 * shipped bundle.
 */
declare const __DEV_BUILD__: boolean;
