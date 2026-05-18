(() => {
  const form = document.getElementById("video-form");
  const input = document.getElementById("input-url");
  const titleEl = document.getElementById("title");
  const uploaderEl = document.getElementById("uploader");
  const durationEl = document.getElementById("duration");
  const infoSection = document.getElementById("video-info");
  const playerContainer = document.getElementById("player-container");
  const errorMessage = document.getElementById("error-message");

  const video = document.getElementById("video");
  const playPauseBtn = document.getElementById("play-pause");
  const seekBar = document.getElementById("seek-bar");
  const volumeBar = document.getElementById("volume-bar");
  const fullscreenBtn = document.getElementById("fullscreen");
  const skipBackBtn = document.getElementById("skip-back");
  const skipForwardBtn = document.getElementById("skip-forward");

  let durationSeconds = 0;

  function extractVideoID(urlOrId) {
    // Accept pure ID or YouTube URL variants
    const ytRegex =
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/))([\w-]{11})/;
    const match = ytRegex.exec(urlOrId);
    if (match && match[1]) return match[1];
    if (/^[\w-]{11}$/.test(urlOrId)) return urlOrId;
    return null;
  }

  function formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return (h > 0 ? h + ":" : "") + `${m.toString().padStart(2,"0")}:${s.toString().padStart(2,"0")}`;
  }

  async function fetchInfo(id) {
    errorMessage.hidden = true;
    infoSection.hidden = true;
    playerContainer.hidden = true;

    try {
      const res = await fetch(`/info?id=${encodeURIComponent(id)}`);
      if (!res.ok) {
        throw new Error(`Failed to get info: ${res.statusText}`);
      }
      const info = await res.json();
      return info;
    } catch (err) {
      throw err;
    }
  }

  function updateInfoUI(info) {
    titleEl.textContent = info.title || "(No Title)";
    uploaderEl.textContent = info.uploader || "(Unknown)";
    durationEl.textContent = formatDuration(info.duration || 0);
    durationSeconds = info.duration || 0;

    infoSection.hidden = false;
  }

  function setVideoSrc(id) {
    // Use our proxy stream endpoint
    video.src = `/stream?id=${encodeURIComponent(id)}&quality=best`;
    video.crossOrigin = "anonymous";
  }

  function togglePlayPause() {
    if (video.paused) {
      video.play();
      playPauseBtn.textContent = "⏸️";
    } else {
      video.pause();
      playPauseBtn.textContent = "▶️";
    }
  }

  function updateSeekBar() {
    if (durationSeconds) {
      const percent = (video.currentTime / durationSeconds) * 100;
      seekBar.value = percent || 0;
    }
  }

  function seekVideo() {
    if (durationSeconds) {
      const newTime = (seekBar.value / 100) * durationSeconds;
      video.currentTime = newTime;
    }
  }

  function updateVolume() {
    video.volume = volumeBar.value;
  }

  function toggleFullscreen() {
    if (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    ) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      else if (document.msExitFullscreen) document.msExitFullscreen();
    } else {
      if (playerContainer.requestFullscreen) playerContainer.requestFullscreen();
      else if (playerContainer.webkitRequestFullscreen)
        playerContainer.webkitRequestFullscreen();
      else if (playerContainer.mozRequestFullScreen)
        playerContainer.mozRequestFullScreen();
      else if (playerContainer.msRequestFullscreen) playerContainer.msRequestFullscreen();
    }
  }

  function skipSeconds(seconds) {
    let newTime = video.currentTime + seconds;
    if (newTime < 0) newTime = 0;
    else if (newTime > durationSeconds) newTime = durationSeconds;
    video.currentTime = newTime;
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const val = input.value.trim();
    const id = extractVideoID(val);
    if (!id) {
      errorMessage.textContent = "Invalid YouTube URL or ID";
      errorMessage.hidden = false;
      return;
    }

    errorMessage.hidden = true;
    try {
      const info = await fetchInfo(id);
      updateInfoUI(info);
      setVideoSrc(id);
      playerContainer.hidden = false;
    } catch (err) {
      errorMessage.textContent = "Error loading video info or stream";
      errorMessage.hidden = false;
      playerContainer.hidden = true;
      infoSection.hidden = true;
    }
  };

  playPauseBtn.onclick = togglePlayPause;
  video.onclick = togglePlayPause;

  video.addEventListener("play", () => {
    playPauseBtn.textContent = "⏸️";
  });
  video.addEventListener("pause", () => {
    playPauseBtn.textContent = "▶️";
  });

  video.ontimeupdate = updateSeekBar;
  seekBar.oninput = seekVideo;
  volumeBar.oninput = updateVolume;
  fullscreenBtn.onclick = toggleFullscreen;

  skipBackBtn.onclick = () => skipSeconds(-10);
  skipForwardBtn.onclick = () => skipSeconds(10);

  // Initialize volume slider to video default volume
  volumeBar.value = video.volume;

  // Accessibility: focus input on load
  input.focus();
})();
