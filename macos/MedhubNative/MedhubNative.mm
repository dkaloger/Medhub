// macOS implementation of the MedhubNative module (see src/native/NativeMedhub.ts):
// USB serial through POSIX termios, Bluetooth LE through CoreBluetooth, and the
// recordings folder in ~/Documents/Medhub Recordings.

#import <AppKit/AppKit.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/serial/IOSerialKeys.h>
#import <IOKit/serial/ioss.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

#include <atomic>
#include <errno.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static NSString *const kDataEvent = @"MedhubData";
static NSString *const kStateEvent = @"MedhubState";
// Nordic UART Service: the board notifies the same text lines on the TX characteristic.
static NSString *const kUartService = @"6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
static NSString *const kUartTx = @"6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
static const speed_t kBaudRate = 115200;
static const double kEmitIntervalMs = 20;
static const double kBleConnectTimeoutS = 10;
static const double kBluetoothReadyTimeoutS = 3;

static double MonotonicMs(void) {
  return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1e6;
}

static BOOL IsKnownBridge(int vid, int pid) {
  static const int known[][2] = {{0x10C4, 0xEA60}, {0x1A86, 0x7523}, {0x1A86, 0x55D4}, {0x0403, 0x6001}, {0x303A, 0x1001}};
  for (const auto &k : known) {
    if (k[0] == vid && k[1] == pid) return YES;
  }
  return NO;
}

static BOOL IsSafeSegment(NSString *segment) {
  static NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$" options:0 error:nil];
  return segment.length > 0 && [pattern numberOfMatchesInString:segment options:0 range:NSMakeRange(0, segment.length)] == 1;
}

static id RegistryProperty(io_object_t service, CFStringRef key) {
  return CFBridgingRelease(IORegistryEntrySearchCFProperty(
      service, kIOServicePlane, key, kCFAllocatorDefault, kIORegistryIterateRecursively | kIORegistryIterateParents));
}

@interface MedhubNative : RCTEventEmitter <RCTBridgeModule, CBCentralManagerDelegate, CBPeripheralDelegate>
@end

@implementation MedhubNative {
  dispatch_queue_t _queue;
  dispatch_queue_t _bleQueue;
  std::atomic<bool> _hasListeners;
  // Bumped on every connect/disconnect so stale reader threads and callbacks stand down.
  std::atomic<uint64_t> _generation;

  int _fd;
  NSString *_serialPath;

  CBCentralManager *_central;
  NSMutableArray<void (^)(NSString *error)> *_bluetoothWaiters;
  NSMutableDictionary<NSString *, CBPeripheral *> *_peripherals;
  NSMutableDictionary<NSString *, NSDictionary *> *_scanResults;
  CBPeripheral *_peripheral;
  RCTPromiseResolveBlock _bleResolve;
  RCTPromiseRejectBlock _bleReject;
  BOOL _bleStreaming;
  BOOL _userDisconnect;

  NSMutableDictionary<NSNumber *, NSFileHandle *> *_files;
  NSInteger _nextFileId;
}

RCT_EXPORT_MODULE(MedhubNative)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("com.medhub.native", DISPATCH_QUEUE_SERIAL);
    _bleQueue = dispatch_queue_create("com.medhub.ble", DISPATCH_QUEUE_SERIAL);
    _fd = -1;
    _hasListeners = false;
    _generation = 0;
    _bluetoothWaiters = [NSMutableArray new];
    _peripherals = [NSMutableDictionary new];
    _scanResults = [NSMutableDictionary new];
    _files = [NSMutableDictionary new];
    _nextFileId = 1;
  }
  return self;
}

- (dispatch_queue_t)methodQueue {
  return _queue;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ kDataEvent, kStateEvent ];
}

- (void)startObserving {
  _hasListeners = true;
}

- (void)stopObserving {
  _hasListeners = false;
}

- (void)invalidate {
  _generation++;
  dispatch_sync(_queue, ^{
    [self closeSerial];
    for (NSFileHandle *handle in self->_files.allValues) [handle closeAndReturnError:nil];
    [self->_files removeAllObjects];
  });
  dispatch_sync(_bleQueue, ^{
    if (self->_peripheral) [self->_central cancelPeripheralConnection:self->_peripheral];
  });
  [super invalidate];
}

