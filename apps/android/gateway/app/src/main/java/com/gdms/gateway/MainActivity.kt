package com.gdms.gateway

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
  private val exec = Executors.newSingleThreadExecutor()

  private fun startGatewayService(apiBase: String, deviceId: String, socketToken: String) {
    val i = Intent(this, GatewayService::class.java)
    i.putExtra("apiBase", apiBase)
    i.putExtra("deviceId", deviceId)
    i.putExtra("socketToken", socketToken)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(i)
    } else {
      startService(i)
    }
  }

  private fun startSavedGateway() {
    ensurePhonePermissions()
    val saved = GatewayCredentials.load(this)
    if (saved == null) {
      Toast.makeText(this, "No saved credentials — pair first", Toast.LENGTH_LONG).show()
      return
    }
    val (apiBase, devId, tok) = saved
    startGatewayService(apiBase, devId, tok)
    Toast.makeText(this, "Gateway starting (saved)", Toast.LENGTH_SHORT).show()
  }

  /** Phase 6: biometric before reading encrypted saved token into the foreground service. */
  private fun authenticateForSavedGateway() {
    val bm = BiometricManager.from(this)
    val allowed = BiometricManager.Authenticators.BIOMETRIC_WEAK
    if (bm.canAuthenticate(allowed) == BiometricManager.BIOMETRIC_SUCCESS) {
      val executor = ContextCompat.getMainExecutor(this)
      val prompt =
          BiometricPrompt(
              this,
              executor,
              object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(
                    result: BiometricPrompt.AuthenticationResult
                ) {
                  startSavedGateway()
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                  if (errorCode != BiometricPrompt.ERROR_USER_CANCELED &&
                      errorCode != BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                    Toast.makeText(this@MainActivity, errString, Toast.LENGTH_SHORT).show()
                  }
                }
              },
          )
      val info =
          BiometricPrompt.PromptInfo.Builder()
              .setTitle("Unlock gateway")
              .setSubtitle("Confirm to use saved credentials")
              .setNegativeButtonText("Cancel")
              .setAllowedAuthenticators(allowed)
              .build()
      prompt.authenticate(info)
    } else {
      Toast.makeText(this, "No biometrics — starting without unlock", Toast.LENGTH_SHORT).show()
      startSavedGateway()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    val api = EditText(this).apply { hint = "API base http://10.0.2.2:4000" }
    val deviceId = EditText(this).apply { hint = "Device ID (unique)" }
    val code = EditText(this).apply { hint = "Pairing code" }
    val start = Button(this).apply { text = "Pair & start gateway" }
    val startSaved = Button(this).apply { text = "Start gateway (saved token)" }
    val clearSaved = Button(this).apply { text = "Clear saved credentials" }

    GatewayCredentials.load(this)?.let { (a, d, _) ->
      api.setText(a)
      deviceId.setText(d)
    }

    layout.addView(api, LP())
    layout.addView(deviceId, LP())
    layout.addView(code, LP())
    layout.addView(start, LP())
    layout.addView(startSaved, LP())
    layout.addView(clearSaved, LP())

    val scroll = ScrollView(this)
    scroll.addView(layout)
    setContentView(scroll)

    clearSaved.setOnClickListener {
      GatewayCredentials.clear(this)
      api.text.clear()
      deviceId.text.clear()
      code.text.clear()
      Toast.makeText(this, "Saved credentials cleared", Toast.LENGTH_SHORT).show()
    }

    startSaved.setOnClickListener { authenticateForSavedGateway() }

    start.setOnClickListener {
      ensurePhonePermissions()
      val apiBase = api.text.toString().trim()
      val devId = deviceId.text.toString().trim()
      val pairCode = code.text.toString().trim()
      if (apiBase.isEmpty() || devId.isEmpty() || pairCode.isEmpty()) {
        Toast.makeText(this, "Fill in all fields", Toast.LENGTH_SHORT).show()
        return@setOnClickListener
      }
      exec.execute {
        try {
          val client = OkHttpClient()
          val json = JSONObject().put("pairingCode", pairCode).put("deviceId", devId).toString()
          val body = json.toRequestBody("application/json".toMediaType())
          val req = Request.Builder().url("$apiBase/v1/android/claim").post(body).build()
          client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            runOnUiThread {
              if (!resp.isSuccessful) {
                Toast.makeText(this, "Claim failed: ${resp.code}", Toast.LENGTH_LONG).show()
                return@runOnUiThread
              }
              val jo = JSONObject(text)
              val socketToken = jo.optString("socketToken", "")
              if (socketToken.isEmpty()) {
                Toast.makeText(this, "No socketToken in response", Toast.LENGTH_LONG).show()
                return@runOnUiThread
              }
              GatewayCredentials.save(this, apiBase, devId, socketToken)
              startGatewayService(apiBase, devId, socketToken)
              Toast.makeText(this, "Gateway connected — saved encrypted", Toast.LENGTH_SHORT).show()
            }
          }
        } catch (e: Exception) {
          runOnUiThread {
            Toast.makeText(this, "Error: ${e.message}", Toast.LENGTH_LONG).show()
          }
        }
      }
    }
  }

  private fun LP() =
      LinearLayout.LayoutParams(
              LinearLayout.LayoutParams.MATCH_PARENT,
              LinearLayout.LayoutParams.WRAP_CONTENT,
          )
          .apply {
            val m = (8 * resources.displayMetrics.density).toInt()
            setMargins(m, m, m, m)
          }

  private fun ensurePhonePermissions() {
    val need = mutableListOf<String>()
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) !=
        PackageManager.PERMISSION_GRANTED) {
      need.add(Manifest.permission.CALL_PHONE)
    }
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) !=
        PackageManager.PERMISSION_GRANTED) {
      need.add(Manifest.permission.READ_PHONE_STATE)
    }
    if (need.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, need.toTypedArray(), 1)
    }
  }
}
