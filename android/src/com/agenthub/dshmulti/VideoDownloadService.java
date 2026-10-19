package com.agenthub.dshmulti;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.*;
import android.provider.MediaStore;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;

/** Foreground, same-origin downloads; redirects are never followed with gateway cookies. */
public final class VideoDownloadService extends Service {
    private static final String CHANNEL = "video-downloads";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Set<String> active = new HashSet<>();
    private int jobs;
    private int lastStartId;
    private NotificationManager notifications;
    private android.content.SharedPreferences journal;
    @Override public android.os.IBinder onBind(Intent intent) { return null; }
    @Override public void onCreate() {
        super.onCreate(); notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL, "视频下载", NotificationManager.IMPORTANCE_LOW));
        journal = getSharedPreferences("video-downloads", MODE_PRIVATE);
        // Only URIs inserted by this downloader are journaled, never scan user files.
        for (Map.Entry<String,?> e : journal.getAll().entrySet()) if (e.getKey().startsWith("pending:")) {
            try (android.database.Cursor row = getContentResolver().query(Uri.parse((String)e.getValue()), new String[]{MediaStore.Downloads.IS_PENDING}, null, null, null)) {
                if (row != null && row.moveToFirst() && row.getInt(0) == 1) {
                    getContentResolver().delete(Uri.parse((String)e.getValue()), null, null);
                    notifications.notify(7401,notice("上次视频下载已中断","未完成文件已清理，请回 DSH 重新下载").setAutoCancel(true).build());
                }
            } catch (Exception ignored) {}
            journal.edit().remove(e.getKey()).apply();
        }
    }
    private Notification.Builder notice(String title, String detail) {
        return new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title).setContentText(detail).setOnlyAlertOnce(true);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        startForeground(7400, notice("DSH 视频下载", "正在准备下载到 Download/DSH").setOngoing(true).build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        if (intent == null) { if (jobs == 0) stopSelf(); return START_NOT_STICKY; }
        final String id = intent.getStringExtra("requestId"), origin = intent.getStringExtra("origin");
        final String url;
        try { url = DownloadPolicy.original(origin, intent.getStringExtra("url")); }
        catch (Exception e) { MainActivity.downloadResult(id, "error", e.getMessage()); if (jobs == 0) stopSelf(); return START_NOT_STICKY; }
        synchronized (active) {
            if (!active.add(url)) { MainActivity.downloadResult(id,"error","这个原视频已经在下载中，请查看下载通知，不必重复下载"); return START_NOT_STICKY; }
            jobs++;
        }
        String cookie = intent.getStringExtra("cookie"), agent = intent.getStringExtra("agent");
        MainActivity.downloadResult(id,"queued","正在下载原视频，完成后保存到 Download/DSH");
        worker.execute(() -> download(url, cookie, agent, id));
        return START_NOT_STICKY;
    }
    private void download(String url, String cookie, String agent, String id) {
        HttpURLConnection connection = null; Uri output = null; String name = "视频";
        int notificationId = 7500 + (id.hashCode() & 0x3fffffff);
        try {
            name = DownloadPolicy.filename(url);
            connection = (HttpURLConnection)new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(20000); connection.setReadTimeout(60000);
            if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
            if (agent != null) connection.setRequestProperty("User-Agent", agent);
            connection.setRequestProperty("Accept-Encoding", "identity");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new IOException("登录状态已变化或下载发生跳转，请回 DSH 重新登录后重试");
            if (status != 200) throw new IOException("视频下载失败（HTTP " + status + "）");
            String mime = connection.getContentType(); mime = mime == null ? "" : mime.split(";")[0].trim();
            if (!mime.startsWith("video/") && !"application/octet-stream".equals(mime)) throw new IOException("服务器没有返回视频，请检查登录状态");
            long expected = connection.getContentLengthLong(), count = 0, last = 0;
            ContentValues values = new ContentValues(); values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime); values.put(MediaStore.Downloads.RELATIVE_PATH,"Download/DSH"); values.put(MediaStore.Downloads.IS_PENDING,1);
            output = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (output == null) throw new IOException("无法创建下载文件，请检查存储空间");
            journal.edit().putString("pending:"+id,output.toString()).commit();
            try (InputStream in = connection.getInputStream(); OutputStream out = getContentResolver().openOutputStream(output, "w")) {
                if (out == null) throw new IOException("无法写入下载文件");
                byte[] buffer = new byte[65536]; int n;
                while ((n = in.read(buffer)) != -1) {
                    out.write(buffer,0,n); count += n;
                    if (System.currentTimeMillis()-last > 1000) {
                        last = System.currentTimeMillis();
                        int percent = expected > 0 ? (int)Math.min(99,count*100/expected) : 0;
                        notifications.notify(7400,notice(name,"正在下载 · "+count/1024/1024+" MB").setOngoing(true).setProgress(100,percent,expected<=0).build());
                    }
                }
                out.flush();
            }
            if (count == 0 || (expected >= 0 && count != expected)) throw new IOException("视频未完整下载，请重试");
            values.clear(); values.put(MediaStore.Downloads.IS_PENDING,0);
            if (getContentResolver().update(output,values,null,null) != 1) throw new IOException("无法完成视频保存");
            journal.edit().remove("pending:"+id).commit();
            Uri completed = output; output = null;
            Intent open = new Intent(Intent.ACTION_VIEW).setDataAndType(completed,mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(this,notificationId,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            notifications.notify(notificationId,notice("视频已下载",name+" · Download/DSH").setSmallIcon(android.R.drawable.stat_sys_download_done).setContentIntent(pi).setAutoCancel(true).build());
            MainActivity.downloadResult(id,"complete","已保存到 Download/DSH："+name);
        } catch (Exception e) {
            if (output != null) try { getContentResolver().delete(output,null,null); } catch (Exception ignored) {}
            journal.edit().remove("pending:"+id).apply();
            String message = e instanceof IOException ? e.getMessage() : "保存失败，请检查网络和手机存储空间";
            notifications.notify(notificationId,notice("视频下载失败",message).setAutoCancel(true).build());
            MainActivity.downloadResult(id,"error",message);
        } finally {
            if (connection != null) connection.disconnect();
            synchronized(active) { active.remove(url); jobs--; }
            new Handler(Looper.getMainLooper()).post(() -> {
                synchronized(active) { if(jobs==0 && stopSelfResult(lastStartId)) stopForeground(STOP_FOREGROUND_REMOVE); }
            });
        }
    }
    @Override public void onDestroy() { worker.shutdown(); super.onDestroy(); }
}