#pragma mark - Events

- (void)emitState:(NSString *)state detail:(NSString *)detail lost:(BOOL)lost {
  if (!_hasListeners) return;
  [self sendEventWithName:kStateEvent body:@{@"state" : state, @"detail" : detail, @"lost" : @(lost)}];
}

- (void)emitData:(NSData *)data at:(double)t {
  if (!_hasListeners || data.length == 0) return;
  [self sendEventWithName:kDataEvent body:@{@"data" : [data base64EncodedStringWithOptions:0], @"t" : @(t)}];
}

#pragma mark - Devices

RCT_EXPORT_METHOD(listDevices : (double)scanSeconds resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSArray *usb = [self usbDevices];
  if (scanSeconds <= 0) {
    resolve(usb);
    return;
  }
  dispatch_async(_bleQueue, ^{
    [self whenBluetoothReady:^(NSString *error) {
      if (error) {
        resolve(usb);
        return;
      }
      [self->_scanResults removeAllObjects];
      [self->_central scanForPeripheralsWithServices:nil options:@{CBCentralManagerScanOptionAllowDuplicatesKey : @NO}];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(scanSeconds * NSEC_PER_SEC)), self->_bleQueue, ^{
        [self->_central stopScan];
        resolve([usb arrayByAddingObjectsFromArray:self->_scanResults.allValues]);
      });
    }];
  });
}

RCT_EXPORT_METHOD(bluetoothStatus : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(_bleQueue, ^{
    [self whenBluetoothReady:^(NSString *error) {
      resolve(error ?: @"");
    }];
  });
}

- (NSArray<NSDictionary *> *)usbDevices {
  NSMutableArray *devices = [NSMutableArray new];
  CFMutableDictionaryRef matching = IOServiceMatching(kIOSerialBSDServiceValue);
  CFDictionarySetValue(matching, CFSTR(kIOSerialBSDTypeKey), CFSTR(kIOSerialBSDAllTypes));
  io_iterator_t iterator;
  if (IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) != KERN_SUCCESS) return devices;
  io_object_t service;
  while ((service = IOIteratorNext(iterator))) {
    NSString *path = CFBridgingRelease(IORegistryEntryCreateCFProperty(service, CFSTR(kIOCalloutDeviceKey), kCFAllocatorDefault, 0));
    NSNumber *vid = RegistryProperty(service, CFSTR("idVendor"));
    NSNumber *pid = RegistryProperty(service, CFSTR("idProduct"));
    NSString *product = RegistryProperty(service, CFSTR("USB Product Name"));
    IOObjectRelease(service);
    if (![path isKindOfClass:NSString.class] || ![vid isKindOfClass:NSNumber.class]) continue; // not USB
    [devices addObject:@{
      @"id" : [@"usb:" stringByAppendingString:path],
      @"name" : [product isKindOfClass:NSString.class] ? product : path.lastPathComponent,
      @"transport" : @"usb",
      @"detail" : [NSString stringWithFormat:@"%@ · %04X:%04X", path, vid.intValue, pid.intValue],
      @"likely" : @(IsKnownBridge(vid.intValue, pid.intValue)),
    }];
  }
  IOObjectRelease(iterator);
  return devices;
}

RCT_EXPORT_METHOD(connect : (NSString *)deviceId resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  [self stopEverything];
  if ([deviceId hasPrefix:@"usb:"]) {
    NSString *error = [self openSerial:[deviceId substringFromIndex:4]];
    if (error) {
      reject(@"open_failed", error, nil);
    } else {
      resolve(nil);
      [self emitState:@"connected" detail:[NSString stringWithFormat:@"Connected to %@", _serialPath] lost:NO];
    }
  } else if ([deviceId hasPrefix:@"ble:"]) {
    [self connectBle:[deviceId substringFromIndex:4] resolve:resolve reject:reject];
  } else {
    reject(@"bad_id", [NSString stringWithFormat:@"Unknown device id %@", deviceId], nil);
  }
}

