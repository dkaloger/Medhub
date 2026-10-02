import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SAMPLE_RATE_HZ } from '../core/device';
import { RingBuffer } from '../core/series';
import type { LiveSession, SessionSnapshot } from '../session/liveSession';
import { Button, Pill } from './controls';
import { MetricTiles } from './panels';
import { SignalPanels, type DisplaySettings } from './SignalPanels';
import { colors, mono, space } from './theme';

const fs = SAMPLE_RATE_HZ;
const EMPTY = new RingBuffer(1);

function connectionPill(s: SessionSnapshot): { text: string; color: string } {
  if (s.simulated && s.connection === 'connected') return { text: 'SIMULATED — no hardware', color: colors.simulated };
  switch (s.connection) {
    case 'connected':
      return { text: s.detail, color: colors.ok };
    case 'connecting':
      return { text: s.detail, color: colors.warn };
    case 'disconnected':
      return { text: s.detail, color: colors.danger };
    default:
      return { text: 'Not connected', color: colors.faint };
  }
}

export function LiveScreen({
  session,
  snapshot,
  settings,
  onSettings,
  onConnect,
  onRecordings,
}: {
  session: LiveSession;
  snapshot: SessionSnapshot;
  settings: DisplaySettings;
  onSettings: (s: DisplaySettings) => void;
  onConnect: () => void;
  onRecordings: () => void;
}) {
  const acq = session.acquisition;
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const active = snapshot.connection !== 'idle';

  useEffect(() => setPausedAt(null), [acq]);

  const pill = connectionPill(snapshot);
  const togglePause = () => setPausedAt((p) => (p === null && acq ? acq.end : null));
  const pan = (dt: number) =>
    setPausedAt((p) => {
      if (p === null || !acq) return p;
      const earliest = acq.ecg.raw.start + settings.ecgWindow * fs;
      return Math.max(earliest, Math.min(acq.end, Math.round(p + dt * fs)));
    });

  const clip = snapshot.clip;
  const status = [
    `${snapshot.samplesReceived.toLocaleString()} samples`,
    snapshot.measuredRate !== null ? `${snapshot.measuredRate.toFixed(1)} samples/s (250 expected)` : 'no samples arriving',
    snapshot.gaps ? `${snapshot.gaps} dropout${snapshot.gaps === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.stack}>
      <View style={styles.toolbar}>
        <Pill text={pill.text} color={pill.color} />
        <View style={styles.actions}>
          {active ? (
            <Button label="Disconnect" variant="danger" onPress={() => void session.disconnect()} />
          ) : (
            <Button label="Connect…" variant="primary" onPress={onConnect} />
          )}
          <Button label={pausedAt === null ? 'Pause' : 'Go live'} onPress={togglePause} disabled={!acq} />
          <Button
            label={clip ? `■ Stop clip ${clip.seconds.toFixed(0)} / ${clip.maxSeconds} s` : '● Record clip'}
            variant={clip ? 'danger' : 'default'}
            onPress={() => (clip ? void session.stopClip() : session.startClip())}
            disabled={!active || !snapshot.storageLocation}
          />
          <Button label="Recordings" onPress={onRecordings} />
        </View>
      </View>

      <MetricTiles
        heart={snapshot.heart}
        breathing={snapshot.breathing}
        ecgStatus={snapshot.ecgStatus}
        respStatus={snapshot.respStatus}
        respPresent={snapshot.respPresent}
        context="live"
      />

      <SignalPanels
        settings={settings}
        onChange={onSettings}
        ecg={acq?.ecg.display ?? EMPTY}
        resp={acq?.resp.display ?? EMPTY}
        live={pausedAt === null}
        endIndex={pausedAt ?? 0}
        onPan={pausedAt !== null ? pan : undefined}
        respEmptyText={snapshot.respPresent || !acq ? 'Waiting for respiration samples' : 'No respiration channel in this firmware'}
      />

      <View style={styles.footer}>
        {acq ? <Text style={styles.status}>{status}</Text> : null}
        {snapshot.logging ? (
          <Text style={styles.status} numberOfLines={1} selectable>
            Logging every sample: {snapshot.logging.location} ({(snapshot.logging.seconds / 60).toFixed(1)} min)
          </Text>
        ) : active ? (
          <Text style={[styles.status, styles.warn]}>Not logging: recordings folder unavailable</Text>
        ) : null}
        {snapshot.loggingError ? <Text style={[styles.status, styles.error]}>Logging stopped: {snapshot.loggingError}</Text> : null}
        {snapshot.lastClip ? (
          <Text style={[styles.status, snapshot.lastClip.error ? styles.error : null]} numberOfLines={1} selectable>
            {snapshot.lastClip.error ? `Clip not saved: ${snapshot.lastClip.error}` : `Clip saved: ${snapshot.lastClip.path}`}
          </Text>
        ) : null}
        {snapshot.lastMessage ? (
          <Text style={[styles.status, snapshot.lastMessage.isError ? styles.error : null]}>
            Device said at {new Date(snapshot.lastMessage.at).toLocaleTimeString()}: {snapshot.lastMessage.text}
          </Text>
        ) : null}
        {pausedAt !== null ? <Text style={styles.status}>Paused — drag a trace to look back up to 10 minutes.</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  footer: { gap: 3 },
  status: { color: colors.muted, fontSize: 12, fontFamily: mono },
  warn: { color: colors.warn },
  error: { color: colors.danger },
});
