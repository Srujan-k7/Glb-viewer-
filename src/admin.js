// Admin page: sign in, upload/delete models, replace the demo reel.
// This page only offers the UI. What a user may actually do is enforced by
// Row Level Security and storage policies in Supabase (supabase/setup.sql).
import './admin.css';
import {
  supabase, isConfigured, publicUrl,
  MAX_UPLOAD_MB, MODELS_BUCKET, REELS_BUCKET, THUMBS_BUCKET,
} from './supabase.js';
import { renderThumbnail } from './thumbnail.js';

const $ = (id) => document.getElementById(id);
const views = ['configView', 'loginView', 'deniedView', 'dashView'];

function show(view) {
  for (const v of views) $(v).hidden = v !== view;
}

function setStatus(el, message, kind = '') {
  el.textContent = message;
  el.className = `status ${kind}`;
}

function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Disable a form's controls while an upload runs. */
function busy(form, on) {
  for (const el of form.elements) el.disabled = on;
}

// ---------- Auth ----------

let currentUserId = null;

async function onSession(session) {
  const user = session?.user ?? null;
  if (user?.id === currentUserId) return; // token refresh, same user
  currentUserId = user?.id ?? null;

  $('who').textContent = user?.email ?? '';
  $('signOut').hidden = !user;
  if (!user) return show('loginView');

  // Ask the database, not the browser, whether this user is the admin.
  const { data: isAdmin, error } = await supabase.rpc('is_admin');
  if (error) console.error(error);
  if (!isAdmin) return show('deniedView');

  show('dashView');
  refreshModels();
  refreshReel();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  busy(form, true);
  setStatus($('loginStatus'), 'Signing in…');
  const { error } = await supabase.auth.signInWithPassword({
    email: $('email').value.trim(),
    password: $('password').value,
  });
  busy(form, false);
  if (error) setStatus($('loginStatus'), error.message, 'error');
  else {
    setStatus($('loginStatus'), '');
    $('password').value = '';
  }
});

$('signOut').addEventListener('click', () => supabase.auth.signOut());

// ---------- Models ----------

/** A .glb file starts with the ASCII magic "glTF". */
async function isGlb(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return String.fromCharCode(...head) === 'glTF';
}

async function refreshModels() {
  const list = $('modelList');
  const { data, error } = await supabase
    .from('models')
    .select('id, name, path, size_bytes, created_at, thumbnail_path')
    .order('created_at', { ascending: false });

  list.replaceChildren();
  if (error) {
    setStatus($('modelStatus'), `Couldn’t load models: ${error.message}`, 'error');
    return;
  }
  $('modelCount').textContent = `${data.length} ${data.length === 1 ? 'model' : 'models'}`;
  if (!data.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No models yet. Upload your first .glb above.';
    list.append(li);
    return;
  }
  for (const model of data) list.append(modelRow(model));
}

/** Removes a storage file, ignoring a missing path. Used for cleanup, so it only logs failures. */
async function removeQuietly(bucket, path) {
  if (!path) return;
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) console.warn(`Couldn’t remove ${bucket}/${path}`, error);
}

/** Renders the model at `modelUrl`, uploads the image and returns its storage path. */
async function uploadThumbnail(modelUrl) {
  const blob = await renderThumbnail(modelUrl);
  const path = `${crypto.randomUUID()}.${blob.type === 'image/webp' ? 'webp' : 'png'}`;
  const up = await supabase.storage
    .from(THUMBS_BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: false });
  if (up.error) throw up.error;
  return path;
}

