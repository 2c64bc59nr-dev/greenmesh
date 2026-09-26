import { Dimensions, PixelRatio, Platform, StatusBar } from "react-native";

/**
 * Responsive theme.
 *
 * Everything is derived from the device's own metrics so the same build looks
 * right on a 360 dp phone, a wide/low-density phone (e.g. Samsung A03 at 280 dpi
 * override) and a tablet, and survives the user's system font-size setting.
 *
 * The design baseline is 360 x 800 dp (a typical phone). `spacing`, `radius` and
 * `type` are computed once at launch - the app is portrait-only, and a font-scale
 * change already restarts the activity on Android.
 */

// Real-black dark theme with a green accent.
/**
 * GreenMesh palette: an old phosphor terminal as the base, modern in the details.
 *
 * The green is P1 phosphor rather than a modern "UI green" - it carries the CRT
 * feel that gives the app its identity - and the neutrals are green-tinted
 * charcoal instead of pure grey, so surfaces read as a screen rather than a
 * document. Depth comes from soft glows and rounded cards, which is what keeps
 * it from looking like a novelty.
 */
export const colors = {
  bg: "#040705",
  surface: "#080D09",
  surfaceAlt: "#0E150F",
  surfaceHigh: "#141C16",
  grid: "#0F1A12",
  primary: "#5BF08A",
  primaryDark: "#2FBF68",
  primarySoft: "#0B2A18",
  primaryDisabled: "#1B3A26",
  onPrimary: "#02160A",
  text: "#D6F5E1",
  textSoft: "#9FD9B5",
  muted: "#6E9A7E",
  border: "#17301F",
  borderBright: "#254A31",
  glow: "#5BF08A",
  success: "#5BF08A",
  successSoft: "#0B2A18",
  warn: "#FFC857",
  warnSoft: "#2B2210",
  danger: "#FF7A7A",
  dangerSoft: "#2E1414",
  dangerBorder: "#4E2222",
  info: "#7FD4FF",
  infoSoft: "#0A2029",
  userBubble: "#5BF08A",
  userText: "#02160A",
  assistantBubble: "#0C120E",
  assistantText: "#D6F5E1",
  code: "#070C08",
};

const BASE_WIDTH = 360;
const BASE_HEIGHT = 800;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const window = Dimensions.get("window");
const screen = Dimensions.get("screen");

/** Device facts other modules can branch on. */
export const layout = {
  width: window.width,
  height: window.height,
  screenWidth: screen.width,
  screenHeight: screen.height,
  pixelRatio: PixelRatio.get(),
  /** The user's system font setting (1 = default). */
  fontScale: PixelRatio.getFontScale(),
  statusBarHeight: Platform.OS === "android" ? StatusBar.currentHeight || 24 : 44,
  /** Narrow phones: tighten paddings instead of shrinking text. */
  isSmall: window.width < 360,
  /** Short screens (16:9 and older): less vertical breathing room. */
  isShort: window.height < 740,
  isTablet: Math.min(window.width, window.height) >= 600,
  /** Never scale by more than ~1.3 or less than 0.9 - beyond that it looks wrong. */
  widthScale: clamp(window.width / BASE_WIDTH, 0.9, 1.3),
  heightScale: clamp(window.height / BASE_HEIGHT, 0.85, 1.3),
};

/** Horizontal scale for sizes that sit next to other content. */
export const scale = (size) => Math.round(size * layout.widthScale);

/** Vertical scale for heights and vertical rhythm. */
export const vScale = (size) => Math.round(size * layout.heightScale);

/**
 * Font size: follows the device width only. The user's own font-size setting is
 * applied by Android on top of this and clamped by the Text wrapper in
 * components/ui (maxFontSizeMultiplier) - multiplying it here too would double
 * the effect and blow up layouts on phones set to "largest text".
 */
export const font = (size) => Math.round(size * layout.widthScale * 10) / 10;

/** Spacing scale - the app's `spacing(4)` = 16 dp unit. */
export const spacing = (n) => {
  const base = n * 4 * layout.widthScale;
  return Math.round(base * (layout.isShort ? 0.92 : 1));
};

export const radius = {
  sm: scale(8),
  md: scale(12),
  lg: scale(18),
  pill: 999,
};

export const shadow = {
  card: {
    shadowColor: "#000000",
    shadowOpacity: 0.6,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  floating: {
    shadowColor: "#22C55E",
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
};

export const type = {
  h1: { fontSize: font(20), fontWeight: "800", color: colors.text, letterSpacing: -0.3 },
  h2: { fontSize: font(15), fontWeight: "700", color: colors.text },
  body: { fontSize: font(15), color: colors.text },
  small: { fontSize: font(12.5), color: colors.muted },
  label: {
    fontSize: font(11.5),
    fontWeight: "700",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  mono: { fontFamily: "monospace", fontSize: font(12.5), color: colors.textSoft },
};

/** Tab bar metrics, shared so the five tabs always fit. */
export const tabs = {
  fontSize: layout.isSmall ? font(11) : font(12.5),
  paddingVertical: layout.isShort ? spacing(2) : spacing(2.6),
  paddingBottom: spacing(2.2),
};

export default { colors, spacing, scale, vScale, font, radius, shadow, type, layout, tabs };
