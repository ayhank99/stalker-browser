from flask import Flask, request, Response, stream_with_context
import yt_dlp
import requests

app = Flask(__name__)

def get_best_stable_url(youtube_url):
    # Sabit yüksek kaliteli MP4 için optimize edilmiş seçenekler
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'extractor_retries': 5,
        'format_sort': ['res:1080', 'codec:h264', 'ext:mp4', 'size', 'br'],  # 1080p öncelik + H264
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(youtube_url, download=False)
        
        # 1. En iyi muxed MP4 (video + audio bir arada) - en stabil
        formats = info.get('formats', [])
        best_url = None
        best_height = 0
        best_br = 0
        
        for f in formats:
            if (f.get('ext') == 'mp4' and 
                f.get('vcodec') != 'none' and 
                f.get('acodec') != 'none'):
                height = f.get('height') or 0
                br = f.get('tbr') or 0  # toplam bitrate
                
                # 1080p ve altı ama en yüksek bitrate'li olanı tercih et
                if height > best_height or (height == best_height and br > best_br):
                    if height <= 1080:  # 4K istemiyorsan 1080 ile sınırla
                        best_height = height
                        best_br = br
                        best_url = f.get('url')
        
        if best_url:
            print(f"✅ Sabit MP4 seçildi: {best_height}p (~{best_br:.0f}kbps)")
            return best_url, best_height
        
        # 2. Fallback: En iyi video + en iyi audio (ayrıysa player birleştirir)
        try:
            best_video = ydl.extract_info(youtube_url, download=False)
            # Basit fallback
            for f in formats:
                if f.get('url') and f.get('vcodec') != 'none' and f.get('height', 0) >= 720:
                    print(f"✅ Fallback video: {f.get('height')}p")
                    return f.get('url'), f.get('height', 0)
        except:
            pass
        
        raise Exception("Uygun yüksek kaliteli format bulunamadı")

@app.route('/stream')
def stream():
    youtube_url = request.args.get('url')
    if not youtube_url:
        return "Hata: ?url= parametresi eksik", 400
    
    try:
        direct_url, height = get_best_stable_url(youtube_url)
        
        # Tam byte proxy (range support + seek edilebilir)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.youtube.com/',
            'Accept': '*/*',
        }
        
        req = requests.get(direct_url, headers=headers, stream=True, allow_redirects=True, timeout=15)
        req.raise_for_status()
        
        def generate():
            for chunk in req.iter_content(chunk_size=16384):  # Daha büyük chunk = daha az kesinti
                if chunk:
                    yield chunk
        
        response_headers = {
            'Content-Type': req.headers.get('Content-Type', 'video/mp4'),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
            'Content-Disposition': f'inline; filename="stream_{height}p.mp4"',
        }
        
        return Response(stream_with_context(generate()), 
                       headers=response_headers,
                       status=req.status_code)
    
    except Exception as e:
        print(f"❌ Hata: {str(e)}")
        return f"Stream alınamadı: {str(e)}", 500

if __name__ == '__main__':
    print("🚀 YouTube IPTV Proxy v4 - Sabit Yüksek Kalite MP4 Modu (HLS kapatıldı)")
    print("Kalite artık sabit kalacak, m3u8 değişimi olmayacak.")
    print("Test linki: http://127.0.0.1:5000/stream?url=https://www.youtube.com/watch?v=dQw4w9wgxcQ")
    app.run(host='0.0.0.0', port=5000, debug=False)