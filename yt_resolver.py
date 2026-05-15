#!/usr/bin/env python3
"""
YouTube stream URL resolver - CLI modu.
Kullanim: python yt_resolver.py <youtube_url_veya_video_id>
Basarida: stream URL stdout'a yazilir, cikis kodu 0.
Hata: hata mesaji stderr'e yazilir, cikis kodu 1.
"""
import sys
import io
import re

# Windows cp1252 sorununu onle
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def extract_video_id(raw):
    raw = raw.strip()
    if re.match(r"^[A-Za-z0-9_-]{11}$", raw):
        return raw
    for pat in [
        r"(?:v=|youtu\.be/|embed/|live/|shorts/|/v/)([A-Za-z0-9_-]{11})",
    ]:
        m = re.search(pat, raw)
        if m:
            return m.group(1)
    return None


def resolve(url):
    import yt_dlp  # noqa: PLC0415

    vid = extract_video_id(url)
    canonical = ("https://www.youtube.com/watch?v=" + vid) if vid else url

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extractor_retries": 3,
        # Muxed (video+audio) mp4 tercih et, yoksa en iyisini al
        "format": "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]/best",
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(canonical, download=False)

    # Canli yayinlar icin HLS manifest URL
    manifest = info.get("manifest_url") or info.get("url")
    if manifest and manifest.startswith("http"):
        return manifest

    # Format listesinden en iyi muxed secimi
    formats = info.get("formats") or []

    # 1. Tercih: muxed mp4 (video+audio ayni dosyada)
    muxed_mp4 = [
        f for f in formats
        if f.get("url")
        and f.get("vcodec") not in (None, "none")
        and f.get("acodec") not in (None, "none")
        and f.get("ext") == "mp4"
    ]
    if muxed_mp4:
        best = max(muxed_mp4, key=lambda f: f.get("height") or 0)
        return best["url"]

    # 2. Herhangi bir muxed format
    muxed_any = [
        f for f in formats
        if f.get("url")
        and f.get("vcodec") not in (None, "none")
        and f.get("acodec") not in (None, "none")
    ]
    if muxed_any:
        best = max(muxed_any, key=lambda f: f.get("height") or 0)
        return best["url"]

    # 3. En azindan videosu olan format
    video_only = [
        f for f in formats
        if f.get("url") and f.get("vcodec") not in (None, "none")
    ]
    if video_only:
        best = max(video_only, key=lambda f: f.get("height") or 0)
        return best["url"]

    raise RuntimeError("Stream URL bulunamadi — format listesi bos")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Kullanim: python yt_resolver.py <youtube_url_veya_video_id>", file=sys.stderr)
        sys.exit(1)

    target = sys.argv[1].strip()
    try:
        stream_url = resolve(target)
        print(stream_url)
    except Exception as exc:
        print(f"Hata: {exc}", file=sys.stderr)
        sys.exit(1)
