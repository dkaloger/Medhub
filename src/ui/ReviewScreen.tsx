import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SAMPLE_RATE_HZ } from '../core/device';
import { ecgDisplayChain, respDisplayChain } from '../core/filters';
import { breathingRate, electrodeContact, heartRate, signalStatus } from '../core/metrics';
import type { Recording } from '../core/recordingFile';
import { ArraySeries } from '../core/series';
import { Button, Pill } from './controls';
import { contactMessage } from './contact';
import { MetricTiles } from './panels';
import { SignalPanels, type DisplaySettings } from './SignalPanels';
import { colors, mono, space } from './theme';
import { formatDuration } from './traceGeometry';

const fs = SAMPLE_RATE_HZ;

export function ReviewScreen({
  recording,
  settings,
  onSettings,
  onClose,
}: {
  recording: Recording;
  settings: DisplaySettings;
  onSettings: (s: DisplaySettings) => void;
  onClose: () => void;
}) {
  const first = recording.startIndex;
  const last = first + recording.ecg.length;
  const [end, setEnd] = useState(() => Math.min(last, first + settings.ecgWindow * fs));

  const ecg = useMemo(
    () => new ArraySeries(ecgDisplayChain(settings.ecgFilter, settings.notch).process(recording.ecg), first),
    [recording, settings.ecgFilter, settings.notch, first],
  );
  const resp = useMemo(
    () => new ArraySeries(respDisplayChain(settings.respFilter).process(recording.resp), first),
    [recording, settings.respFilter, first],
  );

  // Metrics describe the moment at the right edge of the view, like the live screen.
  const metricsAt = Math.round((end - first) / fs);
  const metrics = useMemo(() => {
    const upTo = Math.min(recording.ecg.length, metricsAt * fs);
    const ecgUpTo = recording.ecg.subarray(0, upTo);
    const respUpTo = recording.resp.subarray(0, upTo);
    return {
      heart: heartRate(ecgUpTo),
      breathing: recording.hasResp ? breathingRate(respUpTo) : { value: null, reason: 'no respiration data' },
      contact: electrodeContact(ecgUpTo, respUpTo),
      respStatus: signalStatus(respUpTo),
    };
  }, [recording, metricsAt]);

  const clamp = (index: number) => Math.max(first + fs, Math.min(last, Math.round(index)));
  const step = settings.ecgWindow * fs;
  const duration = recording.ecg.length / fs;

  return (
    <View style={styles.stack}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {recording.name}
          </Text>
          <Text style={styles.meta}>
            {formatDuration(duration)} long · {recording.gapCount} gap{recording.gapCount === 1 ? '' : 's'} · viewing up to{' '}
            {formatDuration((end - first) / fs)}
          </Text>
        </View>
        {recording.simulated ? <Pill text="SIMULATED DATA" color={colors.simulated} /> : null}
        <View style={styles.nav}>
          <Button label="⏮" onPress={() => setEnd(clamp(first + step))} />
          <Button label="◀" onPress={() => setEnd(clamp(end - step))} />
          <Button label="▶" onPress={() => setEnd(clamp(end + step))} />
          <Button label="⏭" onPress={() => setEnd(last)} />
          <Button label="Back to live" variant="primary" onPress={onClose} />
        </View>
      </View>
      <MetricTiles {...metrics} respPresent={recording.hasResp} context="review" />
      <SignalPanels
        settings={settings}
        onChange={onSettings}
        ecg={ecg}
        resp={resp}
        live={false}
        endIndex={end}
        onPan={(dt) => setEnd((e) => clamp(e + dt * fs))}
        ecgAlert={(() => {
          const contact = contactMessage(metrics.contact, metrics.heart);
          return contact.alert ? { text: contact.title, color: contact.color } : null;
        })()}
        respEmptyText={recording.hasResp ? 'No respiration samples here' : 'This recording has no respiration channel'}
      />
      <Text style={styles.hint}>Drag a trace to scroll through the recording.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md },
  titleBlock: { flexGrow: 1, flexShrink: 1, minWidth: 220 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', fontFamily: mono },
  meta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  nav: { flexDirection: 'row', gap: space.xs },
  hint: { color: colors.faint, fontSize: 12, textAlign: 'center' },
});