RCT_EXPORT_METHOD(disconnect : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  [self stopEverything];
  resolve(nil);
}

- (void)stopEverything {
  _generation++;
  [self closeSerial];
  dispatch_sync(_bleQueue, ^{
    self->_userDisconnect = YES;
    self->_bleStreaming = NO;
    if (self->_bleReject) self->_bleReject(@"cancelled", @"Connection cancelled", nil);
    self->_bleResolve = nil;
    self->_bleReject = nil;
    if (self->_peripheral) [self->_central cancelPeripheralConnection:self->_peripheral];
    self->_peripheral = nil;
  });
}

#pragma mark - USB serial

- (NSString *)openSerial:(NSString *)path {
  int fd = open(path.fileSystemRepresentation, O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (fd < 0) return [NSString stringWithFormat:@"Cannot open %@: %s", path, strerror(errno)];
  struct termios options;
  if (ioctl(fd, TIOCEXCL) == -1 || fcntl(fd, F_SETFL, 0) == -1 || tcgetattr(fd, &options) == -1) {
    NSString *error = [NSString stringWithFormat:@"Cannot configure %@: %s", path, strerror(errno)];
    close(fd);
    return error;
  }
  cfmakeraw(&options);
  options.c_cflag = (options.c_cflag & ~(CSIZE | PARENB | CSTOPB | CRTSCTS)) | CS8 | CLOCAL | CREAD;
  options.c_cc[VMIN] = 0;
  options.c_cc[VTIME] = 1; // reads return after 0.1 s without data
  cfsetspeed(&options, kBaudRate);
  speed_t speed = kBaudRate;
  if (tcsetattr(fd, TCSANOW, &options) == -1 || ioctl(fd, IOSSIOSPEED, &speed) == -1) {
    NSString *error = [NSString stringWithFormat:@"Cannot set 115200 baud on %@: %s", path, strerror(errno)];
    close(fd);
    return error;
  }
  tcflush(fd, TCIFLUSH);

  _fd = fd;
  _serialPath = path;
  uint64_t generation = _generation;
  NSThread *reader = [[NSThread alloc] initWithBlock:^{
    [self readSerial:fd path:path generation:generation];
  }];
  reader.name = @"Medhub serial reader";
  reader.qualityOfService = NSQualityOfServiceUserInitiated;
  [reader start];
  return nil;
}

- (void)closeSerial {
  if (_fd >= 0) {
    close(_fd);
    _fd = -1;
  }
}

// Coalesces bytes into ~20 ms events, each stamped with the time of its last read.
- (void)readSerial:(int)fd path:(NSString *)path generation:(uint64_t)generation {
  uint8_t buffer[4096];
  NSMutableData *pending = [NSMutableData new];
  double lastEmit = MonotonicMs();
  double lastRead = lastEmit;
  double lastPresenceCheck = lastEmit;
  BOOL lost = NO;
  while (_generation == generation) {
    ssize_t n = read(fd, buffer, sizeof buffer);
    double now = MonotonicMs();
    if (n > 0) {
      [pending appendBytes:buffer length:(NSUInteger)n];
      lastRead = now;
    } else if (n < 0 && errno != EINTR && errno != EAGAIN) {
      lost = YES;
      break;
    } else if (now - lastPresenceCheck > 1000) {
      lastPresenceCheck = now;
      if (access(path.fileSystemRepresentation, F_OK) != 0) {
        lost = YES;
        break;
      }
    }
    if (pending.length && now - lastEmit >= kEmitIntervalMs) {
      [self emitData:pending at:lastRead];
      pending = [NSMutableData new];
      lastEmit = now;
    }
  }
  if (_generation != generation) return;
  [self emitData:pending at:lastRead];
  if (lost) {
    dispatch_async(_queue, ^{
      if (self->_generation != generation) return;
      [self closeSerial];
      [self emitState:@"disconnected" detail:[NSString stringWithFormat:@"%@ was disconnected", path] lost:YES];
    });
  }
}

#pragma mark - Bluetooth LE

// Runs `block` on the BLE queue once Bluetooth is powered on, or with an error.
- (void)whenBluetoothReady:(void (^)(NSString *error))block {
  if (!_central) {
    _central = [[CBCentralManager alloc] initWithDelegate:self queue:_bleQueue options:@{CBCentralManagerOptionShowPowerAlertKey : @NO}];
  }
  NSString *error = [self bluetoothError];
  if (_central.state == CBManagerStatePoweredOn || (error && _central.state != CBManagerStateUnknown && _central.state != CBManagerStateResetting)) {
    block(_central.state == CBManagerStatePoweredOn ? nil : error);
    return;
  }
  [_bluetoothWaiters addObject:block];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kBluetoothReadyTimeoutS * NSEC_PER_SEC)), _bleQueue, ^{
    if ([self->_bluetoothWaiters containsObject:block]) {
      [self->_bluetoothWaiters removeObject:block];
      block(@"Bluetooth is not ready");
    }
  });
}