function modelRow(model) {
  const li = document.createElement('li');

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (model.thumbnail_path) {
    const img = document.createElement('img');
    img.src = publicUrl(THUMBS_BUCKET, model.thumbnail_path);
    img.alt = '';
    img.loading = 'lazy';
    thumb.append(img);
  }

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = model.name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${formatSize(model.size_bytes)} · ${formatDate(model.created_at)}`;
  info.append(name, meta);

  const open = document.createElement('a');
  open.className = 'btn';
  open.href = `/viewer.html?model=${encodeURIComponent(model.id)}`; // same link to share with interviewers
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'View';

  const remake = document.createElement('button');
  remake.className = 'btn';
  remake.textContent = model.thumbnail_path ? 'Redo thumbnail' : 'Make thumbnail';
  remake.addEventListener('click', () => remakeThumbnail(model, remake));

  const del = document.createElement('button');
  del.className = 'btn danger';
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteModel(model, del));

  li.append(thumb, info, open, remake, del);
  return li;
}

$('modelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const status = $('modelStatus');
  const file = $('modelFile').files[0];
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.glb') || !(await isGlb(file))) {
    return setStatus(status, 'That isn’t a valid .glb file.', 'error');
  }
  if (file.size > MAX_UPLOAD_MB * 1048576) {
    return setStatus(status, `File is larger than ${MAX_UPLOAD_MB} MB.`, 'error');
  }

  const name = $('modelName').value.trim() || file.name.replace(/\.glb$/i, '');
  const path = `${crypto.randomUUID()}.glb`;

  busy(form, true);
  // Paths of files uploaded so far, so a later failure can clean them up.
  let modelPath = null;
  let thumbPath = null;
  try {
    // Thumbnail first, from the local file. A failed thumbnail doesn't block the upload.
    setStatus(status, 'Making thumbnail…');
    const localUrl = URL.createObjectURL(file);
    try {
      thumbPath = await uploadThumbnail(localUrl);
    } catch (err) {
      console.warn('Thumbnail failed', err);
    } finally {
      URL.revokeObjectURL(localUrl);
    }

    setStatus(status, `Uploading ${file.name} (${formatSize(file.size)})…`);
    const up = await supabase.storage
      .from(MODELS_BUCKET)
      .upload(path, file, { contentType: 'model/gltf-binary', upsert: false });
    if (up.error) throw up.error;
    modelPath = path;

    const row = await supabase
      .from('models')
      .insert({ name, path, size_bytes: file.size, thumbnail_path: thumbPath });
    if (row.error) throw row.error;

    form.reset();
    setStatus(
      status,
      thumbPath ? `Uploaded “${name}”.` : `Uploaded “${name}”, but the thumbnail failed. Try “Make thumbnail”.`,
      thumbPath ? 'ok' : 'error',
    );
    refreshModels();
  } catch (err) {
    console.error(err);
    // Don't leave orphaned files behind if a later step was rejected.
    await removeQuietly(MODELS_BUCKET, modelPath);
    await removeQuietly(THUMBS_BUCKET, thumbPath);
    setStatus(status, `Upload failed: ${err.message}`, 'error');
  } finally {
    busy(form, false);
  }
});

async function deleteModel(model, button) {
  if (!confirm(`Delete “${model.name}”? This can’t be undone.`)) return;
  const status = $('modelStatus');
  button.disabled = true;

  // Row first: if that fails, nothing changes. A leftover file is harmless; a row
  // pointing at a missing file would break the public site.
  const row = await supabase.from('models').delete().eq('id', model.id).select('id');
  if (row.error || !row.data.length) {
    button.disabled = false;
    return setStatus(status, `Delete failed: ${row.error?.message ?? 'not allowed'}`, 'error');
  }
  await removeQuietly(MODELS_BUCKET, model.path);
  await removeQuietly(THUMBS_BUCKET, model.thumbnail_path);

  setStatus(status, `Deleted “${model.name}”.`, 'ok');
  refreshModels();
}

/** For models uploaded before thumbnails existed, or to redo one: render from the public file. */
async function remakeThumbnail(model, button) {
  const status = $('modelStatus');
  button.disabled = true;
  setStatus(status, `Making thumbnail for “${model.name}”…`);
  let newPath = null;
  try {
    newPath = await uploadThumbnail(publicUrl(MODELS_BUCKET, model.path));
    const row = await supabase
      .from('models')
      .update({ thumbnail_path: newPath })
      .eq('id', model.id)
      .select('id');
    if (row.error) throw row.error;
    if (!row.data.length) throw new Error('not allowed to update this model');
    newPath = null; // now owned by the row
    await removeQuietly(THUMBS_BUCKET, model.thumbnail_path);
    setStatus(status, `Thumbnail ready for “${model.name}”.`, 'ok');
    refreshModels();
  } catch (err) {
    console.error(err);
    await removeQuietly(THUMBS_BUCKET, newPath);
    setStatus(status, `Thumbnail failed: ${err.message}`, 'error');
    button.disabled = false;
  }
}

// ---------- Demo reel ----------

const REEL_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };

async function refreshReel() {
  const box = $('reelCurrent');
  const { data, error } = await supabase
    .from('reels')
    .select('id, name, path, size_bytes, created_at')
    .order('created_at', { ascending: false })
    .limit(1);

  box.replaceChildren();
  if (error) return setStatus($('reelStatus'), `Couldn’t load reel: ${error.message}`, 'error');

  const reel = data[0];
  if (!reel) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No demo reel yet.';
    return box.append(p);
  }
  const video = document.createElement('video');
  video.src = publicUrl(REELS_BUCKET, reel.path);
  video.controls = true;
  video.preload = 'metadata';
  video.playsInline = true;
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = `${reel.name} · ${formatSize(reel.size_bytes)} · ${formatDate(reel.created_at)}`;
  box.append(video, meta);
}

$('reelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const status = $('reelStatus');
  const file = $('reelFile').files[0];
  if (!file) return;

  const ext = file.name.split('.').pop().toLowerCase();
  const contentType = REEL_TYPES[ext];
  if (!contentType) return setStatus(status, 'Choose an MP4, WebM or MOV video.', 'error');
  if (file.size > MAX_UPLOAD_MB * 1048576) {
    return setStatus(status, `Video is larger than ${MAX_UPLOAD_MB} MB. Export a smaller version.`, 'error');
  }

  const name = file.name.replace(/\.[^.]+$/, '');
  const path = `${crypto.randomUUID()}.${ext}`;

  busy(form, true);
  setStatus(status, `Uploading ${file.name} (${formatSize(file.size)})…`);
  try {
    const { data: old, error: oldErr } = await supabase.from('reels').select('id, path');
    if (oldErr) throw oldErr;

    const up = await supabase.storage.from(REELS_BUCKET).upload(path, file, { contentType, upsert: false });
    if (up.error) throw up.error;

    const row = await supabase.from('reels').insert({ name, path, size_bytes: file.size });
    if (row.error) {
      await supabase.storage.from(REELS_BUCKET).remove([path]);
      throw row.error;
    }

    // New reel is live; now clean up the previous one(s).
    if (old.length) {
      await supabase.from('reels').delete().in('id', old.map((r) => r.id));
      await supabase.storage.from(REELS_BUCKET).remove(old.map((r) => r.path));
    }

    form.reset();
    setStatus(status, `Reel replaced with “${name}”.`, 'ok');
    refreshReel();
  } catch (err) {
    console.error(err);
    setStatus(status, `Upload failed: ${err.message}`, 'error');
  } finally {
    busy(form, false);
  }
});

// ---------- Start ----------

if (!isConfigured) {
  show('configView');
} else {
  // Defer: supabase-js advises against awaiting its own calls inside this callback.
  supabase.auth.onAuthStateChange((_event, session) => setTimeout(() => onSession(session), 0));
}
