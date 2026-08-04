/**
 * One theme object, no styling library.
 *
 * React Native has no cascade, so a utility framework buys much less here than
 * it does on the web — every component already writes explicit styles. Sharing
 * the tokens is the part with real value.
 *
 * The palette is deliberately the same as `apps/web`'s: a locum who checks a
 * shift on their phone and a manager who confirms it on a laptop are using one
 * product, and two palettes make it feel like two.
 */
export const theme = {
  bg: "#f7f7f5",
  surface: "#ffffff",
  border: "#e2e2dd",
  text: "#1b1b19",
  textDim: "#6b6b64",
  accent: "#1c6b52",
  accentText: "#ffffff",
  danger: "#a3341f",
  warn: "#8a6116",
  radius: 10,
  gap: 12,
} as const;
