// Demo reel: a showreel video played in a dialog over the viewer.
// The admin uploads it (admin.html); main.js passes its public URL to loadReel().

const dialog = document.getElementById('reel');
const video = document.getElementById('reelVideo');
const errorEl = document.getElementById('reelError');
const titleEl = document.getElementById('reelTitle');

let currentUrl = null;

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

/** Single entry point for setting the reel. Doesn't open the dialog; openReel() does. */
export function loadReel(url, name = 'Demo reel') {
  currentUrl = url;
  showError('');
  video.src = url;
  video.preload = 'metadata';
  titleEl.textContent = name;
}

export function openReel() {
  if (!dialog.open) dialog.showModal();
  if (currentUrl) video.play().catch(() => {}); // autoplay may be blocked; controls remain
}

video.addEventListener('error', () => {
  if (!currentUrl) return;
  showError('The reel couldn’t be played in this browser.');
});

dialog.addEventListener('close', () => video.pause());
// Click on the backdrop (outside the dialog box) closes it.
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});

document.getElementById('reelClose').addEventListener('click', () => dialog.close());
