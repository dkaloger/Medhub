import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import NativeMedhub, { type DeviceInfo } from '../native/NativeMedhub';
import { ensureBluetoothPermission } from '../native/permissions';
import { Button } from './controls';
import { Overlay } from './panels';
import { colors, mono, space } from './theme';

const SCAN_SECONDS = 4;

export function DevicePicker({
  onPick,
  onDemo,
  onClose,
}: {
  onPick: (device: DeviceInfo) => void;
  onDemo: () => void;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const scan = useCallback(async () => {
    if (!NativeMedhub) {
      setNote('Device access is not available in this build. You can still use the simulated signal.');
      return;
    }
    setScanning(true);
    setNote(null);
    try {
      const bluetooth = await ensureBluetoothPermission();
      const found = await NativeMedhub.listDevices(bluetooth ? SCAN_SECONDS : 0);
      found.sort((a, b) => Number(b.likely) - Number(a.likely) || a.name.localeCompare(b.name));
      setDevices(found);
      const bluetoothProblem = bluetooth ? await NativeMedhub.bluetoothStatus() : 'Bluetooth permission was denied';
      if (bluetoothProblem) setNote(`${bluetoothProblem}, so only USB devices are listed.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  return (
    <Overlay title="Connect a board" onClose={onClose}>
      <Text style={styles.help}>
        USB: plug the ESP32 in with a data cable. Bluetooth: power the board with Medhub BLE firmware nearby.
      </Text>
      <ScrollView style={styles.list}>
        {devices.map((d) => (
          <Pressable
            key={d.id}
            onPress={() => onPick(d)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, d.likely && styles.likely, pressed && styles.pressed]}>
            <View style={[styles.badge, d.transport === 'ble' ? styles.ble : styles.usb]}>
              <Text style={styles.badgeText}>{d.transport === 'ble' ? 'BLE' : 'USB'}</Text>
            </View>
            <View style={styles.rowText}>
              <Text style={styles.name}>{d.name}</Text>
              <Text style={styles.detail} numberOfLines={1}>
                {d.detail}
              </Text>
            </View>
            {d.likely ? <Text style={styles.likelyText}>ESP32 board?</Text> : null}
          </Pressable>
        ))}
        {!scanning && devices.length === 0 ? <Text style={styles.empty}>No devices found.</Text> : null}
      </ScrollView>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <View style={styles.actions}>
        {scanning ? (
          <View style={styles.scanning}>
            <ActivityIndicator color={colors.muted} />
            <Text style={styles.help}>Scanning…</Text>
          </View>
        ) : (
          <Button label="Scan again" onPress={() => void scan()} />
        )}
        <Button label="Use simulated signal" variant="ghost" onPress={onDemo} />
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  help: { color: colors.muted, fontSize: 13 },
  list: { marginVertical: space.md, maxHeight: 360 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    backgroundColor: colors.raised,
    marginBottom: space.sm,
  },
  likely: { borderColor: '#2a8a5d' },
  pressed: { opacity: 0.7 },
  badge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  usb: { backgroundColor: '#24476b' },
  ble: { backgroundColor: '#4b2f6b' },
  badgeText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  rowText: { flex: 1 },
  name: { color: colors.text, fontSize: 14, fontWeight: '600' },
  detail: { color: colors.faint, fontSize: 12, fontFamily: mono },
  likelyText: { color: colors.ok, fontSize: 12 },
  empty: { color: colors.faint, textAlign: 'center', padding: space.lg },
  note: { color: colors.warn, fontSize: 12, marginBottom: space.sm },
  actions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scanning: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
