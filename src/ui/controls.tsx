import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, space } from './theme';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'default',
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.primary,
        variant === 'danger' && styles.danger,
        variant === 'ghost' && styles.ghost,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}>
      <Text style={[styles.buttonText, variant === 'primary' && styles.primaryText]}>{label}</Text>
    </Pressable>
  );
}

export interface Option<T extends string | number> {
  id: T;
  label: string;
}

/** A row of mutually exclusive buttons; used instead of dropdowns, which differ per platform. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <View style={styles.segmentedRow}>
      {label ? <Text style={styles.segmentedLabel}>{label}</Text> : null}
      <View style={styles.segmented} accessibilityRole="radiogroup">
        {options.map((o) => {
          const selected = o.id === value;
          return (
            <Pressable
              key={String(o.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(o.id)}
              style={[styles.segment, selected && styles.segmentSelected]}>
              <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={[styles.segment, styles.toggle, value && styles.segmentSelected]}>
      <Text style={[styles.segmentText, value && styles.segmentTextSelected]}>
        {value ? '● ' : '○ '}
        {label}
      </Text>
    </Pressable>
  );
}

export function Pill({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.panelBorder,
  },
  primary: { backgroundColor: '#1f6f4a', borderColor: '#2a8a5d' },
  danger: { backgroundColor: '#5a1f24', borderColor: '#7a2b31' },
  ghost: { backgroundColor: 'transparent' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  buttonText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  primaryText: { color: '#eafff3' },
  segmentedRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  segmentedLabel: { color: colors.muted, fontSize: 12 },
  segmented: {
    flexDirection: 'row',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    overflow: 'hidden',
  },
  segment: { paddingHorizontal: 9, paddingVertical: 5, backgroundColor: colors.raised },
  segmentSelected: { backgroundColor: colors.raisedActive },
  segmentText: { color: colors.muted, fontSize: 12 },
  segmentTextSelected: { color: colors.text, fontWeight: '600' },
  toggle: { borderRadius: 6, borderWidth: 1, borderColor: colors.panelBorder },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    maxWidth: 420,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
});
