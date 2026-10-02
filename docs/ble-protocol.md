# Bluetooth LE protocol

Over Bluetooth the board sends **exactly the same text lines** as over USB serial. They go
through the Nordic UART Service (NUS), which most BLE serial tools also understand.

| Item | UUID |
| --- | --- |
| Service | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| TX characteristic (board → app, **notify**) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |
| RX characteristic (app → board, write; unused today) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |

The app subscribes to TX notifications and treats the bytes as one continuous stream. Line
boundaries do not need to line up with notifications: a line may be split across two
notifications, or one notification may carry several lines.

```
ECG:-695421\tRESP:1015296\n     ECG + respiration (ADS1292R CH1)
ECG:-695421\tZERO:0\n           ECG-only firmware
READY_…\n / ERROR_…\n            status messages
```

## Firmware requirements

- **Advertising:** advertise the NUS service UUID, ideally with a name containing
  `Medhub`, e.g. `Medhub-ECG`. The app marks such devices as likely matches.
- **Batching:** at 250 samples/s the stream is about 6 kB/s. Batch lines into
  notifications of up to MTU − 3 bytes instead of sending one notification per line.
  Android and macOS negotiate an MTU of 247; flush at least every 20 ms.
- **Sample order:** keep samples in order and never drop part of a line. The app detects
  dropouts from arrival times and marks them as gaps, but it cannot recover lost samples.
- **Sample counter (optional, recommended):** add a sample counter field, e.g.
  `N:123456`. Unknown fields are ignored today, and a counter would let a future
  version detect every lost sample exactly.

## Reference sketch (ESP32 Arduino core, NimBLE-Arduino 2.x)

This shows only the BLE side. Call `bleSendLine()` with the same line you already print to
`Serial`.

```cpp
#include <NimBLEDevice.h>

static NimBLECharacteristic *tx;
static char pending[244];
static size_t pendingLength = 0;
static uint32_t lastFlush = 0;

void bleBegin() {
  NimBLEDevice::init("Medhub-ECG");
  NimBLEDevice::setMTU(247);
  NimBLEServer *server = NimBLEDevice::createServer();
  NimBLEService *uart = server->createService("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
  tx = uart->createCharacteristic("6E400003-B5A3-F393-E0A9-E50E24DCCA9E", NIMBLE_PROPERTY::NOTIFY);
  uart->createCharacteristic("6E400002-B5A3-F393-E0A9-E50E24DCCA9E", NIMBLE_PROPERTY::WRITE);
  uart->start();
  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(uart->getUUID());
  advertising->setName("Medhub-ECG");
  advertising->start();
}

static void bleFlush() {
  if (pendingLength && NimBLEDevice::getServer()->getConnectedCount()) {
    tx->setValue(reinterpret_cast<uint8_t *>(pending), pendingLength);
    tx->notify();
  }
  pendingLength = 0;
  lastFlush = millis();
}

// Call with each complete line, including its trailing '\n'.
void bleSendLine(const char *line, size_t length) {
  size_t limit = NimBLEDevice::getServer()->getConnectedCount()
                     ? min<size_t>(sizeof(pending), NimBLEDevice::getServer()->getPeerMTU(0) - 3)
                     : sizeof(pending);
  if (pendingLength + length > limit) bleFlush();
  memcpy(pending + pendingLength, line, length);
  pendingLength += length;
  if (millis() - lastFlush >= 20) bleFlush();
}
```

> **Safety:** running the board from its own battery and talking to it over Bluetooth is
> the safer bench setup. Nothing then connects it electrically to a mains-powered computer.
