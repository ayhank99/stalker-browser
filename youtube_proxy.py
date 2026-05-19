#!/usr/bin/env python3
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

from flask import Flask, Response, jsonify, request, send_file
from werkzeug.utils import safe_join

import yt_dlp


app = Flask(__name__)

PROXY_HOST = os.environ.get("YOUTUBE_PROXY_HOST", "0.0.0.0").strip() or "0.0.0.0"
PROXY_PORT = int(os.environ.get("YOUTUBE_PROXY_PORT", "5000") or "5000")
ROOT_DATA_DIR = os.environ.get("YOUTUBE_PROXY_DATA_DIR") or os.path.join(
    os.environ.get("DATA_DIR", "/tmp/iptv_data"),
    "youtube_proxy",
)
CHANNELS_FILE = os.path.join(ROOT_DATA_DIR, "channels.json")
HLS_BASE = os.path.join(ROOT_DATA_DIR, "hls")
SEGMENT_SECONDS = int(os.environ.get("YOUTUBE_HLS_TIME", "4") or "4")
LIST_SIZE = int(os.environ.get("YOUTUBE_HLS_LIST_SIZE", "12") or "12")
READY_TIMEOUT_SECONDS = int(os.environ.get("YOUTUBE_HLS_READY_TIMEOUT", "30") or "30")
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
YTDLP_BIN = [sys.executable, "-m", "yt_dlp"]

# Cookie file path written from YOUTUBE_COOKIES env var (Netscape format)
_COOKIE_FILE = os.path.join(
    os.environ.get("DATA_DIR", "/tmp/iptv_data"), "youtube_cookies.txt"
)

os.makedirs(ROOT_DATA_DIR, exist_ok=True)
os.makedirs(HLS_BASE, exist_ok=True)


def _write_cookie_file():
    """Write YOUTUBE_COOKIES env var content to a Netscape cookie file."""
    raw = (os.environ.get("YOUTUBE_COOKIES") or "").strip()
    if not raw:
        return None
    os.makedirs(os.path.dirname(_COOKIE_FILE), exist_ok=True)
    try:
        with open(_COOKIE_FILE, "w", encoding="utf-8") as fh:
            if not raw.startswith("# Netscape"):
                fh.write("# Netscape HTTP Cookie File\n")
            fh.write(raw + "\n")
        return _COOKIE_FILE
    except Exception as exc:
        log("[YouTube HLS] cookie write error:", exc)
        return None


_COOKIE_PATH = _write_cookie_file()

lock = threading.RLock()
processes = {}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def log(*parts):
    text = " ".join(str(part) for part in parts)
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        print(text.encode("utf-8", errors="replace").decode("utf-8"), flush=True)


def safe_channel_id(value):
    value = str(value or "").strip()
    if re.fullmatch(r"yt_[A-Za-z0-9_-]{11}", value):
        return value
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return "yt_" + value
    if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", value):
        return value
    return ""


def extract_video_id(value):
    value = str(value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return value
    match = re.search(r"(?:v=|youtu\.be/|embed/|live/|shorts/|/v/)([A-Za-z0-9_-]{11})", value)
    return match.group(1) if match else ""


def canonical_youtube_url(value):
    video_id = extract_video_id(value)
    return "https://www.youtube.com/watch?v=" + video_id if video_id else str(value or "").strip()


def load_channels():
    try:
        if not os.path.exists(CHANNELS_FILE):
            return {}
        with open(CHANNELS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        log("[YouTube HLS] channel read error:", exc)
        return {}


def save_channels(channels):
    tmp_path = CHANNELS_FILE + ".tmp"
    os.makedirs(os.path.dirname(CHANNELS_FILE), exist_ok=True)
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(channels or {}, handle, ensure_ascii=True, indent=2)
    os.replace(tmp_path, CHANNELS_FILE)


def channel_dir(channel_id):
    return os.path.join(HLS_BASE, channel_id)


def playlist_path(channel_id):
    return os.path.join(channel_dir(channel_id), "index.m3u8")


def is_process_alive(channel_id):
    proc = processes.get(channel_id)
    return bool(proc and proc.poll() is None)


def stop_channel(channel_id):
    for key in (channel_id, channel_id + "_ytdlp"):
        proc = processes.pop(key, None)
        if not proc:
            continue
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def clean_hls_dir(channel_id):
    out_dir = channel_dir(channel_id)
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)


def playlist_has_segments(channel_id):
    path = playlist_path(channel_id)
    try:
        if not os.path.exists(path):
            return False
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read(4096)
        return "#EXTM3U" in text and ".ts" in text
    except Exception:
        return False


def playlist_is_fresh(channel_id):
    path = playlist_path(channel_id)
    try:
        if not playlist_has_segments(channel_id):
            return False
        return (time.time() - os.path.getmtime(path)) < max(SEGMENT_SECONDS * (LIST_SIZE + 3), 45)
    except Exception:
        return False


def resolve_stream(youtube_url):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extractor_retries": 5,
        "fragment_retries": 5,
        "socket_timeout": 25,
        "geo_bypass": True,
        "nocheckcertificate": True,
        "format": "best[protocol^=m3u8][height<=720]/best[height<=720][ext=mp4]/best[height<=720]/best",
        "extractor_args": {
            "youtube": {
                "player_client": ["mweb", "ios", "android_vr", "tv", "web"]
            }
        },
    }
    if _COOKIE_PATH and os.path.exists(_COOKIE_PATH):
        opts["cookiefile"] = _COOKIE_PATH
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(youtube_url, download=False)

    stream_url = info.get("url") or info.get("manifest_url") or ""
    formats = info.get("formats") or []
    if not stream_url:
        muxed = [
            fmt for fmt in formats
            if fmt.get("url")
            and fmt.get("vcodec") not in (None, "none")
            and fmt.get("acodec") not in (None, "none")
        ]
        if muxed:
            muxed.sort(key=lambda fmt: ((fmt.get("height") or 0), (fmt.get("tbr") or 0)), reverse=True)
            stream_url = muxed[0].get("url") or ""

    if not stream_url:
        raise RuntimeError("YouTube stream could not be resolved")

    return {
        "stream_url": stream_url,
        "title": info.get("title") or "",
        "is_live": bool(info.get("is_live") or info.get("live_status") == "is_live"),
        "duration": info.get("duration") or 0,
        "thumbnail": info.get("thumbnail") or "",
    }