- (NSString *)bluetoothError {
  switch (_central.state) {
    case CBManagerStatePoweredOn:
      return nil;
    case CBManagerStatePoweredOff:
      return @"Bluetooth is turned off";
    case CBManagerStateUnauthorized:
      return @"Bluetooth permission was denied (System Settings › Privacy & Security › Bluetooth)";
    case CBManagerStateUnsupported:
      return @"This Mac does not support Bluetooth LE";
    default:
      return @"Bluetooth is not ready";
  }
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
  if (central.state == CBManagerStateUnknown || central.state == CBManagerStateResetting) return;
  NSArray *waiters = [_bluetoothWaiters copy];
  [_bluetoothWaiters removeAllObjects];
  for (void (^waiter)(NSString *) in waiters) waiter(central.state == CBManagerStatePoweredOn ? nil : [self bluetoothError]);
  if (central.state != CBManagerStatePoweredOn && _bleStreaming) {
    _bleStreaming = NO;
    _peripheral = nil;
    [self emitState:@"disconnected" detail:[self bluetoothError] lost:YES];
  }
}

- (void)centralManager:(CBCentralManager *)central
    didDiscoverPeripheral:(CBPeripheral *)peripheral
        advertisementData:(NSDictionary<NSString *, id> *)advertisementData
                     RSSI:(NSNumber *)RSSI {
  NSString *name = advertisementData[CBAdvertisementDataLocalNameKey] ?: peripheral.name;
  NSArray<CBUUID *> *services = advertisementData[CBAdvertisementDataServiceUUIDsKey];
  BOOL uart = [services containsObject:[CBUUID UUIDWithString:kUartService]];
  if (!name && !uart) return;
  NSString *key = peripheral.identifier.UUIDString;
  _peripherals[key] = peripheral;
  BOOL named = [name rangeOfString:@"medhub" options:NSCaseInsensitiveSearch].location != NSNotFound;
  _scanResults[key] = @{
    @"id" : [@"ble:" stringByAppendingString:key],
    @"name" : name ?: @"Unnamed BLE device",
    @"transport" : @"ble",
    @"detail" : [NSString stringWithFormat:@"%@ dBm%@", RSSI, uart ? @" · UART service" : @""],
    @"likely" : @(uart || named),
  };
}

- (void)connectBle:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  uint64_t generation = _generation;
  dispatch_async(_bleQueue, ^{
    [self whenBluetoothReady:^(NSString *error) {
      if (self->_generation != generation) return reject(@"cancelled", @"Connection cancelled", nil);
      if (error) return reject(@"bluetooth", error, nil);
      CBPeripheral *peripheral = self->_peripherals[identifier];
      if (!peripheral) {
        NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:identifier];
        peripheral = uuid ? [self->_central retrievePeripheralsWithIdentifiers:@[ uuid ]].firstObject : nil;
      }
      if (!peripheral) return reject(@"not_found", @"Bluetooth device not found; scan again", nil);
      self->_userDisconnect = NO;
      self->_bleStreaming = NO;
      self->_bleResolve = resolve;
      self->_bleReject = reject;
      self->_peripheral = peripheral;
      peripheral.delegate = self;
      [self->_central connectPeripheral:peripheral options:nil];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kBleConnectTimeoutS * NSEC_PER_SEC)), self->_bleQueue, ^{
        if (self->_generation == generation && self->_bleReject) {
          [self failBle:@"Timed out connecting over Bluetooth"];
        }
      });
    }];
  });
}

