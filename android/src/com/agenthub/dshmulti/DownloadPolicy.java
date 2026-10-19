package com.agenthub.dshmulti;

import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** Pure Java policy shared by the WebView bridge and background downloader. */
final class DownloadPolicy {
    static int port(URI u) { return u.getPort() >= 0 ? u.getPort() : "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80; }
    static String original(String origin, String target) throws Exception {
        if (target == null || target.length() > 12000) throw new IllegalArgumentException("下载地址无效");
        URI base = new URI(origin), u = new URI(target);
        if (!("http".equals(u.getScheme()) || "https".equals(u.getScheme())) || u.getUserInfo() != null
                || u.getFragment() != null || u.getHost() == null || base.getHost() == null
                || !u.getScheme().equalsIgnoreCase(base.getScheme()) || !u.getHost().equalsIgnoreCase(base.getHost())
                || port(u) != port(base) || !"/m/api/raw".equals(u.getRawPath())) throw new IllegalArgumentException("只允许下载当前 DSH 的原视频");
        Map<String,String> q = query(u);
        String session = q.get("s"), path = q.get("path");
        if (session == null || session.length() > 200 || !session.matches("[A-Za-z0-9_-]+") || path == null || path.isEmpty()
                || path.length() > 4096 || path.indexOf('\0') >= 0 || path.replace('\\','/').matches("(^|.*/)\\.\\.(/.*|$)")) throw new IllegalArgumentException("视频路径无效");
        if (!path.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|ts|mts|3gp)$")) throw new IllegalArgumentException("这个文件不是支持的视频格式");
        return new URI(u.getScheme(), null, u.getHost(), u.getPort(), "/m/api/raw", null, null).toASCIIString()
                + "?s=" + URLEncoder.encode(session, "UTF-8") + "&path=" + URLEncoder.encode(path, "UTF-8") + "&download=1";
    }
    static Map<String,String> query(URI u) throws Exception {
        Map<String,String> out = new HashMap<>();
        for (String part : (u.getRawQuery() == null ? "" : u.getRawQuery()).split("&")) {
            String[] pair = part.split("=", 2);
            String key = URLDecoder.decode(pair[0], "UTF-8"), value = pair.length > 1 ? URLDecoder.decode(pair[1], "UTF-8") : "";
            if (out.put(key, value) != null) throw new IllegalArgumentException("下载参数重复");
        }
        return out;
    }
    static String filename(String url) throws Exception {
        String path = query(new URI(url)).get("path").replace('\\', '/');
        String name = path.substring(path.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}<>:\"/\\\\|?*]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "DSH视频.mp4";
        int dot = name.lastIndexOf('.'); String extension = dot > 0 ? name.substring(dot) : ".mp4", stem = dot > 0 ? name.substring(0, dot) : name;
        while ((stem + extension).getBytes(StandardCharsets.UTF_8).length > 180 && !stem.isEmpty()) stem = stem.substring(0, stem.offsetByCodePoints(stem.length(), -1));
        return stem + extension;
    }
}