def _ytdlp_args(youtube_url):
    """Build yt-dlp CLI args that pipe the stream to stdout."""
    args = YTDLP_BIN + [
        "--no-warnings",
        "--no-check-certificate",
        "--geo-bypass",
        "--force-ipv4",
        "--no-playlist",
        "--extractor-args", "youtube:player_client=mweb,ios,android_vr,tv,web",
        "-f", "best[protocol^=m3u8][height<=720]/best[height<=720][ext=mp4]/best[height<=720]/best",
        "-o", "-",
    ]
    if _COOKIE_PATH and os.path.exists(_COOKIE_PATH):
        args += ["--cookies", _COOKIE_PATH]
    args += ["--", youtube_url]
    return args


def _ffmpeg_hls_args(channel_id):
    """Build ffmpeg args that read from stdin and write HLS to disk."""
    out_dir = channel_dir(channel_id)
    return [
        FFMPEG_BIN,
        "-hide_banner", "-loglevel", "warning", "-nostdin",
        "-analyzeduration", "3000000", "-probesize", "3000000",
        "-i", "pipe:0",
        "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
        "-c:v", "copy", "-c:a", "copy",
        "-f", "hls",
        "-hls_time", str(SEGMENT_SECONDS),
        "-hls_list_size", str(LIST_SIZE),
        "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
        "-hls_segment_filename", os.path.join(out_dir, "segment_%06d.ts"),
        playlist_path(channel_id),
    ]


def _log_stderr(label, pipe):
    """Background thread that prints a process's stderr to our log."""
    try:
        for raw in pipe:
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                log(label, line)
    except Exception:
        pass


def start_ffmpeg(channel_id, stream_url, is_live):
    """Start yt-dlp piped into ffmpeg to produce HLS segments.

    stream_url here is the canonical YouTube watch URL (not a CDN URL).
    We pass it through yt-dlp so all auth/cookie handling is done by
    yt-dlp rather than having ffmpeg hit the CDN URL directly (which
    typically fails with 403 on cloud IPs).
    """
    stop_channel(channel_id)
    clean_hls_dir(channel_id)

    ytdlp_args = _ytdlp_args(stream_url)
    ffmpeg_args = _ffmpeg_hls_args(channel_id)

    ytdlp_proc = subprocess.Popen(
        ytdlp_args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        close_fds=os.name != "nt",
    )
    ffmpeg_proc = subprocess.Popen(
        ffmpeg_args,
        stdin=ytdlp_proc.stdout,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        close_fds=os.name != "nt",
    )
    # Hand pipe ownership to ffmpeg; parent doesn't need it
    ytdlp_proc.stdout.close()

    threading.Thread(
        target=_log_stderr,
        args=("[yt-dlp][" + channel_id + "]", ytdlp_proc.stderr),
        daemon=True,
    ).start()
    threading.Thread(
        target=_log_stderr,
        args=("[ffmpeg][" + channel_id + "]", ffmpeg_proc.stderr),
        daemon=True,
    ).start()

    # Store both; is_process_alive / stop_channel check ffmpeg_proc
    processes[channel_id] = ffmpeg_proc
    processes[channel_id + "_ytdlp"] = ytdlp_proc

    log("[YouTube HLS] pipeline started:", channel_id,
        "yt-dlp pid", ytdlp_proc.pid, "ffmpeg pid", ffmpeg_proc.pid,
        "live" if is_live else "vod")


