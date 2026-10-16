package com.agenthub.dsh;
public final class DownloadPolicyTest {
    static int checks;
    static void check(boolean value) { checks++; if(!value)throw new AssertionError("check "+checks); }
    static void rejects(String url) throws Exception { try { DownloadPolicy.original("https://dsh.test",url); throw new AssertionError("accepted "+url); } catch(IllegalArgumentException expected) { checks++; } }
    public static void main(String[] args) throws Exception {
        String base="https://dsh.test/m/api/raw?s=session-abc&path=";
        String url=DownloadPolicy.original("https://dsh.test",base+"folder%2F%E6%88%91%E7%9A%84%E8%A7%86%E9%A2%91.mp4&quality=preview");
        check(!url.contains("preview"));check(url.endsWith("&download=1"));check(DownloadPolicy.filename(url).equals("我的视频.mp4"));
        rejects("https://evil.test/m/api/raw?s=x&path=a.mp4");rejects("https://user@dsh.test/m/api/raw?s=x&path=a.mp4");
        rejects("http://dsh.test/m/api/raw?s=x&path=a.mp4");rejects("https://dsh.test:8443/m/api/raw?s=x&path=a.mp4");
        rejects("https://dsh.test/m/api/raw/../other?s=x&path=a.mp4");rejects(base+"..%2Fa.mp4");rejects(base+"a.mp4&path=b.mp4");rejects(base+"a.exe");rejects(base+"a.mp4#bad");
        String longName="中文视频".repeat(100)+".mp4";String cleaned=DownloadPolicy.filename(DownloadPolicy.original("https://dsh.test",base+java.net.URLEncoder.encode(longName,"UTF-8")));
        check(cleaned.getBytes(java.nio.charset.StandardCharsets.UTF_8).length<=180);check(cleaned.endsWith(".mp4"));
        check(DownloadPolicy.filename(DownloadPolicy.original("https://dsh.test",base+"a%3Ab%3Fc.mp4")).equals("a_b_c.mp4"));
        System.out.println("DownloadPolicy: "+checks+" checks passed");
    }
}
