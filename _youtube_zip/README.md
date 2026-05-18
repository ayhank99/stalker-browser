# YouTube Proxy Server

A Node.js Express proxy server to stream and get info from YouTube videos via yt-dlp, with a custom dark themed video player frontend.

## Features

- Stream YouTube videos with range support
- Get video metadata (title, uploader, duration, thumbnail, formats)
- Proxy YouTube thumbnails (hide origin)
- CORS enabled with preflight support
- Custom HTML5 video player frontend with controls and "kaynak gizli" badge

## Requirements

- Node.js 18+ installed
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and available in your system PATH

## Installing yt-dlp

### Windows

Use [yt-dlp.exe](https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe) and add it to your PATH or place it in the same folder as `server.js`.

### macOS/Linux

```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp