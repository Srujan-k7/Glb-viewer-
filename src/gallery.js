// Home page: the list of published models. Each card opens the viewer at viewer.html?model=<id>.
import './gallery.css';
import { supabase, isConfigured, publicUrl, REELS_BUCKET, THUMBS_BUCKET } from './supabase.js';
import { loadReel, openReel } from './reel.js';

const grid = document.getElementById('grid');
const stateEl = document.getElementById('state');
const countEl = document.getElementById('count');
const reelBtn = document.getElementById('reelBtn');

function showState(message) {
  stateEl.textContent = message;
  stateEl.hidden = !message;
}

function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const CUBE_ICON =
  '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5 41 14.5v19L24 43 7 33.5v-19L24 5Z M7 14.5 24 24l17-9.5 M24 24v19" /></svg>';

function iconEl() {
  const span = document.createElement('span');
  span.innerHTML = CUBE_ICON; // static markup only; model data goes in via textContent
  return span.firstChild;
}

function card(model) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'card';
  a.href = `/viewer.html?model=${encodeURIComponent(model.id)}`;

  const preview = document.createElement('div');
  preview.className = 'preview';
  if (model.thumbnail_path) {
    const img = document.createElement('img');
    img.src = publicUrl(THUMBS_BUCKET, model.thumbnail_path);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 800;
    img.height = 600;
    // If the image is missing, fall back to the placeholder icon.
    img.addEventListener('error', () => preview.replaceChildren(iconEl()), { once: true });
    preview.append(img);
  } else {
    preview.append(iconEl());
  }

  const body = document.createElement('div');
  body.className = 'card-body';
  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = model.name;
  const meta = document.createElement('span');
  meta.className = 'card-meta';
  meta.textContent = `${formatSize(model.size_bytes)} · ${formatDate(model.created_at)}`;
  const open = document.createElement('span');
  open.className = 'card-open';
  open.textContent = 'View in 3D';
  body.append(name, meta, open);

  a.append(preview, body);
  li.append(a);
  return li;
}

async function load() {
  if (!isConfigured) return showState('This site isn’t configured yet.');

  const [modelsRes, reelRes] = await Promise.all([
    supabase.from('models').select('id, name, size_bytes, created_at, thumbnail_path').order('created_at', { ascending: false }),
    supabase.from('reels').select('name, path').order('created_at', { ascending: false }).limit(1),
  ]);

  const reel = reelRes.data?.[0];
  if (reelRes.error) console.error(reelRes.error);
  if (reel) {
    loadReel(publicUrl(REELS_BUCKET, reel.path), reel.name);
    reelBtn.hidden = false;
  }

  if (modelsRes.error) {
    console.error(modelsRes.error);
    return showState('Couldn’t load the models. Please refresh the page in a moment.');
  }
  const models = modelsRes.data;
  if (!models.length) return showState('Nothing here yet. Models will appear once they’re published.');

  showState('');
  countEl.textContent = `${models.length} ${models.length === 1 ? 'model' : 'models'}`;
  grid.replaceChildren(...models.map(card));
}

reelBtn.addEventListener('click', openReel);
load();
