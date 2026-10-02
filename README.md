# Medhub

A bench viewer for the ADS1292R ECG / respiration board on an ESP32. It is a React Native
app for **Android, macOS and Windows** and connects to the board over **USB serial** or
**Bluetooth LE**.

> **Experimental bench tool, not a medical device.** Heart and breathing rates are
> estimates and are not diagnostic. Do not attach electrodes to a person while the board is
> powered from, or wired to, mains-connected equipment. Run it from a battery and use
> Bluetooth, or use a USB isolator.

The original Python/Tk viewer is preserved on the `archive` branch.

## Features

- **Live display:** ECG and respiration traces that redraw continuously.
  - **ECG filters:** Raw, Low-pass 40 Hz, and Monitor 0.5–40 Hz, plus an optional
    50 or 60 Hz mains notch.
  - **Respiration filters:** Raw, Low-pass 2 Hz, and Breathing 0.07–0.7 Hz.
  - **Filtering is causal and incremental:** each sample is filtered once, as it arrives.
  - **Virtual ECG paper:** a 1 mm / 5 mm grid at 12.5, 25 or 50 mm/s and 5, 10 or 20 mm/mV,
    in nominal millivolts.
- **Pause and look back:** pause, then drag a trace to scroll back through the last
  10 minutes.
- **Rate estimates:** heart rate (QRS detection over the last 15 s) and breathing rate
  (over the last 60 s).
  - **Honest failures:** each estimate reports why it has no value, e.g. "ADC clipped",
    "no clear beats", "too many missed breaths".
  - **No splicing:** an estimate never joins data across a dropout.
- **Continuous logging:** every sample is written to disk, in 10-minute part files plus an
  `events.csv` of connections, dropouts and device messages.
- **Clips:** record up to 2-minute clips.
- **Review:** open any recording, including CSVs from the old Python viewer, scroll through
  it, and see the metrics at any point.
- **Dropout detection:** the firmware has no sample counter, so dropouts are inferred from
  arrival times and stored as gaps. Timestamps stay correct across unplugs and Bluetooth
  dropouts.

## Layout

```
src/core/      Platform-independent signal code (unit-tested)
  protocol.ts      Line parsing and framing (partial lines are never parsed)
  filters.ts       Butterworth / notch biquads, streaming FilterChain, filtfilt
  peaks.ts         find_peaks equivalent
  metrics.ts       Heart rate, breathing rate, ADC status
  acquisition.ts   Ring buffers, display filtering, gap detection
  recorder.ts      Continuous logger and clip writer
  recordingFile.ts CSV format and reader
src/session/   Live session state, demo source
src/native/    JS side of the native module (device link + recordings folder)
src/ui/        Screens and the SVG trace renderer
android/app/src/main/java/com/medhub/link/   Native module, Android (Kotlin)
macos/MedhubNative/                          Native module, macOS (Objective-C++)
windows/Medhub/MedhubNative.h                Native module, Windows (C++/WinRT)
docs/ble-protocol.md                         What BLE firmware has to send
tests/                                       Vitest suites (DSP checked against SciPy)
```

## Recordings

| Platform | Folder |
| --- | --- |
| macOS | `~/Documents/Medhub Recordings` |
| Windows | `Documents\Medhub Recordings` |
| Android | `Android/data/com.medhub/files/recordings` (reachable over USB file transfer) |

Each file has the columns `sample_index,time_s,ecg_counts,resp_counts`. A jump in
`sample_index` marks a dropout, and `resp_counts` is empty when the firmware doesn't send
respiration.

## Development

Requirements: Node 20+, then `npm install` (which also applies `patches/`).

```bash
npm test
```

```bash
npm run typecheck
```

### macOS

Needs Xcode and CocoaPods (`brew install cocoapods`).

```bash
cd macos && pod install && cd ..
```

```bash
npm run macos
```

### Android

Needs Android Studio, including the SDK and JDK 17. USB needs a phone or tablet with
USB-OTG and an OTG adapter; Bluetooth needs Android 8 or later with BLE.

```bash
npm run android
```

### Windows

Needs a Windows PC with Visual Studio 2022 and the React Native for Windows workloads; see
[the React Native for Windows dependencies](https://microsoft.github.io/react-native-windows/docs/rnw-dependencies).

```bash
npm run windows
```

## Connecting the board

- **USB:** plug in the ESP32 and choose **Connect…**. Known ESP32 USB bridges are listed
  first: CP210x, CH340/CH9102, FTDI, and native ESP32 USB.
- **Bluetooth LE:** the firmware must implement [docs/ble-protocol.md](docs/ble-protocol.md).
  The current firmware only streams over USB.
- **Simulated signal:** **Connect… → Use simulated signal** runs the UI without hardware.
  Simulated sessions are labelled and saved with a `simulated_` prefix.

## Verification status

| Platform | Built | Tested |
| --- | --- | --- |
| Shared TypeScript core | n/a | 63 unit tests (filters and peak picking match SciPy) |
| macOS | yes | UI, simulated stream, logging, review |
| Android | no (needs Android SDK) | not yet |
| Windows | no (needs a Windows PC) | not yet |

On macOS the USB and Bluetooth paths compiled but weren't exercised on hardware: the board
was unplugged and Bluetooth was off during testing. All native code follows the same module
contract in `src/native/NativeMedhub.ts`.
