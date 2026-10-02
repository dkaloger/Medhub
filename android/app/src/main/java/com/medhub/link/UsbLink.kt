package com.medhub.link

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import java.io.ByteArrayOutputStream

/** USB-OTG serial link to the ESP32's USB-UART bridge (CP210x, CH34x, FTDI, CDC). */
class UsbLink(
    private val context: Context,
    private val onData: (ByteArray, Double) -> Unit,
    private val onState: (String, String, Boolean) -> Unit,
) {
  companion object {
    private const val BAUD_RATE = 115200
    private const val EMIT_INTERVAL_MS = 20.0
    private const val PERMISSION_ACTION = "com.medhub.USB_PERMISSION"
    private val KNOWN_BRIDGES =
        setOf(0x10C4 to 0xEA60, 0x1A86 to 0x7523, 0x1A86 to 0x55D4, 0x0403 to 0x6001, 0x303A to 0x1001)
  }

  private val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
  private var port: UsbSerialPort? = null
  private var ioManager: SerialInputOutputManager? = null
  @Volatile private var generation = 0

  /** Stable across replugging, unlike the /dev/bus/usb path. */
  private fun key(device: UsbDevice) = "%04x:%04x".format(device.vendorId, device.productId)

  private fun drivers(): List<UsbSerialDriver> = UsbSerialProber.getDefaultProber().findAllDrivers(manager)

  fun list(): List<WritableMap> =
      drivers().map { driver ->
        val device = driver.device
        Arguments.createMap().apply {
          putString("id", "usb:${key(device)}")
          putString("name", device.productName ?: driver.javaClass.simpleName.removeSuffix("SerialDriver"))
          putString("transport", "usb")
          putString("detail", "%04X:%04X · %s".format(device.vendorId, device.productId, device.deviceName))
          putBoolean("likely", (device.vendorId to device.productId) in KNOWN_BRIDGES)
        }
      }

  fun connect(key: String, promise: Promise) {
    val driver = drivers().firstOrNull { key(it.device) == key }
    if (driver == null) {
      promise.reject("not_found", "USB device $key is not connected")
      return
    }
    if (manager.hasPermission(driver.device)) {
      open(driver, promise)
      return
    }
    val receiver =
        object : BroadcastReceiver() {
          override fun onReceive(context: Context, intent: Intent) {
            context.unregisterReceiver(this)
            if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
              open(driver, promise)
            } else {
              promise.reject("permission", "USB permission was denied")
            }
          }
        }
    ContextCompat.registerReceiver(
        context, receiver, IntentFilter(PERMISSION_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    val intent = Intent(PERMISSION_ACTION).setPackage(context.packageName)
    manager.requestPermission(driver.device, PendingIntent.getBroadcast(context, 0, intent, flags))
  }

  private fun open(driver: UsbSerialDriver, promise: Promise) {
    val connection = manager.openDevice(driver.device)
    if (connection == null) {
      promise.reject("open_failed", "Could not open the USB device")
      return
    }
    val serial = driver.ports[0]
    try {
      serial.open(connection)
      serial.setParameters(BAUD_RATE, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
    } catch (e: Exception) {
      runCatching { serial.close() }
      promise.reject("open_failed", "Could not configure the USB serial port: ${e.message}", e)
      return
    }

    val current = ++generation
    val pending = ByteArrayOutputStream()
    var lastEmit = MedhubNativeModule.nowMs()
    val listener =
        object : SerialInputOutputManager.Listener {
          override fun onNewData(data: ByteArray) {
            if (current != generation) return
            val now = MedhubNativeModule.nowMs()
            pending.write(data)
            if (now - lastEmit >= EMIT_INTERVAL_MS) {
              onData(pending.toByteArray(), now)
              pending.reset()
              lastEmit = now
            }
          }

          override fun onRunError(e: Exception) {
            if (current != generation) return
            close()
            onState("disconnected", "USB device disconnected (${e.message ?: "read error"})", true)
          }
        }
    port = serial
    ioManager = SerialInputOutputManager(serial, listener).also { it.start() }
    promise.resolve(null)
    onState("connected", "Connected to ${driver.device.productName ?: "USB serial"}", false)
  }

  fun close() {
    generation++
    ioManager?.stop()
    ioManager = null
    runCatching { port?.close() }
    port = null
  }
}
