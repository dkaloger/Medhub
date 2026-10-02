// Windows implementation of the MedhubNative module (see src/native/NativeMedhub.ts):
// USB serial through Win32 COM ports, Bluetooth LE through WinRT GATT, and the
// recordings folder in Documents\Medhub Recordings.
//
// Header-only and included from Medhub.cpp; AddAttributedModules registers it.

#pragma once

#include "NativeModules.h"

#include <initguid.h>
#include <devguid.h>
#include <setupapi.h>
#include <shlobj.h>
#include <shellapi.h>

#include <winrt/Windows.Devices.Bluetooth.Advertisement.h>
#include <winrt/Windows.Devices.Bluetooth.GenericAttributeProfile.h>
#include <winrt/Windows.Devices.Bluetooth.h>
#include <winrt/Windows.Devices.Radios.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.Streams.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <map>
#include <mutex>
#include <regex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "setupapi.lib")

namespace Medhub {

namespace React = winrt::Microsoft::ReactNative;
namespace BLE = winrt::Windows::Devices::Bluetooth;
namespace Gatt = winrt::Windows::Devices::Bluetooth::GenericAttributeProfile;
namespace Adv = winrt::Windows::Devices::Bluetooth::Advertisement;
using winrt::Windows::Security::Cryptography::CryptographicBuffer;

inline constexpr wchar_t kEmitter[] = L"RCTDeviceEventEmitter";
inline constexpr wchar_t kDataEvent[] = L"MedhubData";
inline constexpr wchar_t kStateEvent[] = L"MedhubState";
// Nordic UART Service: the board notifies the same text lines on the TX characteristic.
inline const winrt::guid kUartService{L"6E400001-B5A3-F393-E0A9-E50E24DCCA9E"};
inline const winrt::guid kUartTx{L"6E400003-B5A3-F393-E0A9-E50E24DCCA9E"};
inline constexpr double kEmitIntervalMs = 20;

inline double MonotonicMs() noexcept {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

inline bool IsKnownBridge(int vid, int pid) noexcept {
  static const int known[][2] = {{0x10C4, 0xEA60}, {0x1A86, 0x7523}, {0x1A86, 0x55D4}, {0x0403, 0x6001}, {0x303A, 0x1001}};
  for (auto const &k : known) {
    if (k[0] == vid && k[1] == pid) return true;
  }
  return false;
}

inline bool IsSafeSegment(std::string const &segment) {
  static const std::regex pattern{"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$"};
  return std::regex_match(segment, pattern);
}

inline std::vector<std::string> Split(std::string const &path) {
  std::vector<std::string> parts;
  size_t start = 0;
  while (start <= path.size() && !path.empty()) {
    size_t slash = path.find('/', start);
    parts.push_back(path.substr(start, slash == std::string::npos ? std::string::npos : slash - start));
    if (slash == std::string::npos) break;
    start = slash + 1;
  }
  return parts;
}

inline std::string LastErrorText(DWORD error = GetLastError()) {
  wchar_t *buffer = nullptr;
  FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, error, 0,
                 reinterpret_cast<wchar_t *>(&buffer), 0, nullptr);
  std::string text = buffer ? winrt::to_string(buffer) : "error " + std::to_string(error);
  if (buffer) LocalFree(buffer);
  while (!text.empty() && (text.back() == '\n' || text.back() == '\r' || text.back() == '.')) text.pop_back();
  return text;
}

inline React::ReactError Error(std::string message) {
  return React::ReactError{"medhub", std::move(message), {}};
}

REACT_MODULE(MedhubNative)
struct MedhubNative {
  REACT_INIT(Initialize)
  void Initialize(React::ReactContext const &context) noexcept {
    m_context = context;
  }

  ~MedhubNative() {
    StopEverything();
    std::lock_guard lock{m_storageMutex};
    for (auto &[id, handle] : m_files) CloseHandle(handle);
  }

  // ---- Devices ----------------------------------------------------------------------

  REACT_METHOD(listDevices)
  void listDevices(double scanSeconds, React::ReactPromise<React::JSValue> promise) noexcept {
    ListDevicesAsync(scanSeconds, promise);
  }

  REACT_METHOD(bluetoothStatus)
  void bluetoothStatus(React::ReactPromise<React::JSValue> promise) noexcept {
    BluetoothStatusAsync(promise);
  }