- (void)failBle:(NSString *)message {
  RCTPromiseRejectBlock reject = _bleReject;
  _bleResolve = nil;
  _bleReject = nil;
  if (_peripheral) [_central cancelPeripheralConnection:_peripheral];
  _peripheral = nil;
  if (reject) reject(@"ble_failed", message, nil);
}

- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
  if (peripheral != _peripheral) return;
  [peripheral discoverServices:@[ [CBUUID UUIDWithString:kUartService] ]];
}

- (void)centralManager:(CBCentralManager *)central didFailToConnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
  if (peripheral != _peripheral) return;
  [self failBle:error.localizedDescription ?: @"Could not connect"];
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
  for (CBService *service in peripheral.services) {
    if ([service.UUID isEqual:[CBUUID UUIDWithString:kUartService]]) {
      [peripheral discoverCharacteristics:@[ [CBUUID UUIDWithString:kUartTx] ] forService:service];
      return;
    }
  }
  [self failBle:@"This device does not offer the Medhub UART service"];
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service error:(NSError *)error {
  for (CBCharacteristic *characteristic in service.characteristics) {
    if ([characteristic.UUID isEqual:[CBUUID UUIDWithString:kUartTx]]) {
      [peripheral setNotifyValue:YES forCharacteristic:characteristic];
      return;
    }
  }
  [self failBle:@"The UART service has no TX characteristic"];
}

- (void)peripheral:(CBPeripheral *)peripheral
    didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic
                                          error:(NSError *)error {
  if (error) return [self failBle:error.localizedDescription];
  RCTPromiseResolveBlock resolve = _bleResolve;
  _bleResolve = nil;
  _bleReject = nil;
  _bleStreaming = YES;
  if (resolve) resolve(nil);
  [self emitState:@"connected" detail:[NSString stringWithFormat:@"Connected to %@ over Bluetooth", peripheral.name ?: @"device"] lost:NO];
}

- (void)peripheral:(CBPeripheral *)peripheral didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  if (peripheral == _peripheral && !error) [self emitData:characteristic.value at:MonotonicMs()];
}

- (void)centralManager:(CBCentralManager *)central didDisconnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
  if (peripheral != _peripheral) return;
  if (_bleReject) return [self failBle:error.localizedDescription ?: @"Disconnected while connecting"];
  BOOL lost = !_userDisconnect;
  _bleStreaming = NO;
  _peripheral = nil;
  [self emitState:@"disconnected" detail:[NSString stringWithFormat:@"%@ disconnected", peripheral.name ?: @"Bluetooth device"] lost:lost];
}

#pragma mark - Recordings folder

