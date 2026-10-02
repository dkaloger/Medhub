package com.medhub.link

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
import java.util.UUID

/**
 * Bluetooth LE client for boards running the Medhub BLE firmware: the Nordic UART Service,
 * with sample lines notified on the TX characteristic (see docs/ble-protocol.md).
 */
@SuppressLint("MissingPermission") // status() checks permissions before anything here runs
class BleLink(
    private val context: Context,
    private val onData: (ByteArray, Double) -> Unit,
    private val onState: (String, String, Boolean) -> Unit,
) {
  companion object {
    private val UART_SERVICE: UUID = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    private val UART_TX: UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
    private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private const val CONNECT_TIMEOUT_MS = 10_000L
    private const val MTU = 247
  }

  private val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?)?.adapter
  private val main = Handler(Looper.getMainLooper())
  private var gatt: BluetoothGatt? = null
  private var pending: Promise? = null
  private var userDisconnect = false
  private val connectTimeout = Any()

  private fun permitted(): Boolean {
    val needed =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
          listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
    return needed.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
  }

  /** Empty when usable, otherwise the reason. */
  fun status(): String =
      when {
        adapter == null -> "This device has no Bluetooth"
        !permitted() -> "Bluetooth permission was denied"
        !adapter.isEnabled -> "Bluetooth is turned off"
        else -> ""
      }

  fun scan(seconds: Double, done: (List<WritableMap>) -> Unit) {
    val scanner = adapter?.bluetoothLeScanner
    if (scanner == null) {
      done(emptyList())
      return
    }
    val found = LinkedHashMap<String, WritableMap>()
    val callback =
        object : ScanCallback() {
          override fun onScanResult(callbackType: Int, result: ScanResult) {
            val record = result.scanRecord
            val name = record?.deviceName ?: result.device.name
            val uart = record?.serviceUuids?.contains(ParcelUuid(UART_SERVICE)) == true
            if (name == null && !uart) return
            found[result.device.address] =
                Arguments.createMap().apply {
                  putString("id", "ble:${result.device.address}")
                  putString("name", name ?: "Unnamed BLE device")
                  putString("transport", "ble")
                  putString("detail", "${result.rssi} dBm${if (uart) " · UART service" else ""}")
                  putBoolean("likely", uart || name?.contains("medhub", ignoreCase = true) == true)
                }
          }
        }
    scanner.startScan(callback)
    main.postDelayed(
        {
          runCatching { scanner.stopScan(callback) }
          done(found.values.toList())
        },
        (seconds * 1000).toLong())
  }

  fun connect(address: String, promise: Promise) {
    val problem = status()
    if (problem.isNotEmpty()) {
      promise.reject("bluetooth", problem)
      return
    }
    val device: BluetoothDevice =
        try {
          adapter!!.getRemoteDevice(address)
        } catch (e: IllegalArgumentException) {
          promise.reject("not_found", "Invalid Bluetooth address $address")
          return
        }
    userDisconnect = false
    pending = promise
    gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
    main.postAtTime(
        { fail("Timed out connecting over Bluetooth") }, connectTimeout, SystemClock.uptimeMillis() + CONNECT_TIMEOUT_MS)
  }

  fun close() {
    userDisconnect = true
    main.removeCallbacksAndMessages(connectTimeout)
    pending?.reject("cancelled", "Connection cancelled")
    pending = null
    gatt?.disconnect()
    gatt?.close()
    gatt = null
  }

  private fun fail(message: String) {
    val promise = pending ?: return
    pending = null
    gatt?.close()
    gatt = null
    promise.reject("ble_failed", message)
  }

  private val callback =
      object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
          if (g != gatt) return
          if (newState == BluetoothProfile.STATE_CONNECTED) {
            if (!g.requestMtu(MTU)) g.discoverServices()
          } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            if (pending != null) {
              main.post { fail("Disconnected while connecting (status $status)") }
              return
            }
            val lost = !userDisconnect
            g.close()
            gatt = null
            onState("disconnected", "${g.device.name ?: "Bluetooth device"} disconnected", lost)
          }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
          g.discoverServices()
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
          val tx = g.getService(UART_SERVICE)?.getCharacteristic(UART_TX)
          val cccd = tx?.getDescriptor(CCCD)
          if (tx == null || cccd == null) {
            main.post { fail("This device does not offer the Medhub UART service") }
            return
          }
          g.setCharacteristicNotification(tx, true)
          val enable = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeDescriptor(cccd, enable)
          } else {
            @Suppress("DEPRECATION")
            cccd.value = enable
            @Suppress("DEPRECATION")
            g.writeDescriptor(cccd)
          }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
          main.post {
            if (status != BluetoothGatt.GATT_SUCCESS) {
              fail("Could not enable notifications (status $status)")
              return@post
            }
            g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
            main.removeCallbacksAndMessages(connectTimeout)
            pending?.resolve(null)
            pending = null
            onState("connected", "Connected to ${g.device.name ?: "device"} over Bluetooth", false)
          }
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
          if (characteristic.uuid == UART_TX) onData(value, MedhubNativeModule.nowMs())
        }

        @Deprecated("Used before Android 13")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
          @Suppress("DEPRECATION")
          if (characteristic.uuid == UART_TX) onData(characteristic.value ?: return, MedhubNativeModule.nowMs())
        }
      }
}
