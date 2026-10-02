package com.medhub.link

import android.os.SystemClock
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.Executors

/**
 * Android implementation of the MedhubNative module (see src/native/NativeMedhub.ts):
 * USB serial via usb-serial-for-android, Bluetooth LE via the platform GATT API, and the
 * recordings folder in the app's external files directory.
 */
class MedhubNativeModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

  companion object {
    const val NAME = "MedhubNative"
    private const val DATA_EVENT = "MedhubData"
    private const val STATE_EVENT = "MedhubState"

    /** Native monotonic clock in milliseconds, used to stamp incoming bytes. */
    fun nowMs(): Double = SystemClock.elapsedRealtimeNanos() / 1e6
  }

  private val usb = UsbLink(context, ::emitData, ::emitState)
  private val ble = BleLink(context, ::emitData, ::emitState)
  private val folder = RecordingsFolder(context)
  private val storageThread = Executors.newSingleThreadExecutor()

  override fun getName() = NAME

  private fun emitData(bytes: ByteArray, t: Double) {
    if (bytes.isEmpty()) return
    val event = Arguments.createMap()
    event.putString("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
    event.putDouble("t", t)
    context.emitDeviceEvent(DATA_EVENT, event)
  }

  private fun emitState(state: String, detail: String, lost: Boolean) {
    val event = Arguments.createMap()
    event.putString("state", state)
    event.putString("detail", detail)
    event.putBoolean("lost", lost)
    context.emitDeviceEvent(STATE_EVENT, event)
  }

  @ReactMethod
  fun listDevices(scanSeconds: Double, promise: Promise) {
    val devices = Arguments.createArray()
    usb.list().forEach { devices.pushMap(it) }
    if (scanSeconds <= 0 || ble.status().isNotEmpty()) {
      promise.resolve(devices)
      return
    }
    ble.scan(scanSeconds) { found: List<WritableMap> ->
      found.forEach { devices.pushMap(it) }
      promise.resolve(devices)
    }
  }

  @ReactMethod
  fun bluetoothStatus(promise: Promise) = promise.resolve(ble.status())

  @ReactMethod
  fun connect(id: String, promise: Promise) {
    usb.close()
    ble.close()
    when {
      id.startsWith("usb:") -> usb.connect(id.removePrefix("usb:"), promise)
      id.startsWith("ble:") -> ble.connect(id.removePrefix("ble:"), promise)
      else -> promise.reject("bad_id", "Unknown device id $id")
    }
  }

  @ReactMethod
  fun disconnect(promise: Promise) {
    usb.close()
    ble.close()
    promise.resolve(null)
  }

  private fun storage(promise: Promise, block: () -> Any?) {
    storageThread.execute {
      try {
        promise.resolve(block())
      } catch (e: Exception) {
        promise.reject("storage", e.message ?: e.toString(), e)
      }
    }
  }

  @ReactMethod fun recordingsRoot(promise: Promise) = storage(promise) { folder.root().absolutePath }

  @ReactMethod
  fun createFile(folderPath: String, fileName: String, promise: Promise) =
      storage(promise) {
        val (id, path) = folder.create(folderPath, fileName)
        Arguments.createMap().apply {
          putInt("id", id)
          putString("path", path)
        }
      }

  @ReactMethod
  fun appendFile(id: Double, text: String, promise: Promise) =
      storage(promise) {
        folder.append(id.toInt(), text)
        null
      }

  @ReactMethod
  fun closeFile(id: Double, promise: Promise) =
      storage(promise) {
        folder.close(id.toInt())
        null
      }

  @ReactMethod
  fun listRecordings(promise: Promise) =
      storage(promise) {
        Arguments.createArray().apply {
          folder.list().forEach { file ->
            pushMap(
                Arguments.createMap().apply {
                  putString("path", file.path)
                  putDouble("size", file.size.toDouble())
                  putDouble("modified", file.modified.toDouble())
                })
          }
        }
      }

  @ReactMethod fun readRecording(path: String, promise: Promise) = storage(promise) { folder.read(path) }

  /** There is no file browser to open on Android; recordings are reachable over USB. */
  @ReactMethod fun revealRecordings(promise: Promise) = promise.resolve(null)

  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) = Unit

  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) = Unit

  override fun invalidate() {
    usb.close()
    ble.close()
    storageThread.execute { folder.closeAll() }
    storageThread.shutdown()
    super.invalidate()
  }
}
