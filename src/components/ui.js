import React from "react";
import {
  View,
  Text as RNText,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { colors, radius, shadow, spacing, font, type as typography } from "../theme";

/**
 * Text with a hard cap on the system font-size multiplier.
 *
 * Android lets the user pick a 2x-3x font scale; left unchecked it shreds every
 * card, pill and tab label. The app still honours the setting, just not beyond
 * 1.2x, and every screen uses this component instead of react-native's Text.
 */
export const FONT_CLAMP = 1.2;

export function Text({ maxFontSizeMultiplier = FONT_CLAMP, ...props }) {
  return <RNText maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} />;
}

/** Text that never scales with the system setting - for chrome like tab bars. */
export function FixedText(props) {
  return <RNText allowFontScaling={false} {...props} />;
}

export function Screen({ children, style }) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, right }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={typography.label}>{children}</Text>
      {right ? <Text style={typography.label}>{right}</Text> : null}
    </View>
  );
}

export function Pill({ label, tone = "default", style }) {
  const palette = {
    default: { bg: colors.surfaceAlt, fg: colors.textSoft },
    success: { bg: colors.successSoft, fg: colors.success },
    warn: { bg: colors.warnSoft, fg: colors.warn },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    info: { bg: colors.infoSoft, fg: colors.info },
    primary: { bg: colors.primarySoft, fg: colors.primary },
  }[tone] || { bg: colors.surfaceAlt, fg: colors.textSoft };

  return (
    <View style={[styles.pill, { backgroundColor: palette.bg }, style]}>
      <Text style={[styles.pillText, { color: palette.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  style,
  small = false,
}) {
  const palettes = {
    primary: { bg: colors.primary, fg: colors.onPrimary, border: colors.primary },
    secondary: { bg: colors.surfaceAlt, fg: colors.text, border: colors.border },
    danger: { bg: colors.dangerSoft, fg: colors.danger, border: colors.dangerBorder },
    ghost: { bg: "transparent", fg: colors.primary, border: "transparent" },
  };
  const palette = palettes[variant] || palettes.primary;
  const inactive = disabled || loading;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={inactive ? undefined : onPress}
      style={[
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: palette.bg, borderColor: palette.border },
        inactive && styles.buttonInactive,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} size="small" />
      ) : (
        <Text
          style={[styles.buttonText, small && styles.buttonTextSmall, { color: palette.fg }]}
          numberOfLines={1}
        >
          {title}
        </Text>
      )}
    </TouchableOpacity>
  );
}

export function Field({ label, hint, style, ...inputProps }) {
  return (
    <View style={{ marginTop: spacing(3) }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        style={[styles.input, style]}
        placeholderTextColor={colors.muted}
        {...inputProps}
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function Bar({ value = 0, tone = colors.primary }) {
  const pct = Math.max(0, Math.min(1, value || 0)) * 100;
  return (
    <View style={styles.barTrack}>
      <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: tone }]} />
    </View>
  );
}

export function Stepper({ label, value, onChange, step = 1, min = -Infinity, max = Infinity, format }) {
  const clamp = (next) => Math.max(min, Math.min(max, Number(next.toFixed(4))));
  return (
    <View style={styles.stepperRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepperLabel}>{label}</Text>
        <Text style={styles.stepperValue}>{format ? format(value) : String(value)}</Text>
      </View>
      <TouchableOpacity
        style={[styles.stepButton, value <= min && styles.stepButtonDisabled]}
        onPress={() => onChange(clamp(value - step))}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.stepButtonText}>-</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.stepButton, value >= max && styles.stepButtonDisabled]}
        onPress={() => onChange(clamp(value + step))}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.stepButtonText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

export function Banner({ tone = "info", title, text, actionLabel, onAction }) {
  const palette = {
    info: { bg: colors.infoSoft, fg: colors.info },
    success: { bg: colors.successSoft, fg: colors.success },
    warn: { bg: colors.warnSoft, fg: colors.warn },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
  }[tone] || { bg: colors.infoSoft, fg: colors.info };

  return (
    <View style={[styles.banner, { backgroundColor: palette.bg }]}>
      <View style={{ flex: 1 }}>
        {title ? <Text style={[styles.bannerTitle, { color: palette.fg }]}>{title}</Text> : null}
        {text ? <Text style={[styles.bannerText, { color: palette.fg }]}>{text}</Text> : null}
      </View>
      {actionLabel && onAction ? (
        <TouchableOpacity
          onPress={onAction}
          style={styles.bannerAction}
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
        >
          <Text style={[styles.bannerActionText, { color: palette.fg }]}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function EmptyState({ title, text }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {text ? <Text style={styles.emptyText}>{text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing(4),
    marginTop: spacing(3),
    ...shadow.card,
  },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing(5),
    marginBottom: spacing(1),
  },
  pill: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(1.2),
    maxWidth: "100%",
  },
  pillText: { fontSize: font(11.5), fontWeight: "700" },
  button: {
    borderRadius: radius.md,
    paddingVertical: spacing(3.5),
    paddingHorizontal: spacing(4),
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    minHeight: 46,
  },
  buttonSmall: { paddingVertical: spacing(2.2), minHeight: 38 },
  buttonInactive: { opacity: 0.45 },
  buttonText: { fontSize: font(15), fontWeight: "700" },
  buttonTextSmall: { fontSize: font(13.5) },
  fieldLabel: { ...typography.small, marginBottom: spacing(1.5), fontWeight: "600" },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing(3.5),
    paddingVertical: spacing(3),
    fontSize: font(15),
    color: colors.text,
  },
  fieldHint: { ...typography.small, marginTop: spacing(1.5) },
  barTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHigh,
    overflow: "hidden",
    marginTop: spacing(2),
  },
  barFill: { height: "100%", borderRadius: radius.pill },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing(2.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  stepperLabel: { fontSize: font(14), color: colors.textSoft },
  stepperValue: { fontSize: font(16), fontWeight: "700", color: colors.text, marginTop: 2 },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing(2),
  },
  stepButtonDisabled: { opacity: 0.4 },
  stepButtonText: { fontSize: font(22), fontWeight: "700", color: colors.primary, lineHeight: 26 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.md,
    padding: spacing(3),
    marginTop: spacing(3),
  },
  bannerTitle: { fontSize: font(13.5), fontWeight: "700" },
  bannerText: { fontSize: font(12.5), marginTop: 2, lineHeight: 17 },
  bannerAction: { paddingLeft: spacing(3), paddingRight: spacing(1), paddingVertical: spacing(2) },
  bannerActionText: { fontSize: font(13), fontWeight: "700" },
  empty: { alignItems: "center", paddingVertical: spacing(8), paddingHorizontal: spacing(4) },
  emptyTitle: { fontSize: font(16), fontWeight: "700", color: colors.textSoft },
  emptyText: { ...typography.small, marginTop: spacing(2), textAlign: "center" },
});

export default {
  Screen,
  Card,
  SectionTitle,
  Pill,
  Button,
  Field,
  Bar,
  Stepper,
  Banner,
  EmptyState,
};
