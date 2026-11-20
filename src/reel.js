// Demo reel: a showreel video played in a dialog over the viewer.
// Phase 2: the admin uploads the reel; the public site calls loadReel(publicUrl, name).

const MAX_REEL_MB = 500;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;

const dialog = document.getElementById('reel');
const video = document.getElementById('reelVideo');
const empty = document.getElementById('reelEmpty');
const errorEl = document.getElementById('reelError');
const titleEl = document.getElementById('reelTitle');
const input = document.getElementById('reelInput');

let currentUrl = null;

export function isVideoFile(file) {
  return !!file && (file.type.startsWith('video/') || VIDEO_EXT.test(file.name));
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

/** Validate a local video File, then hand it to loadReel(). */
export function loadReelFile(file) {
  if (!file) return;
  if (!isVideoFile(file)) {
    showError('Choose an MP4, WebM or MOV video.');
    return;
  }
  if (file.size > MAX_REEL_MB * 1048576) {
    showError(`This video is larger than ${MAX_REEL_MB} MB. Export a smaller version and try again.`);
    return;
  }
  if (file.type && !video.canPlayType(file.type)) {
    showError('This browser can’t play this video format. Export it as an H.264 MP4 and try again.');
    return;
  }
  loadReel(URL.createObjectURL(file), file.name.replace(/\.[^.]+$/, ''));
}

/** Single entry point for showing a reel (local blob now, cloud URL in Phase 2). */
export function loadReel(url, name = 'Demo reel') {
  if (currentUrl?.startsWith('blob:')) URL.revokeObjectURL(currentUrl);
  currentUrl = url;
  showError('');
  video.src = url;
  video.hidden = false;
  empty.hidden = true;
  document.getElementById('reelReplace').hidden = false;
  titleEl.textContent = name;
  openReel();
}

export function openReel() {
  if (!dialog.open) dialog.showModal();
  if (currentUrl) video.play().catch(() => {}); // autoplay may be blocked; controls remain
}

video.addEventListener('error', () => {
  if (!currentUrl) return;
  showError('This video couldn’t be played. Export it as an H.264 MP4 and try again.');
});

dialog.addEventListener('close', () => video.pause());
// Click on the backdrop (outside the dialog box) closes it.
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});

document.getElementById('reelClose').addEventListener('click', () => dialog.close());
document.querySelectorAll('[data-reel-pick]').forEach((btn) =>
  btn.addEventListener('click', () => input.click())
);
input.addEventListener('change', () => {
  loadReelFile(input.files[0]);
  input.value = '';
});

dialog.addEventListener('dragover', (e) => e.preventDefault());
dialog.addEventListener('drop', (e) => {
  e.preventDefault();
  loadReelFile(e.dataTransfer.files[0]);
});
