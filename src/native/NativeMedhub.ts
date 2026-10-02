/**
 * The app's one native module, implemented per platform:
 *   android/app/src/main/java/com/medhub/link/   (Kotlin)
 *   macos/medhub-macOS/MedhubNative.mm            (Objective-C++)
 *   windows/Medhub/MedhubNative.h                 (C++/WinRT)
 *
 * It owns the device connection (USB serial or Bluetooth LE) and the recordings folder.
 * Device bytes are delivered as `MedhubData` events, base64-encoded and stamped with a
 * native monotonic clock at read time.
 */
import { TurboModuleRegistry, type TurboModule } from 'react-native';

export type Transport = 'usb' | 'ble';

export interface DeviceInfo {
  /** Stable across reconnects: USB "vid:pid:serial" or port path, or the BLE identifier. */
  id: string;
  name: string;
  transport: Transport;
  /** e.g. the port path or signal strength. */
  detail: string;
  /** True for known ESP32 USB bridges or devices advertising the Medhub BLE service. */
  likely: boolean;
}

export interface RecordingFileInfo {
  /** Path relative to the recordings folder, using '/' separators. */
  path: string;
  size: number;
  /** Milliseconds since the epoch. */
  modified: number;
}

export interface DataEvent {
  data: string;
  /** Native monotonic milliseconds when the bytes were read. */
  t: number;
}

export interface StateEvent {
  state: 'connecting' | 'connected' | 'disconnected';
  detail: string;
  /** True when the device went away unexpectedly (unplugged, out of range). */
  lost: boolean;
}

export interface Spec extends TurboModule {
  /** USB devices immediately plus any BLE devices found while scanning for `scanSeconds`. */
  listDevices(scanSeconds: number): Promise<DeviceInfo[]>;
  /** Empty when Bluetooth LE is usable, otherwise why not (off, permission denied…). */
  bluetoothStatus(): Promise<string>;
  /** Resolves once the stream is open. Only one device is connected at a time. */
  connect(id: string): Promise<void>;
  disconnect(): Promise<void>;

  recordingsRoot(): Promise<string>;
  /** Exclusively creates `<root>/<folder>/<fileName>`, adding -2, -3… when taken. */
  createFile(folder: string, fileName: string): Promise<{ id: number; path: string }>;
  appendFile(id: number, text: string): Promise<void>;
  closeFile(id: number): Promise<void>;
  listRecordings(): Promise<RecordingFileInfo[]>;
  readRecording(path: string): Promise<string>;
  revealRecordings(): Promise<void>;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export const DATA_EVENT = 'MedhubData';
export const STATE_EVENT = 'MedhubState';

/** Null when the native module is missing (e.g. a platform it has not been built for). */
const NativeMedhub: Spec | null = TurboModuleRegistry.get<Spec>('MedhubNative');
export default NativeMedhub;

export function requireNative(): Spec {
  if (!NativeMedhub) throw new Error('The Medhub native module is not available on this platform.');
  return NativeMedhub;
}
