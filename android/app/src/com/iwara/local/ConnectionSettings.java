package com.iwara.local;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class ConnectionSettings {
    private final SharedPreferences prefs;
    private final Context androidContext;
    public ConnectionSettings(Context context) { androidContext=context.getApplicationContext();prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias("iwara-token")) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder("iwara-token", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey)store.getKey("iwara-token", null);
    }
    public String origin() {
        String saved = prefs.getString("origin", "");
        return saved.isEmpty() ? presets()[0] : saved;
    }
    public String[] presets() {
        return new String[]{personalOrigin("personal_lan_origin"), personalOrigin("personal_tailscale_origin")};
    }
    private String personalOrigin(String resourceName) {
        int id = androidContext.getResources().getIdentifier(resourceName, "string", androidContext.getPackageName());
        return id == 0 ? "" : androidContext.getString(id).trim();
    }
    private String builtInToken(){int id=androidContext.getResources().getIdentifier("personal_sync_token","string",androidContext.getPackageName());return id==0?"":androidContext.getString(id);}
    public String token() throws Exception {
        String encoded = prefs.getString("token", ""); if (encoded.isEmpty()) return builtInToken();
        byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP); int length = bytes[0] & 255;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, java.util.Arrays.copyOfRange(bytes, 1, 1 + length)));
        return new String(cipher.doFinal(bytes, 1 + length, bytes.length - 1 - length), java.nio.charset.StandardCharsets.UTF_8);
    }
    public void save(String link, String enteredToken) throws Exception {
        Uri uri = Uri.parse(link.trim()); String scheme = uri.getScheme(), host = uri.getHost();
        if (host == null || !("http".equals(scheme) || "https".equals(scheme)) || uri.getUserInfo() != null) throw new IllegalArgumentException("请输入 http/https 服务地址或完整播放链接");
        if ("http".equals(scheme) && !privateHost(host)) throw new IllegalArgumentException("明文 HTTP 只允许局域网或 Tailscale 地址；其他地址请使用 HTTPS");
        String token = uri.getQueryParameter("access_token"); if (token == null || token.isEmpty()) token = enteredToken.trim();
        if (token.isEmpty()) throw new IllegalArgumentException("请粘贴带 access_token 的播放链接，或填写令牌");
        if (token.length() > 512) throw new IllegalArgumentException("令牌长度无效");
        String origin = scheme + "://" + (host.contains(":") ? "[" + host + "]" : host) + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV(), value = cipher.doFinal(token.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] encoded = new byte[1 + iv.length + value.length]; encoded[0] = (byte)iv.length; System.arraycopy(iv, 0, encoded, 1, iv.length); System.arraycopy(value, 0, encoded, 1 + iv.length, value.length);
        prefs.edit().putString("origin", origin).putString("token", Base64.encodeToString(encoded, Base64.NO_WRAP)).apply();
    }
    private boolean privateHost(String host) {
        if ("localhost".equals(host) || "::1".equals(host) || (host.contains(":") && (host.startsWith("fd") || host.startsWith("fc") || host.startsWith("fe80:")))) return true;
        String[] parts = host.split("\\."); if (parts.length != 4) return false;
        try { int a = Integer.parseInt(parts[0]), b = Integer.parseInt(parts[1]); for (String part : parts) { int n = Integer.parseInt(part); if (n < 0 || n > 255) return false; }
            return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31) || (a == 100 && b >= 64 && b <= 127);
        } catch (NumberFormatException error) { return false; }
    }
}