  REACT_METHOD(connect)
  void connect(std::string id, React::ReactPromise<void> promise) noexcept {
    StopEverything();
    if (id.rfind("usb:", 0) == 0) {
      std::string error = OpenSerial(id.substr(4));
      if (!error.empty()) return promise.Reject(Error(error));
      promise.Resolve();
      EmitState("connected", "Connected to " + id.substr(4), false);
    } else if (id.rfind("ble:", 0) == 0) {
      uint64_t address = 0;
      try {
        address = std::stoull(id.substr(4), nullptr, 16);
      } catch (std::exception const &) {
        return promise.Reject(Error("Invalid Bluetooth id " + id));
      }
      ConnectBleAsync(address, promise);
    } else {
      promise.Reject(Error("Unknown device id " + id));
    }
  }

  REACT_METHOD(disconnect)
  void disconnect(React::ReactPromise<void> promise) noexcept {
    StopEverything();
    promise.Resolve();
  }

  REACT_METHOD(addListener)
  void addListener(std::string) noexcept {}

  REACT_METHOD(removeListeners)
  void removeListeners(double) noexcept {}

  // ---- Recordings folder --------------------------------------------------------------

  REACT_METHOD(recordingsRoot)
  void recordingsRoot(React::ReactPromise<React::JSValue> promise) noexcept {
    try {
      promise.Resolve(React::JSValue(winrt::to_string(Root().wstring())));
    } catch (std::exception const &e) {
      promise.Reject(Error(e.what()));
    }
  }

