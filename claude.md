# CLAUDE.md — GLB Model Viewer

Browser app for uploading `.glb` 3D models and inspecting them with switchable view modes
(Textured, Wireframe, Clay, Normals) and toggles (Grid, Ground, Performance stats).

- **Stack:** Vite 8 (vanilla JS, no framework) + three.js r187. `three` is the only runtime dependency.
- **Status:** Phase 1 (local viewer) built. Phase 2 (shared cloud storage) planned — see Roadmap.
- **Test model:** `tree final t.glb` — 1 mesh, 916 triangles, one double-sided textured
  `MeshPhysicalMaterial` (clearcoat + specular), no animation, no alpha cut-outs.

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Dev server (http://localhost:5173) | `npm run dev` |
| Production build → `dist/` | `npm run build` |
| Preview build | `npm run preview` |

## Structure

```
index.html      header (mode tabs, toggles, upload) + #viewer container
src/main.js     scene, loaders, view modes, UI wiring, render loop
src/style.css   layout and tab styles
```

## Rules

1. **Git lives in this folder only.** The parent `~/Documents/Projects` is a separate repo
   with unrelated projects — never commit from there.
2. **One loading entry point:** every model goes through `loadModel(url, fileSize)`.
   `loadFile(file)` only validates and passes an object URL. Phase 2 must reuse
   `loadModel` with a remote URL — don't add a second loading path.
3. **Always dispose.** Any new GPU resource (geometry, material, texture, skeleton,
   override material) must be released in `clearModel()`.
4. **Never mutate original materials.** View modes swap `mesh.material`; originals live in
   `originalMaterials`, overrides in `overrideCache` (keyed by original material, one per
   material slot). Originals are restored before disposal.
5. **No CDNs.** Draco/Basis decoders are resolved by three.js via `import.meta.url` and
   bundled by Vite automatically — don't call `setDecoderPath`/`setTranscoderPath`.
6. Import addons from `three/addons/...`. Use `THREE.Timer` (`Clock` is deprecated since r183)
   and `PCFShadowMap` (`PCFSoftShadowMap` was removed).

## Key behaviour

- **Loading:** `.glb` only, max 200 MB. Draco, meshopt and KTX2 supported. A load counter
  (`loadId`) ensures only the latest load is shown; stale results are disposed.
- **Framing:** `frameModel()` centres on x/z, sits the model on y = 0 and fits the camera.
  Grid size and offset, ground, shadow camera and `normalBias` all scale with `maxDim`.
- **View modes are combinable:** `surfaceMode` (Textured / Clay / Normals, one at a time,
  or `null`) plus `showWire`. At least one is always on. Clicking the active surface turns it
  off only while Wireframe is on.
  - Wireframe alone → per-material wireframe overrides (`applyViewMode()`).
  - Wireframe + surface → `render()` does a second pass with `scene.overrideMaterial = wireOverlay`
    (grid/ground/background hidden, shadow map not redrawn, `autoClear` off). `wireOverlay` pulls
    lines towards the camera in the vertex shader so back-facing lines stay hidden.
  - `renderer.info.autoReset` is off and reset once per frame, so perf stats include both passes.
- **Overrides** keep the original `side`. Clay keeps alpha cut-outs by replacing
  `#include <map_fragment>` with an alpha-only sample (`ALPHA_ONLY_MAP`).
- **Drag & drop:** `dragDepth` counter stops overlay flicker; `window` handlers stop the
  browser opening files dropped outside the viewer.
- **Perf panel:** refreshes every 0.5 s while visible. Model triangle/vertex counts
  include instancing.
- **Animations:** first clip auto-plays; the mixer is stopped and uncached on model change.

## Testing checklist

- [ ] Tree model loads centred on the ground; double-sided parts visible
- [ ] Wireframe overlays Textured / Clay / Normals; wireframe alone works; can't deselect the last active mode
- [ ] Overlay works on an animated (skinned) model
- [ ] Clay keeps cut-outs on an alpha-tested model (e.g. Khronos `AlphaBlendModeTest`)
- [ ] Draco, meshopt and KTX2 samples load (Khronos glTF Sample Assets)
- [ ] Non-`.glb` / oversized file → alert; dropping outside the viewer does nothing
- [ ] GPU geometry/texture counts in the perf panel return to the same values after loading another model
- [ ] Two quick loads → only the second shows
- [ ] Animated model plays; switching models stops it
- [ ] Resize doesn't stretch; `npm run build && npm run preview` works

## Known notes

- `npm audit` reports a high-severity ReDoS in `picomatch` via Vite 8 (dev-server only,
  not shipped in `dist/`). Its suggested fix downgrades Vite — wait for an upstream update instead.
- Build warns about a >500 kB chunk (three.js). Fine for now; code-split only if load time matters.

## Roadmap

**Phase 2 — shared models (planned backend: Supabase)**
- Storage bucket `models` (public read, ≤ 50 MB per file); table `models`
  (`id`, `name`, `path`, `size_bytes`, `thumbnail_path`, `owner_id`, `created_at`).
- Upload: validate → upload to storage → insert row → `loadModel(publicUrl, size)`.
- Gallery page with thumbnails (capture the canvas right after a render).
- Share links: `?model=<id>`.
- Sign-in required to upload, anyone can view, owners can delete.
- Row Level Security on table and bucket; enforce size/type limits server-side.

**Later:** HDRI switcher, bounding-box view, UV checker, screenshot button, animation clip picker.
