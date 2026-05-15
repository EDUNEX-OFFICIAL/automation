package com.gdms.gateway

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Phase 5: device-bound secrets in EncryptedSharedPreferences (not plain SharedPreferences). */
object GatewayCredentials {
  private const val FILE = "gdms_gateway_creds"
  private const val K_API = "api_base"
  private const val K_DEVICE = "device_id"
  private const val K_TOKEN = "socket_token"

  private fun prefs(ctx: Context) =
      EncryptedSharedPreferences.create(
          ctx,
          FILE,
          MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
          EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
      )

  fun save(ctx: Context, apiBase: String, deviceId: String, socketToken: String) {
    prefs(ctx)
        .edit()
        .putString(K_API, apiBase)
        .putString(K_DEVICE, deviceId)
        .putString(K_TOKEN, socketToken)
        .apply()
  }

  /** Returns stored triple if all fields present. */
  fun load(ctx: Context): Triple<String, String, String>? {
    val p = prefs(ctx)
    val api = p.getString(K_API, "").orEmpty()
    val dev = p.getString(K_DEVICE, "").orEmpty()
    val tok = p.getString(K_TOKEN, "").orEmpty()
    if (api.isEmpty() || dev.isEmpty() || tok.isEmpty()) return null
    return Triple(api, dev, tok)
  }

  fun clear(ctx: Context) {
    prefs(ctx).edit().clear().apply()
  }
}