def ensure_channel(channel_id, youtube_url="", title="", wait_ready=True):
    channel_id = safe_channel_id(channel_id)
    if not channel_id:
        raise ValueError("Invalid channel id")

    with lock:
        channels = load_channels()
        record = channels.get(channel_id) or {}
        if youtube_url:
            record["youtube_url"] = canonical_youtube_url(youtube_url)
        if title:
            record["title"] = title
        if not record.get("youtube_url"):
            video_id = channel_id[3:] if channel_id.startswith("yt_") else extract_video_id(channel_id)
            if video_id:
                record["youtube_url"] = canonical_youtube_url(video_id)
        if not record.get("youtube_url"):
            raise RuntimeError("YouTube URL missing")

        # Start pipeline only if it crashed or was never started.
        # yt-dlp in the pipeline handles auth, URL resolution, and cookies internally —
        # no need to call resolve_stream() here before startup.
        if not is_process_alive(channel_id):
            start_ffmpeg(channel_id, record["youtube_url"], bool(record.get("is_live")))

        record["updated_at"] = utc_now()
        channels[channel_id] = record
        save_channels(channels)

    ready = playlist_is_fresh(channel_id)
    if wait_ready and not ready:
        deadline = time.time() + READY_TIMEOUT_SECONDS
        while time.time() < deadline:
            if playlist_has_segments(channel_id):
                ready = True
                break
            proc = processes.get(channel_id)
            if proc and proc.poll() is not None:
                break
            time.sleep(0.35)

    return {
        "ok": True,
        "ready": bool(ready),
        "channelId": channel_id,
        "hlsPath": f"/hls/{channel_id}/index.m3u8",
        "title": record.get("title", ""),
        "isLive": bool(record.get("is_live")),
        "updatedAt": record.get("updated_at", ""),
    }


@app.get("/")
def index():
    return Response(
        "YouTube HLS proxy is running. Use /api/ensure/<channel_id> from the Node backend.",
        mimetype="text/plain; charset=utf-8",
    )


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "dataDir": ROOT_DATA_DIR,
        "channels": len(load_channels()),
        "running": sum(1 for channel_id in list(processes) if is_process_alive(channel_id)),
    })


@app.route("/api/ensure/<channel_id>", methods=["GET", "POST"])
def api_ensure(channel_id):
    payload = request.get_json(silent=True) or {}
    youtube_url = payload.get("url") or request.args.get("url") or ""
    title = payload.get("title") or request.args.get("title") or ""
    try:
        return jsonify(ensure_channel(channel_id, youtube_url, title, wait_ready=True))
    except Exception as exc:
        log("[YouTube HLS] ensure error:", channel_id, exc)
        return jsonify({"ok": False, "error": str(exc) or "YouTube stream could not be resolved"}), 503


@app.get("/api/channels")
def api_channels():
    channels = load_channels()
    return jsonify({
        "channels": [
            {"id": channel_id, **record}
            for channel_id, record in sorted(channels.items())
        ]
    })


@app.get("/hls/<channel_id>/index.m3u8")
def hls_playlist(channel_id):
    channel_id = safe_channel_id(channel_id)
    if not channel_id:
        return Response("Invalid channel id", status=400)
    if not playlist_is_fresh(channel_id):
        try:
            ensure_channel(channel_id, wait_ready=True)
        except Exception as exc:
            log("[YouTube HLS] playlist ensure error:", channel_id, exc)
    path = playlist_path(channel_id)
    if not os.path.exists(path):
        return Response("YouTube stream could not be resolved", status=503)
    response = send_file(path, mimetype="application/vnd.apple.mpegurl", conditional=False)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/hls/<channel_id>/<path:filename>")
def hls_file(channel_id, filename):
    channel_id = safe_channel_id(channel_id)
    if not channel_id:
        return Response("Invalid channel id", status=400)
    base = channel_dir(channel_id)
    file_path = safe_join(base, filename)
    if not file_path or not os.path.exists(file_path):
        return Response("Not found", status=404)
    mimetype = "video/MP2T" if filename.lower().endswith(".ts") else "application/octet-stream"
    response = send_file(file_path, mimetype=mimetype, conditional=True)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/stream")
def stream_from_url():
    raw_url = request.args.get("url") or request.args.get("id") or ""
    video_id = extract_video_id(raw_url)
    if not video_id:
        return Response("Invalid YouTube URL", status=400)
    channel_id = "yt_" + video_id
    result = ensure_channel(channel_id, raw_url, request.args.get("title") or "", wait_ready=True)
    if not result.get("ready"):
        return Response("YouTube stream could not be resolved", status=503)
    return hls_playlist(channel_id)


def shutdown(*_args):
    for channel_id in list(processes):
        stop_channel(channel_id)
    sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)


if __name__ == "__main__":
    log("[YouTube HLS] proxy started on", f"{PROXY_HOST}:{PROXY_PORT}")
    log("[YouTube HLS] data dir:", ROOT_DATA_DIR)
    app.run(host=PROXY_HOST, port=PROXY_PORT, debug=False, use_reloader=False, threaded=True)
