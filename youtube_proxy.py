from flask import Flask, Response, jsonify, redirect, request
import locale
import os
import sys

import yt_dlp


def configure_stdio():
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if not stream or not hasattr(stream, "reconfigure"):
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def log(message):
    text = str(message)
    try:
        print(text)
    except UnicodeEncodeError:
        buffer = getattr(sys.stdout, "buffer", None)
        if buffer:
            buffer.write((text + "\n").encode("utf-8", errors="replace"))
            buffer.flush()
        else:
            sys.stdout.write(text.encode("ascii", errors="replace").decode("ascii") + "\n")
            sys.stdout.flush()


configure_stdio()

for locale_name in ("tr_TR.UTF-8", "en_US.UTF-8", "Turkish_Turkey.1254"):
    try:
        locale.setlocale(locale.LC_ALL, locale_name)
        break
    except locale.Error:
        continue


app = Flask(__name__)

def parse_int_env(name, fallback):
    try:
        raw = str(os.environ.get(name, "")).strip()
        if not raw:
            return int(fallback)
        numeric = int(raw, 10)
        return numeric if numeric > 0 else int(fallback)
    except Exception:
        return int(fallback)


PROXY_HOST = str(os.environ.get("YOUTUBE_PROXY_HOST", "0.0.0.0")).strip() or "0.0.0.0"
PROXY_PORT = parse_int_env("YOUTUBE_PROXY_PORT", 5000)


def get_stream_url(youtube_url):
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extractor_retries": 5,
        "format_sort": ["res", "codec:h264", "ext:mp4", "size"],
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(youtube_url, download=False)

    formats = info.get("formats", [])
    best_url = None
    max_height = -1

    for stream_format in formats:
        if (
            stream_format.get("ext") == "mp4"
            and stream_format.get("vcodec") != "none"
            and stream_format.get("acodec") != "none"
        ):
            height = stream_format.get("height") or 0
            if height > max_height:
                max_height = height
                best_url = stream_format.get("url")

    if best_url:
        return best_url, max_height

    try:
        fallback = info if info.get("url") else None
        if fallback and fallback.get("url"):
            return fallback["url"], fallback.get("height", 0)
    except Exception:
        pass

    for stream_format in formats:
        url = stream_format.get("url")
        if url and stream_format.get("vcodec") != "none":
            return url, stream_format.get("height", 0)

    raise RuntimeError("Hicbir stream URL bulunamadi")


@app.route("/")
def index():
    html = """<!doctype html>
<html lang="tr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>YouTube IPTV Proxy</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; padding: 24px; line-height: 1.5; }
      code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
      a { color: #2563eb; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .box { max-width: 820px; margin: 0 auto; }
      .muted { color: #6b7280; }
      .row { margin: 10px 0; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>YouTube IPTV Proxy</h1>
      <p class="muted">Bu servis bir web arayüzü değildir; tek amaç YouTube linkini direkt stream URL'sine yönlendirmektir.</p>
      <div class="row">
        <div><strong>Kullanım:</strong></div>
        <div><code>/stream?url=&lt;youtube_url&gt;</code></div>
      </div>
      <div class="row">
        <div><strong>Örnek:</strong></div>
        <div><a href="/stream?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9wgxcQ">/stream?url=https://www.youtube.com/watch?v=dQw4w9wgxcQ</a></div>
      </div>
      <div class="row">
        <div><strong>Health:</strong> <a href="/health">/health</a></div>
      </div>
    </div>
  </body>
</html>
"""
    return Response(html, status=200, mimetype="text/html; charset=utf-8")


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/favicon.ico")
def favicon():
    return Response("", status=204)


@app.route("/stream")
def stream():
    youtube_url = request.args.get("url")
    if not youtube_url:
        return (
            "Hata: YouTube linki eksik!<br>"
            "Ornek kullanim:<br>"
            f"http://127.0.0.1:{PROXY_PORT}/stream?url=https://www.youtube.com/watch?v=VIDEO_ID",
            400,
        )

    try:
        direct_url, height = get_stream_url(youtube_url)
        log(f"[OK] Stream alindi: {height}p -> {youtube_url}")
        return redirect(direct_url, code=302)
    except Exception as exc:
        log(f"[ERR] Hata: {exc}")
        return (
            "Hata: Stream alinamadi. Linki kontrol et veya yt-dlp'yi guncelle."
            f"<br>Hata: {exc}",
            500,
        )


if __name__ == "__main__":
    log("YouTube IPTV Proxy v2 baslatildi (2026 uyumlu)")
    log(f"Web tarayicisinda test: http://127.0.0.1:{PROXY_PORT}/stream?url=https://www.youtube.com/watch?v=dQw4w9wgxcQ")
    log(f"TV/IPTV icin: http://BILGISAYAR_IP:{PROXY_PORT}/stream?url=...")
    log("Cikmak icin Ctrl + C")
    app.run(host=PROXY_HOST, port=PROXY_PORT, debug=False, use_reloader=False)
