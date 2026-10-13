# 3D File Converter

Convert 3D models between formats entirely in your browser — nothing is uploaded anywhere.
Built mainly for turning free store downloads (FBX, GLB, BLEND, DAE, …) into **OBJ + MTL + textures** that drop straight into Unity.

**Live app:** https://teerasak-mairoddee.github.io/3d-file-converter/

## Using it

1. Drop the model onto the page. Include its textures: drop the whole folder, select all the files, or drop the store's `.zip` as-is.
2. Check the preview. Use **Scale** (e.g. *cm → m*) and **Rotate** (*Z-up → Y-up*) if the model is the wrong size or lying on its side.
3. Pick an output format and click **Convert & download**.
4. For Unity: unzip and drag the whole folder into `Assets/` so the `textures/` folder stays next to the `.obj`.

If textures are referenced but not supplied, the app lists the missing file names; the exported `.mtl` still references them, so you can add them to the `textures/` folder later.

## Formats

**Reads:** FBX, GLB, glTF (+ .bin + textures), OBJ (+ MTL), DAE (Collada), 3DS, BLEND, USDZ/USD, STL, PLY, 3MF, AMF, VRML, LWO, X, ASE, MS3D, B3D, MD2/MD3/MD5, SMD, OFF, AC3D, DXF, IFC, Ogre XML, KMZ, VOX, VTK, PCD, XYZ, and other formats supported by [Assimp](https://github.com/assimp/assimp).

**Writes:** OBJ + MTL + textures (zip), GLB, glTF, STL, PLY, USDZ.

Common formats are read with [three.js](https://threejs.org) loaders; everything else (and anything three.js fails on) goes through [assimpjs](https://github.com/kovacsv/assimpjs), a WebAssembly build of Assimp. You can force either engine under **Reader**.

OBJ notes: geometry is baked into world space in the model's rest pose (OBJ has no animation or skeletons), multi-material meshes are split per material, and textures keep their original files when possible (otherwise they are saved as PNG).

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # static build in dist/
```

Pushing to `main` builds the site and publishes `dist/` to the `gh-pages` branch via GitHub Actions.
