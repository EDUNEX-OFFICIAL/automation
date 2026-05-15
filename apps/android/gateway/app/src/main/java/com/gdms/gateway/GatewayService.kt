package com.gdms.gateway

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import io.socket.client.IO
import io.socket.client.Socket
import java.net.URI
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Phase 2–3: Socket.IO (deviceId + socketToken), CALL_TASK → SIM dial, PhoneStateListener →
 * POST /v1/android/call-status → dashboard CALL_STATUS_UPDATE.
 */
class GatewayService : Service() {
  private val scope = CoroutineScope(Dispatchers.IO)
  private var hb: Job? = null
  private var socket: Socket? = null
  private var phoneListen: PhoneStateListener? = null

  private var apiBase = ""
  private var deviceIdStr = ""
  private var socketTok = ""
  private var activeAiCallId: String? = null
  private var offhookAtMs: Long = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val api = intent?.getStringExtra("apiBase")?.trim().orEmpty()
    val deviceId = intent?.getStringExtra("deviceId")?.trim().orEmpty()
    val socketToken = intent?.getStringExtra("socketToken")?.trim().orEmpty()
    if (api.isEmpty() || deviceId.isEmpty() || socketToken.isEmpty()) {
      Log.e(TAG, "missing api/deviceId/socketToken")
      stopSelf()
      return START_NOT_STICKY
    }
    apiBase = api
    deviceIdStr = deviceId
    socketTok = socketToken

    startForeground(1, buildNotif())
    registerCallStateListener()
    connectSocket()
    hb?.cancel()
    hb = scope.launch {
      while (isActive) {
        try {
          heartbeat(apiBase, deviceIdStr)
        } catch (_: Exception) {}
        delay(30_000)
      }
    }
    return START_STICKY
  }

  @Suppress("DEPRECATION")
  private fun registerCallStateListener() {
    unregisterCallStateListener()
    val tm = getSystemService(TELEPHONY_SERVICE) as TelephonyManager
    phoneListen =
        object : PhoneStateListener() {
          override fun onCallStateChanged(state: Int, incomingNumber: String?) {
            val id = activeAiCallId ?: return
            when (state) {
              TelephonyManager.CALL_STATE_RINGING ->
                  postCallStatus(id, "RINGING", null, null)
              TelephonyManager.CALL_STATE_OFFHOOK -> {
                offhookAtMs = SystemClock.elapsedRealtime()
                postCallStatus(id, "CONNECTED", null, null)
              }
              TelephonyManager.CALL_STATE_IDLE -> {
                val durSec =
                    if (offhookAtMs > 0L) {
                      ((SystemClock.elapsedRealtime() - offhookAtMs) / 1000L).toInt().coerceAtLeast(0)
                    } else null
                offhookAtMs = 0L
                postCallStatus(id, "ENDED", durSec, null)
                activeAiCallId = null
              }
            }
          }
        }
    tm.listen(phoneListen, PhoneStateListener.LISTEN_CALL_STATE)
  }

  @Suppress("DEPRECATION")
  private fun unregisterCallStateListener() {
    phoneListen?.let {
      val tm = getSystemService(TELEPHONY_SERVICE) as TelephonyManager
      tm.listen(it, PhoneStateListener.LISTEN_NONE)
    }
    phoneListen = null
  }

  private fun connectSocket() {
    try {
      socket?.disconnect()
      val uri = URI.create(apiBase.trimEnd('/'))
      val opts = IO.Options()
      val auth = JSONObject()
      auth.put("deviceId", deviceIdStr)
      auth.put("socketToken", socketTok)
      opts.auth = auth
      opts.reconnection = true
      val s = IO.socket(uri, opts)
      socket = s
      s.on(Socket.EVENT_CONNECT) { Log.i(TAG, "socket.io connected") }
      s.on(Socket.EVENT_DISCONNECT) { Log.i(TAG, "socket.io disconnect") }
      s.on("CALL_TASK") { args ->
        if (args.isNotEmpty()) {
          try {
            val raw = args[0]
            val o =
                when (raw) {
                  is JSONObject -> raw
                  else -> JSONObject(raw.toString())
                }
            val num = o.optString("number", "")
            val aiCall =
                o.optString("aiCallId", "").ifEmpty { o.optString("taskId", "") }
            if (aiCall.isEmpty()) {
              Log.w(TAG, "CALL_TASK missing aiCallId/taskId")
              return@on
            }
            activeAiCallId = aiCall
            offhookAtMs = 0L
            postCallStatus(aiCall, "DIALING", null, null)
            if (num.isNotEmpty()) dial(num)
            else Log.w(TAG, "CALL_TASK missing number")
          } catch (e: Exception) {
            Log.e(TAG, "CALL_TASK parse", e)
          }
        }
      }
      s.connect()
    } catch (e: Exception) {
      Log.e(TAG, "connectSocket", e)
    }
  }

  override fun onDestroy() {
    unregisterCallStateListener()
    socket?.disconnect()
    socket = null
    super.onDestroy()
  }

  private fun postCallStatus(
      aiCallId: String,
      phase: String,
      durationSec: Int?,
      error: String?,
  ) {
    scope.launch {
      try {
        val client = OkHttpClient()
        val jo =
            JSONObject()
                .put("deviceId", deviceIdStr)
                .put("socketToken", socketTok)
                .put("aiCallId", aiCallId)
                .put("phase", phase)
        durationSec?.let { jo.put("durationSec", it) }
        error?.let { jo.put("error", it) }
        val body = jo.toString().toRequestBody("application/json".toMediaType())
        val req =
            Request.Builder().url("$apiBase/v1/android/call-status").post(body).build()
        client.newCall(req).execute().close()
      } catch (e: Exception) {
        Log.e(TAG, "postCallStatus $phase", e)
      }
    }
  }

  private fun heartbeat(api: String, deviceId: String) {
    val client = OkHttpClient()
    val json = JSONObject().put("deviceId", deviceId).toString()
    val body = json.toRequestBody("application/json".toMediaType())
    val req = Request.Builder().url("$api/v1/android/heartbeat-mvp").post(body).build()
    client.newCall(req).execute().close()
  }

  private fun dial(number: String) {
    try {
      val call = Intent(Intent.ACTION_CALL, Uri.parse("tel:${Uri.encode(number)}"))
      call.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      startActivity(call)
    } catch (e: Exception) {
      Log.e(TAG, "dial failed", e)
      val id = activeAiCallId ?: return
      postCallStatus(id, "FAILED", null, e.message)
      activeAiCallId = null
      offhookAtMs = 0L
    }
  }

  private fun buildNotif(): Notification {
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(
          NotificationChannel("gdms", "GDMS Gateway", NotificationManager.IMPORTANCE_LOW),
      )
    }
    return NotificationCompat.Builder(this, "gdms")
        .setContentTitle("GDMS Gateway")
        .setContentText("Socket.IO — waiting for CALL_TASK")
        .setSmallIcon(android.R.drawable.stat_sys_phone_call)
        .build()
  }

  companion object {
    private const val TAG = "GdmsGateway"
  }
}