- (NSURL *)root {
  NSURL *documents = [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
  return [documents URLByAppendingPathComponent:@"Medhub Recordings" isDirectory:YES];
}

RCT_EXPORT_METHOD(recordingsRoot : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSError *error;
  if (![NSFileManager.defaultManager createDirectoryAtURL:self.root withIntermediateDirectories:YES attributes:nil error:&error]) {
    return reject(@"storage", error.localizedDescription, error);
  }
  resolve(self.root.path);
}

RCT_EXPORT_METHOD(createFile : (NSString *)folder fileName : (NSString *)fileName resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSArray<NSString *> *segments = folder.length ? [folder componentsSeparatedByString:@"/"] : @[];
  for (NSString *segment in [segments arrayByAddingObject:fileName]) {
    if (!IsSafeSegment(segment)) return reject(@"storage", [NSString stringWithFormat:@"Invalid file name: %@", segment], nil);
  }
  NSURL *dir = self.root;
  for (NSString *segment in segments) dir = [dir URLByAppendingPathComponent:segment isDirectory:YES];
  NSError *error;
  if (![NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:&error]) {
    return reject(@"storage", error.localizedDescription, error);
  }
  NSString *stem = fileName.stringByDeletingPathExtension;
  NSString *extension = fileName.pathExtension;
  for (int attempt = 1; attempt < 1000; attempt++) {
    NSString *candidate = attempt == 1 ? fileName : [NSString stringWithFormat:@"%@-%d.%@", stem, attempt, extension];
    NSString *path = [dir URLByAppendingPathComponent:candidate].path;
    int fd = open(path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL, 0644);
    if (fd >= 0) {
      NSNumber *fileId = @(_nextFileId++);
      _files[fileId] = [[NSFileHandle alloc] initWithFileDescriptor:fd closeOnDealloc:YES];
      return resolve(@{@"id" : fileId, @"path" : path});
    }
    if (errno != EEXIST) return reject(@"storage", [NSString stringWithFormat:@"Cannot create %@: %s", path, strerror(errno)], nil);
  }
  reject(@"storage", @"No free file name", nil);
}

RCT_EXPORT_METHOD(appendFile : (double)fileId text : (NSString *)text resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSFileHandle *handle = _files[@((NSInteger)fileId)];
  if (!handle) return reject(@"storage", @"File is not open", nil);
  NSError *error;
  if (![handle writeData:[text dataUsingEncoding:NSUTF8StringEncoding] error:&error]) {
    return reject(@"storage", error.localizedDescription, error);
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(closeFile : (double)fileId resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSNumber *key = @((NSInteger)fileId);
  NSFileHandle *handle = _files[key];
  if (!handle) return reject(@"storage", @"File is not open", nil);
  [_files removeObjectForKey:key];
  NSError *error;
  if (![handle closeAndReturnError:&error]) return reject(@"storage", error.localizedDescription, error);
  resolve(nil);
}

RCT_EXPORT_METHOD(listRecordings : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSURL *root = self.root;
  NSMutableArray *files = [NSMutableArray new];
  NSDirectoryEnumerator *enumerator = [NSFileManager.defaultManager enumeratorAtURL:root
                                                         includingPropertiesForKeys:@[ NSURLIsRegularFileKey, NSURLFileSizeKey, NSURLContentModificationDateKey ]
                                                                            options:NSDirectoryEnumerationSkipsHiddenFiles
                                                                       errorHandler:nil];
  NSString *prefix = [root.path stringByAppendingString:@"/"];
  for (NSURL *url in enumerator) {
    NSDictionary *values = [url resourceValuesForKeys:@[ NSURLIsRegularFileKey, NSURLFileSizeKey, NSURLContentModificationDateKey ] error:nil];
    if (![values[NSURLIsRegularFileKey] boolValue] || ![url.pathExtension isEqualToString:@"csv"]) continue;
    NSString *path = url.path;
    if (![path hasPrefix:prefix]) continue;
    [files addObject:@{
      @"path" : [path substringFromIndex:prefix.length],
      @"size" : values[NSURLFileSizeKey] ?: @0,
      @"modified" : @([values[NSURLContentModificationDateKey] timeIntervalSince1970] * 1000),
    }];
  }
  resolve(files);
}

RCT_EXPORT_METHOD(readRecording : (NSString *)path resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  for (NSString *segment in [path componentsSeparatedByString:@"/"]) {
    if (!IsSafeSegment(segment)) return reject(@"storage", @"Invalid recording path", nil);
  }
  NSError *error;
  NSString *text = [NSString stringWithContentsOfURL:[self.root URLByAppendingPathComponent:path] encoding:NSUTF8StringEncoding error:&error];
  if (!text) return reject(@"storage", error.localizedDescription, error);
  resolve(text);
}

RCT_EXPORT_METHOD(revealRecordings : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSURL *root = self.root;
  [NSFileManager.defaultManager createDirectoryAtURL:root withIntermediateDirectories:YES attributes:nil error:nil];
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSWorkspace.sharedWorkspace openURL:root];
    resolve(nil);
  });
}

@end
