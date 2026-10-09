import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import type { Recording } from './src/core/recordingFile';
import { DeviceSource } from './src/native/deviceSource';
import NativeMedhub from './src/native/NativeMedhub';
import { NativeStore } from './src/native/nativeStore';
import { DemoSource } from './src/session/demoSource';
import { LiveSession } from './src/session/liveSession';
import { DevicePicker } from './src/ui/DevicePicker';
import { LiveScreen } from './src/ui/LiveScreen';
import { RecordingsBrowser } from './src/ui/RecordingsBrowser';
import { ReviewScreen } from './src/ui/ReviewScreen';
import { DEFAULT_SETTINGS, type DisplaySettings } from './src/ui/SignalPanels';
import { colors, space } from './src/ui/theme';

type Overlay = 'devices' | 'recordings' | null;

export default function App() {
  const [session] = useState(() => new LiveSession(null));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [settings, setSettings] = useState<DisplaySettings>(DEFAULT_SETTINGS);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [review, setReview] = useState<Recording | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    if (!NativeMedhub) {
      setStorageError('Native module unavailable: device access and recording are disabled.');
      return;
    }
    NativeStore.open()
      .then((store) => session.setStore(store))
      .catch((e) => setStorageError(`Recordings folder unavailable: ${e?.message ?? e}`));
    // No disconnect on cleanup: Fast Refresh re-runs effects and would drop a live
    // device mid-session. The native module closes the port when the app exits.
  }, [session]);

  // Display filters live in the session so every buffered sample is re-filtered on change.
  useEffect(() => session.setEcgFilter(settings.ecgFilter, settings.notch), [session, settings.ecgFilter, settings.notch]);
  useEffect(() => session.setRespFilter(settings.respFilter), [session, settings.respFilter]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.brandRow}>
          <Text style={styles.brand}>Medhub</Text>
          <Text style={styles.subtitle}>ADS1292R bench viewer</Text>
        </View>
        {storageError ? <Text style={styles.error}>{storageError}</Text> : null}
        {review ? (
          <ReviewScreen recording={review} settings={settings} onSettings={setSettings} onClose={() => setReview(null)} />
        ) : (
          <LiveScreen
            session={session}
            snapshot={snapshot}
            settings={settings}
            onSettings={setSettings}
            onConnect={() => setOverlay('devices')}
            onRecordings={() => setOverlay('recordings')}
          />
        )}
        <Text style={styles.disclaimer}>
          Experimental bench tool, not a medical device. Estimates are not diagnostic. Do not connect electrodes to a person
          while the board is powered from, or wired to, mains-connected equipment.
        </Text>
      </ScrollView>

      {overlay === 'devices' ? (
        <DevicePicker
          onClose={() => setOverlay(null)}
          onDemo={() => {
            setOverlay(null);
            void session.connect(new DemoSource());
          }}
          onPick={(device) => {
            setOverlay(null);
            void session.connect(new DeviceSource(device));
          }}
        />
      ) : null}
      {overlay === 'recordings' ? (
        <RecordingsBrowser
          location={snapshot.storageLocation}
          onClose={() => setOverlay(null)}
          onOpen={(recording) => {
            setOverlay(null);
            setReview(recording);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md },
  brandRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  brand: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: 0.3 },
  subtitle: { color: colors.muted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  disclaimer: { color: colors.faint, fontSize: 11, textAlign: 'center', marginTop: space.sm },
});
