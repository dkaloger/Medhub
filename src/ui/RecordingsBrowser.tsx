import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { parseRecording, type Recording } from '../core/recordingFile';
import NativeMedhub, { type RecordingFileInfo } from '../native/NativeMedhub';
import { Button } from './controls';
import { Overlay } from './panels';
import { colors, mono, space } from './theme';

function size(bytes: number): string {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

export function RecordingsBrowser({
  location,
  onOpen,
  onClose,
}: {
  location: string | null;
  onOpen: (recording: Recording) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<RecordingFileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    NativeMedhub?.listRecordings()
      .then((list) => setFiles(list.filter((f) => f.path.endsWith('.csv') && !f.path.endsWith('events.csv')).sort((a, b) => b.modified - a.modified)))
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  const open = async (file: RecordingFileInfo) => {
    if (!NativeMedhub) return;
    setLoading(file.path);
    setError(null);
    try {
      const text = await NativeMedhub.readRecording(file.path);
      const name = file.path.split('/').slice(-2).join('/');
      onOpen(parseRecording(text, name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  };

  return (
    <Overlay title="Recordings" onClose={onClose}>
      <Text style={styles.location} selectable>
        {location ?? 'Recordings folder unavailable'}
      </Text>
      <ScrollView style={styles.list}>
        {files === null && !error ? <ActivityIndicator color={colors.muted} /> : null}
        {files?.length === 0 ? <Text style={styles.empty}>No recordings yet. Connect a board to start logging.</Text> : null}
        {files?.map((f) => (
          <Pressable
            key={f.path}
            onPress={() => void open(f)}
            disabled={loading !== null}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>
                {f.path}
              </Text>
              <Text style={styles.meta}>
                {new Date(f.modified).toLocaleString()} · {size(f.size)}
              </Text>
            </View>
            {loading === f.path ? <ActivityIndicator color={colors.muted} /> : <Text style={styles.open}>Open</Text>}
          </Pressable>
        ))}
      </ScrollView>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {Platform.OS !== 'android' ? (
        <Button label="Show folder" onPress={() => void NativeMedhub?.revealRecordings()} style={styles.reveal} />
      ) : null}
    </Overlay>
  );
}

const styles = StyleSheet.create({
  location: { color: colors.faint, fontSize: 12, fontFamily: mono },
  list: { marginVertical: space.md, maxHeight: 420 },
  empty: { color: colors.faint, textAlign: 'center', padding: space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: 8,
    backgroundColor: colors.raised,
    marginBottom: space.sm,
  },
  pressed: { opacity: 0.7 },
  rowText: { flex: 1 },
  name: { color: colors.text, fontSize: 13, fontFamily: mono },
  meta: { color: colors.faint, fontSize: 12, marginTop: 2 },
  open: { color: colors.resp, fontSize: 13, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 12, marginBottom: space.sm },
  reveal: { alignSelf: 'flex-start' },
});
