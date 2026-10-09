import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ContactStatus, RateEstimate, SignalStatus } from '../core/metrics';
import { contactMessage } from './contact';
import { colors, mono, space } from './theme';

export function Panel({
  title,
  accent,
  badge,
  right,
  children,
}: {
  title: string;
  accent: string;
  badge?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <View style={styles.titleRow}>
          <View style={[styles.accent, { backgroundColor: accent }]} />
          <Text style={styles.title}>{title}</Text>
          {badge}
        </View>
        <View style={styles.controls}>{right}</View>
      </View>
      {children}
    </View>
  );
}

const STATUS_TEXT: Record<SignalStatus, { text: string; color: string }> = {
  'no-data': { text: 'No data', color: colors.faint },
  collecting: { text: 'Collecting…', color: colors.muted },
  clipped: { text: 'ADC clipped', color: colors.danger },
  flat: { text: 'Flat — check leads', color: colors.warn },
  ok: { text: 'In range', color: colors.ok },
};

function Tile({
  label,
  value,
  unit,
  note,
  color,
  small = false,
}: {
  label: string;
  value: string;
  unit?: string;
  note: string;
  color: string;
  small?: boolean;
}) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <View style={styles.tileValueRow}>
        <Text style={[styles.tileValue, small && styles.tileStatus, { color }]} numberOfLines={2}>
          {value}
        </Text>
        {unit ? <Text style={styles.tileUnit}>{unit}</Text> : null}
      </View>
      <Text style={styles.tileNote} numberOfLines={2}>
        {note}
      </Text>
    </View>
  );
}

export function MetricTiles({
  heart,
  breathing,
  contact,
  respStatus,
  respPresent,
  context,
}: {
  heart: RateEstimate;
  breathing: RateEstimate;
  contact: ContactStatus;
  respStatus: SignalStatus;
  respPresent: boolean;
  context: 'live' | 'review';
}) {
  const span = (s: number) => (context === 'live' ? `last ${s} s` : `${s} s before view end`);
  const electrodes = contactMessage(contact, heart);
  const resp = !respPresent
    ? contact === 'no-data'
      ? STATUS_TEXT['no-data']
      : { text: 'Not sent by firmware', color: colors.faint }
    : respStatus === 'clipped' && contact === 'off'
      ? { text: 'Saturated', color: colors.danger }
      : STATUS_TEXT[respStatus];
  return (
    <View style={styles.tiles}>
      <Tile
        label="Heart rate"
        value={heart.value !== null ? String(heart.value) : '—'}
        unit="bpm"
        note={heart.value !== null ? `Experimental · ${span(15)}` : heart.reason}
        color={heart.value !== null ? colors.ecg : colors.faint}
      />
      <Tile
        label="Breathing"
        value={breathing.value !== null ? String(breathing.value) : '—'}
        unit="/min"
        note={breathing.value !== null ? `Experimental · ${span(60)}` : breathing.reason}
        color={breathing.value !== null ? colors.resp : colors.faint}
      />
      <Tile label="Electrodes" value={electrodes.title} note={electrodes.note} color={electrodes.color} small />
      <Tile label="Respiration signal" value={resp.text} note="ADS1292R CH1, uncalibrated" color={resp.color} small />
    </View>
  );
}

/** Full-window overlay used instead of Modal, which behaves differently on each desktop platform. */
export function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <View style={styles.overlay}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.panel,
    borderColor: colors.panelBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingTop: space.sm,
    paddingHorizontal: space.sm,
  },
  panelHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingHorizontal: space.xs,
    paddingBottom: space.xs,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  accent: { width: 4, height: 16, borderRadius: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    flexGrow: 1,
    flexBasis: 200,
    backgroundColor: colors.panel,
    borderColor: colors.panelBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: space.md,
    minHeight: 96,
  },
  tileLabel: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  tileValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 4 },
  tileValue: { fontSize: 30, fontWeight: '700', fontFamily: mono, flexShrink: 1 },
  tileStatus: { fontSize: 16, fontFamily: undefined, marginTop: 6 },
  tileUnit: { color: colors.muted, fontSize: 14 },
  tileNote: { color: colors.faint, fontSize: 11, marginTop: 4 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 640,
    maxHeight: '90%',
    backgroundColor: colors.panel,
    borderColor: colors.panelBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: space.lg,
  },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.md },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  close: { color: colors.muted, fontSize: 18, paddingHorizontal: space.sm },
});
