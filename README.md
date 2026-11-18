# GLB Viewer

A fast, browser-based viewer for `.glb` 3D models. Drop in a model and inspect it with
textured, clay, normals and wireframe views. Wireframe can be layered on top of any other
view. Built with [three.js](https://threejs.org) and [Vite](https://vite.dev).

Models are loaded locally in your browser and are never uploaded to a server.

## Features

- **Upload or drag and drop** any `.glb` file (up to 200 MB)
- **Compressed models supported:** Draco, meshopt and KTX2 textures, all decoded locally (no CDN needed)
- **Auto-framing:** the model is centred, placed on the ground and the camera zooms to fit
- **View modes:**
  - **Textured:** original materials
  - **Clay:** plain grey to check shape (keeps alpha cut-outs such as leaves)
  - **Normals:** surface normal colours
  - **Wireframe:** on its own, or as an overlay on Textured / Clay / Normals
- **Scene toggles:** grid, shadow-receiving ground, performance panel
- **Performance panel:** FPS, draw calls, rendered triangles, GPU geometries and textures,
  plus the model's meshes, vertices, triangles, materials and file size
- **Animations:** the first animation clip plays automatically
- **Orbit controls:** rotate, pan and zoom with mouse or touch

## Getting started

Requires **Node.js 18+**.

```bash
git clone git@github.com:Srujan-k7/Glb-viewer-.git
cd Glb-viewer-
npm install
npm run dev
```

Open http://localhost:5173 and upload a `.glb` file. Free test models are available in the
[Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) repository,
and a sample model (`tree final t.glb`) is included in this repo.

### Open on your phone (same Wi-Fi)

```bash
npm run dev -- --host
```

Then open the **Network** address Vite prints (e.g. `http://192.168.x.x:5173`) on your phone.
`localhost` on a phone refers to the phone itself, so it won't work there.

## Controls

| Action | Mouse | Touch |
|---|---|---|
| Rotate | Left drag | One-finger drag |
| Pan | Right drag | Two-finger drag |
| Zoom | Scroll | Pinch |

**View mode buttons:** Textured, Clay and Normals pick the surface (one at a time).
Wireframe toggles independently and draws over the surface. To see wireframe only, turn
Wireframe on and then click the active surface button to turn it off.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Build for production into `dist/` |
| `npm run preview` | Serve the production build locally |

## Deploying

The app is fully static, so after `npm run build` the `dist/` folder can be hosted anywhere.

- **Vercel / Netlify:** import the repo; build command `npm run build`, output directory `dist`.
- **GitHub Pages:** set `base: '/Glb-viewer-/'` in a `vite.config.js`, then publish `dist/`
  (e.g. with a GitHub Actions workflow).

## Project structure

```
index.html      UI: view mode tabs, scene toggles, upload button, viewer container
src/main.js     three.js scene, model loading, view modes, UI wiring, render loop
src/style.css   layout and styles
claude.md       notes and conventions for AI-assisted development
```

## Roadmap

- **Shared models:** store uploads in the cloud (Supabase) so anyone can view them,
  with a gallery page and shareable links
- HDRI environment switcher, bounding-box view and UV checker
- Screenshot button
- Animation clip picker for models with several animations