  REACT_METHOD(createFile)
  void createFile(std::string folder, std::string fileName, React::ReactPromise<React::JSValue> promise) noexcept {
    try {
      auto segments = Split(folder);
      segments.push_back(fileName);
      for (auto const &segment : segments) {
        if (!IsSafeSegment(segment)) return promise.Reject(Error("Invalid file name: " + segment));
      }
      std::filesystem::path dir = Root();
      for (size_t i = 0; i + 1 < segments.size(); i++) dir /= winrt::to_hstring(segments[i]).c_str();
      std::filesystem::create_directories(dir);
      std::filesystem::path name{winrt::to_hstring(fileName).c_str()};
      for (int attempt = 1; attempt < 1000; attempt++) {
        auto candidate = dir / (attempt == 1 ? name : std::filesystem::path(name.stem().wstring() + L"-" + std::to_wstring(attempt) +
                                                                            name.extension().wstring()));
        HANDLE handle = CreateFileW(candidate.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (handle != INVALID_HANDLE_VALUE) {
          std::lock_guard lock{m_storageMutex};
          int id = m_nextFileId++;
          m_files[id] = handle;
          React::JSValueObject result;
          result["id"] = id;
          result["path"] = winrt::to_string(candidate.wstring());
          return promise.Resolve(React::JSValue(std::move(result)));
        }
        if (GetLastError() != ERROR_FILE_EXISTS) return promise.Reject(Error("Cannot create file: " + LastErrorText()));
      }
      promise.Reject(Error("No free file name"));
    } catch (std::exception const &e) {
      promise.Reject(Error(e.what()));
    }
  }

  REACT_METHOD(appendFile)
  void appendFile(double id, std::string text, React::ReactPromise<void> promise) noexcept {
    std::lock_guard lock{m_storageMutex};
    auto it = m_files.find(static_cast<int>(id));
    if (it == m_files.end()) return promise.Reject(Error("File is not open"));
    DWORD written = 0;
    if (!WriteFile(it->second, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) || written != text.size()) {
      return promise.Reject(Error("Write failed: " + LastErrorText()));
    }
    promise.Resolve();
  }

  REACT_METHOD(closeFile)
  void closeFile(double id, React::ReactPromise<void> promise) noexcept {
    std::lock_guard lock{m_storageMutex};
    auto it = m_files.find(static_cast<int>(id));
    if (it == m_files.end()) return promise.Reject(Error("File is not open"));
    CloseHandle(it->second);
    m_files.erase(it);
    promise.Resolve();
  }

  REACT_METHOD(listRecordings)
  void listRecordings(React::ReactPromise<React::JSValue> promise) noexcept {
    try {
      auto root = Root();
      React::JSValueArray files;
      for (auto const &entry : std::filesystem::recursive_directory_iterator(root)) {
        if (!entry.is_regular_file() || entry.path().extension() != L".csv") continue;
        WIN32_FILE_ATTRIBUTE_DATA info{};
        GetFileAttributesExW(entry.path().c_str(), GetFileExInfoStandard, &info);
        ULARGE_INTEGER modified{info.ftLastWriteTime.dwLowDateTime, info.ftLastWriteTime.dwHighDateTime};
        std::string relative = winrt::to_string(std::filesystem::relative(entry.path(), root).wstring());
        std::replace(relative.begin(), relative.end(), '\\', '/');
        React::JSValueObject file;
        file["path"] = relative;
        file["size"] = static_cast<double>(entry.file_size());
        file["modified"] = (static_cast<double>(modified.QuadPart) - 116444736000000000.0) / 10000.0;
        files.push_back(React::JSValue(std::move(file)));
      }
      promise.Resolve(React::JSValue(std::move(files)));
    } catch (std::exception const &e) {
      promise.Reject(Error(e.what()));
    }
  }

  REACT_METHOD(readRecording)
  void readRecording(std::string path, React::ReactPromise<React::JSValue> promise) noexcept {
    try {
      std::filesystem::path file = Root();
      for (auto const &segment : Split(path)) {
        if (!IsSafeSegment(segment)) return promise.Reject(Error("Invalid recording path"));
        file /= winrt::to_hstring(segment).c_str();
      }
      HANDLE handle = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
      if (handle == INVALID_HANDLE_VALUE) return promise.Reject(Error("Cannot open recording: " + LastErrorText()));
      std::string text(static_cast<size_t>(std::filesystem::file_size(file)), '\0');
      DWORD read = 0;
      BOOL ok = ReadFile(handle, text.data(), static_cast<DWORD>(text.size()), &read, nullptr);
      CloseHandle(handle);
      if (!ok) return promise.Reject(Error("Cannot read recording: " + LastErrorText()));
      text.resize(read);
      promise.Resolve(React::JSValue(std::move(text)));
    } catch (std::exception const &e) {
      promise.Reject(Error(e.what()));
    }
  }

  REACT_METHOD(revealRecordings)
  void revealRecordings(React::ReactPromise<void> promise) noexcept {
    try {
      ShellExecuteW(nullptr, L"open", Root().c_str(), nullptr, nullptr, SW_SHOWNORMAL);
      promise.Resolve();
    } catch (std::exception const &e) {
      promise.Reject(Error(e.what()));
    }
  }

 private:
  React::ReactContext m_context;
  std::atomic<uint64_t> m_generation{0};

  std::mutex m_serialMutex;
  HANDLE m_serial{INVALID_HANDLE_VALUE};

  std::mutex m_bleMutex;
  BLE::BluetoothLEDevice m_device{nullptr};
  Gatt::GattSession m_session{nullptr};
  Gatt::GattCharacteristic m_tx{nullptr};
  winrt::event_token m_valueToken{};
  winrt::event_token m_statusToken{};
  bool m_bleStreaming{false};

  std::mutex m_storageMutex;
  std::map<int, HANDLE> m_files;
  int m_nextFileId{1};

  static std::filesystem::path Root() {
    PWSTR documents = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_Documents, KF_FLAG_CREATE, nullptr, &documents))) {
      throw std::runtime_error("Documents folder unavailable");
    }
    std::filesystem::path root = std::filesystem::path(documents) / L"Medhub Recordings";
    CoTaskMemFree(documents);
    std::filesystem::create_directories(root);
    return root;
  }

  void EmitState(std::string const &state, std::string const &detail, bool lost) noexcept {
    React::JSValueObject event;
    event["state"] = state;
    event["detail"] = detail;
    event["lost"] = lost;
    m_context.EmitJSEvent(kEmitter, kStateEvent, React::JSValue(std::move(event)));
  }

  void EmitData(winrt::Windows::Storage::Streams::IBuffer const &bytes, double t) noexcept {
    if (!bytes || bytes.Length() == 0) return;
    React::JSValueObject event;
    event["data"] = winrt::to_string(CryptographicBuffer::EncodeToBase64String(bytes));
    event["t"] = t;
    m_context.EmitJSEvent(kEmitter, kDataEvent, React::JSValue(std::move(event)));
  }

  void StopEverything() noexcept {
    m_generation++;
    {
      std::lock_guard lock{m_serialMutex};
      if (m_serial != INVALID_HANDLE_VALUE) {
        CancelIoEx(m_serial, nullptr);
        CloseHandle(m_serial);
        m_serial = INVALID_HANDLE_VALUE;
      }
    }
    std::lock_guard lock{m_bleMutex};
    m_bleStreaming = false;
    if (m_tx) m_tx.ValueChanged(m_valueToken);
    if (m_device) m_device.ConnectionStatusChanged(m_statusToken);
    m_tx = nullptr;
    if (m_session) m_session.Close();
    m_session = nullptr;
    if (m_device) m_device.Close();
    m_device = nullptr;
  }

  // ---- USB serial (COM ports) -----------------------------------------------------------

  static React::JSValueArray UsbDevices() {
    React::JSValueArray devices;
    HDEVINFO set = SetupDiGetClassDevsW(&GUID_DEVCLASS_PORTS, nullptr, nullptr, DIGCF_PRESENT);
    if (set == INVALID_HANDLE_VALUE) return devices;
    SP_DEVINFO_DATA info{sizeof(SP_DEVINFO_DATA)};
    for (DWORD i = 0; SetupDiEnumDeviceInfo(set, i, &info); i++) {
      wchar_t hardwareId[512]{};
      wchar_t friendly[256]{};
      SetupDiGetDeviceRegistryPropertyW(set, &info, SPDRP_HARDWAREID, nullptr, reinterpret_cast<PBYTE>(hardwareId), sizeof(hardwareId), nullptr);
      SetupDiGetDeviceRegistryPropertyW(set, &info, SPDRP_FRIENDLYNAME, nullptr, reinterpret_cast<PBYTE>(friendly), sizeof(friendly), nullptr);
      wchar_t portName[64]{};
      HKEY key = SetupDiOpenDevRegKey(set, &info, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ);
      if (key != INVALID_HANDLE_VALUE) {
        DWORD size = sizeof(portName);
        RegQueryValueExW(key, L"PortName", nullptr, nullptr, reinterpret_cast<LPBYTE>(portName), &size);
        RegCloseKey(key);
      }
      std::wstring id{hardwareId};
      auto vidAt = id.find(L"VID_");
      auto pidAt = id.find(L"PID_");
      if (vidAt == std::wstring::npos || pidAt == std::wstring::npos || portName[0] == 0) continue; // not USB
      int vid = std::stoi(id.substr(vidAt + 4, 4), nullptr, 16);
      int pid = std::stoi(id.substr(pidAt + 4, 4), nullptr, 16);
      char detail[64];
      snprintf(detail, sizeof(detail), "%s · %04X:%04X", winrt::to_string(portName).c_str(), vid, pid);
      React::JSValueObject device;
      device["id"] = "usb:" + winrt::to_string(portName);
      device["name"] = winrt::to_string(friendly[0] ? friendly : portName);
      device["transport"] = "usb";
      device["detail"] = std::string(detail);
      device["likely"] = IsKnownBridge(vid, pid);
      devices.push_back(React::JSValue(std::move(device)));
    }
    SetupDiDestroyDeviceInfoList(set);
    return devices;
  }

  std::string OpenSerial(std::string const &port) {
    std::wstring path = L"\\\\.\\" + std::wstring(winrt::to_hstring(port));
    HANDLE handle = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (handle == INVALID_HANDLE_VALUE) return "Cannot open " + port + ": " + LastErrorText();
    DCB dcb{sizeof(DCB)};
    GetCommState(handle, &dcb);
    dcb.BaudRate = 115200;
    dcb.ByteSize = 8;
    dcb.Parity = NOPARITY;
    dcb.StopBits = ONESTOPBIT;
    dcb.fBinary = TRUE;
    dcb.fParity = FALSE;
    dcb.fOutxCtsFlow = FALSE;
    dcb.fOutxDsrFlow = FALSE;
    dcb.fOutX = FALSE;
    dcb.fInX = FALSE;
    dcb.fDtrControl = DTR_CONTROL_ENABLE;
    dcb.fRtsControl = RTS_CONTROL_ENABLE;
    // Return as soon as bytes arrive, or after 100 ms without any.
    COMMTIMEOUTS timeouts{MAXDWORD, MAXDWORD, 100, 0, 0};
    if (!SetCommState(handle, &dcb) || !SetCommTimeouts(handle, &timeouts)) {
      std::string error = "Cannot configure " + port + ": " + LastErrorText();
      CloseHandle(handle);
      return error;
    }
    PurgeComm(handle, PURGE_RXCLEAR);
    {
      std::lock_guard lock{m_serialMutex};
      m_serial = handle;
    }
    uint64_t generation = m_generation;
    std::thread([this, handle, port, generation] { ReadSerial(handle, port, generation); }).detach();
    return {};
  }

  // Coalesces bytes into ~20 ms events, each stamped with the time of its last read.
  void ReadSerial(HANDLE handle, std::string port, uint64_t generation) noexcept {
    std::vector<uint8_t> pending;
    uint8_t buffer[4096];
    double lastEmit = MonotonicMs();
    double lastRead = lastEmit;
    bool lost = false;
    while (m_generation == generation) {
      DWORD read = 0;
      if (!ReadFile(handle, buffer, sizeof(buffer), &read, nullptr)) {
        lost = true;
        break;
      }
      double now = MonotonicMs();
      if (read > 0) {
        pending.insert(pending.end(), buffer, buffer + read);
        lastRead = now;
      }
      if (!pending.empty() && now - lastEmit >= kEmitIntervalMs) {
        EmitData(CryptographicBuffer::CreateFromByteArray(pending), lastRead);
        pending.clear();
        lastEmit = now;
      }
    }
    if (m_generation != generation) return;
    if (!pending.empty()) EmitData(CryptographicBuffer::CreateFromByteArray(pending), lastRead);
    if (lost) {
      {
        std::lock_guard lock{m_serialMutex};
        if (m_serial == handle) {
          CloseHandle(m_serial);
          m_serial = INVALID_HANDLE_VALUE;
        }
      }
      EmitState("disconnected", port + " was disconnected", true);
    }
  }

  // ---- Bluetooth LE ---------------------------------------------------------------------

  static winrt::Windows::Foundation::IAsyncOperation<winrt::hstring> BluetoothProblemAsync() {
    auto adapter = co_await BLE::BluetoothAdapter::GetDefaultAsync();
    if (!adapter) co_return L"This PC has no Bluetooth adapter";
    if (!adapter.IsLowEnergySupported()) co_return L"This PC's Bluetooth does not support LE";
    auto radio = co_await adapter.GetRadioAsync();
    if (!radio || radio.State() != winrt::Windows::Devices::Radios::RadioState::On) co_return L"Bluetooth is turned off";
    co_return L"";
  }

  winrt::fire_and_forget BluetoothStatusAsync(React::ReactPromise<React::JSValue> promise) noexcept {
    try {
      auto problem = co_await BluetoothProblemAsync();
      promise.Resolve(React::JSValue(winrt::to_string(problem)));
    } catch (winrt::hresult_error const &e) {
      promise.Resolve(React::JSValue(winrt::to_string(e.message())));
    }
  }

  winrt::fire_and_forget ListDevicesAsync(double scanSeconds, React::ReactPromise<React::JSValue> promise) noexcept {
    React::JSValueArray devices = UsbDevices();
    try {
      if (scanSeconds > 0 && (co_await BluetoothProblemAsync()).empty()) {
        auto found = std::make_shared<std::map<uint64_t, React::JSValueObject>>();
        auto mutex = std::make_shared<std::mutex>();
        Adv::BluetoothLEAdvertisementWatcher watcher;
        watcher.ScanningMode(Adv::BluetoothLEScanningMode::Active);
        watcher.Received([found, mutex](auto const &, Adv::BluetoothLEAdvertisementReceivedEventArgs const &args) {
          auto advert = args.Advertisement();
          std::string name = winrt::to_string(advert.LocalName());
          bool uart = false;
          for (auto const &uuid : advert.ServiceUuids()) uart = uart || uuid == kUartService;
          if (name.empty() && !uart) return;
          char id[32];
          snprintf(id, sizeof(id), "ble:%012llx", static_cast<unsigned long long>(args.BluetoothAddress()));
          std::string lower = name;
          std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
          React::JSValueObject device;
          device["id"] = std::string(id);
          device["name"] = name.empty() ? std::string("Unnamed BLE device") : name;
          device["transport"] = "ble";
          device["detail"] = std::to_string(args.RawSignalStrengthInDBm()) + " dBm" + (uart ? " · UART service" : "");
          device["likely"] = uart || lower.find("medhub") != std::string::npos;
          std::lock_guard lock{*mutex};
          (*found)[args.BluetoothAddress()] = std::move(device);
        });
        watcher.Start();
        co_await winrt::resume_after(std::chrono::milliseconds(static_cast<int64_t>(scanSeconds * 1000)));
        watcher.Stop();
        std::lock_guard lock{*mutex};
        for (auto &[address, device] : *found) devices.push_back(React::JSValue(std::move(device)));
      }
    } catch (winrt::hresult_error const &) {
      // Bluetooth trouble shouldn't hide USB devices; bluetoothStatus() reports it.
    }
    promise.Resolve(React::JSValue(std::move(devices)));
  }

  winrt::fire_and_forget ConnectBleAsync(uint64_t address, React::ReactPromise<void> promise) noexcept {
    uint64_t generation = m_generation;
    try {
      auto problem = co_await BluetoothProblemAsync();
      if (!problem.empty()) co_return promise.Reject(Error(winrt::to_string(problem)));
      auto device = co_await BLE::BluetoothLEDevice::FromBluetoothAddressAsync(address);
      if (!device) co_return promise.Reject(Error("Bluetooth device not found; scan again"));
      auto session = co_await Gatt::GattSession::FromDeviceIdAsync(device.BluetoothDeviceId());
      session.MaintainConnection(true);
      auto services = co_await device.GetGattServicesForUuidAsync(kUartService, BLE::BluetoothCacheMode::Uncached);
      if (services.Status() != Gatt::GattCommunicationStatus::Success || services.Services().Size() == 0) {
        co_return promise.Reject(Error("This device does not offer the Medhub UART service"));
      }
      auto characteristics = co_await services.Services().GetAt(0).GetCharacteristicsForUuidAsync(kUartTx, BLE::BluetoothCacheMode::Uncached);
      if (characteristics.Status() != Gatt::GattCommunicationStatus::Success || characteristics.Characteristics().Size() == 0) {
        co_return promise.Reject(Error("The UART service has no TX characteristic"));
      }
      auto tx = characteristics.Characteristics().GetAt(0);
      if (m_generation != generation) co_return promise.Reject(Error("Connection cancelled"));
      {
        std::lock_guard lock{m_bleMutex};
        m_device = device;
        m_session = session;
        m_tx = tx;
        m_valueToken = tx.ValueChanged([this, generation](auto const &, Gatt::GattValueChangedEventArgs const &args) {
          if (m_generation == generation) EmitData(args.CharacteristicValue(), MonotonicMs());
        });
        m_statusToken = device.ConnectionStatusChanged([this, generation](BLE::BluetoothLEDevice const &sender, auto const &) {
          if (m_generation != generation || sender.ConnectionStatus() != BLE::BluetoothConnectionStatus::Disconnected) return;
          bool wasStreaming;
          {
            std::lock_guard lock{m_bleMutex};
            wasStreaming = m_bleStreaming;
            m_bleStreaming = false;
          }
          if (wasStreaming) EmitState("disconnected", winrt::to_string(sender.Name()) + " disconnected", true);
        });
      }
      auto status = co_await tx.WriteClientCharacteristicConfigurationDescriptorAsync(
          Gatt::GattClientCharacteristicConfigurationDescriptorValue::Notify);
      if (status != Gatt::GattCommunicationStatus::Success) {
        StopEverything();
        co_return promise.Reject(Error("Could not enable Bluetooth notifications"));
      }
      {
        std::lock_guard lock{m_bleMutex};
        m_bleStreaming = true;
      }
      promise.Resolve();
      EmitState("connected", "Connected to " + winrt::to_string(device.Name()) + " over Bluetooth", false);
    } catch (winrt::hresult_error const &e) {
      promise.Reject(Error(winrt::to_string(e.message())));
    }
  }
};

} // namespace Medhub
