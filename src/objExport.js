import * as THREE from 'three';
import { baseName as fileBase, stripExt, textureSources, textureUrls } from './files.js';

// Texture formats Unity imports directly; anything else is re-encoded to PNG.
const UNITY_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'tga', 'psd', 'tif', 'tiff', 'bmp', 'gif'];

function safeName(s, fallback) {
  const clean = (s || '').replace(/[^\w\-.]+/g, '_').replace(/^_+|_+$/g, '');
  return clean || fallback;
}

function uniqueName(name, used) {
  let n = name;
  let i = 1;
  while (used.has(n.toLowerCase())) {
    const dot = name.lastIndexOf('.');
    n = dot > 0 ? `${name.slice(0, dot)}_${i}${name.slice(dot)}` : `${name}_${i}`;
    i++;
  }
  used.add(n.toLowerCase());
  return n;
}

function num(v) {
  // 6 decimals is plenty and keeps files small; strip trailing zeros.
  return Math.abs(v) < 1e-9 ? '0' : String(+v.toFixed(6));
}

async function canvasToPng(canvas) {
  if (canvas.convertToBlob) return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Renders a texture's image to PNG bytes, or null if it cannot be read back (e.g. compressed). */
async function textureToPng(texture) {
  const img = texture.image;
  if (!img || texture.isCompressedTexture) return null;
  const w = img.width || img.videoWidth;
  const h = img.height || img.videoHeight;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (img.data) {
    // DataTexture (e.g. TGA)
    const src = img.data;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const channels = src.length / (w * h);
    for (let i = 0; i < w * h; i++) {
      const c = channels >= 3 ? channels : 1;
      const isFloat = !(src instanceof Uint8Array || src instanceof Uint8ClampedArray);
      const scale = isFloat ? 255 : 1;
      rgba[i * 4] = src[i * c] * scale;
      rgba[i * 4 + 1] = src[i * c + (c > 1 ? 1 : 0)] * scale;
      rgba[i * 4 + 2] = src[i * c + (c > 1 ? 2 : 0)] * scale;
      rgba[i * 4 + 3] = c === 4 ? src[i * c + 3] * scale : 255;
    }
    // Rows are kept as-is: for flipY textures (e.g. TGA) the loader already stores them
    // top-down, and for non-flipY ones the UVs are flipped instead, like other textures.
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  } else {
    ctx.drawImage(img, 0, 0);
  }
  return canvasToPng(canvas);
}

/**
 * Exports a three.js scene to Wavefront OBJ + MTL + texture files.
 * Returns { files: { [name]: Uint8Array | string }, warnings: string[] }.
 *
 * - Geometry is baked into world space (including the current skinned/morphed pose),
 *   so the result looks the same as the preview.
 * - Multi-material meshes are split with `usemtl` per group.
 * - Textures are written next to the OBJ and referenced by relative file name,
 *   which is what Unity's OBJ importer expects.
 */
export async function exportOBJ(root, { baseName = 'model', uvFlipY = true, resolver } = {}) {
  root.updateMatrixWorld(true);
  const warnings = [];
  const usedFiles = new Set([`${baseName}.obj`, `${baseName}.mtl`].map((s) => s.toLowerCase()));
  const files = {};

  // ---- materials & textures ----
  const materialNames = new Map(); // material -> mtl name
  const usedMatNames = new Set();
  const textureFiles = new Map(); // texture.image -> file name (or null if failed)
  const mtl = [`# Exported by 3D File Converter`, ''];

  async function textureFile(tex, hint) {
    if (!tex) return null;
    const key = tex.image ?? tex;
    if (textureFiles.has(key)) return textureFiles.get(key);
    let name = null;
    // Prefer the original uploaded file when the image came straight from it.
    const src = tex.image?.currentSrc || tex.image?.src;
    const refName = textureUrls.has(tex) ? fileBase(decodeURIComponent(textureUrls.get(tex).split(/[?#]/)[0])) : null;
    const original = textureSources.get(tex)
      ?? (src && resolver?.urlToFile.get(src))
      ?? (refName && resolver?.byName.get(refName.toLowerCase())?.file);
    if (original && textureFiles.has(original)) {
      name = textureFiles.get(original);
    } else if (original && UNITY_IMAGE_EXTS.includes(original.ext)) {
      name = uniqueName(`textures/${safeName(original.name, 'texture.png')}`, usedFiles);
      files[name] = original.data;
      textureFiles.set(original, name);
    } else {
      const png = await textureToPng(tex);
      if (png) {
        const base = safeName(stripExt(original?.name || tex.name || hint), 'texture');
        name = uniqueName(`textures/${base}.png`, usedFiles);
        files[name] = png;
      } else if (refName && !tex.image) {
        // The texture file was never supplied; keep the reference so it can be added later.
        name = `textures/${safeName(refName, 'texture.png')}`;
      } else {
        warnings.push(`Could not export texture "${tex.name || hint}" (unsupported image format).`);
      }
    }
    textureFiles.set(key, name);
    return name;
  }

  async function materialName(mat) {
    if (!mat) mat = DEFAULT_MATERIAL;
    if (materialNames.has(mat)) return materialNames.get(mat);
    const name = uniqueName(safeName(mat.name, `material_${materialNames.size}`), usedMatNames);
    materialNames.set(mat, name);

    const lines = [`newmtl ${name}`];
    const color = mat.color ? mat.color.clone().convertLinearToSRGB() : new THREE.Color(1, 1, 1);
    const rough = mat.roughness ?? (mat.shininess !== undefined ? 1 - Math.min(mat.shininess / 100, 1) : 0.8);
    const spec = mat.specular ? mat.specular.clone().convertLinearToSRGB() : new THREE.Color().setScalar(mat.metalness ? 0.5 + 0.5 * mat.metalness : 0.25 * (1 - rough));
    lines.push(`Ka 0 0 0`);
    lines.push(`Kd ${num(color.r)} ${num(color.g)} ${num(color.b)}`);
    lines.push(`Ks ${num(spec.r)} ${num(spec.g)} ${num(spec.b)}`);
    lines.push(`Ns ${num(mat.shininess ?? Math.max(1, (1 - rough) ** 2 * 1000))}`);
    if (mat.emissive && (mat.emissive.r || mat.emissive.g || mat.emissive.b)) {
      const e = mat.emissive.clone().convertLinearToSRGB();
      lines.push(`Ke ${num(e.r)} ${num(e.g)} ${num(e.b)}`);
    }
    const opacity = mat.transparent || mat.opacity < 1 ? mat.opacity : 1;
    lines.push(`d ${num(opacity)}`);
    lines.push(`illum ${opacity < 1 ? 4 : 2}`);

    const maps = [
      ['map_Kd', mat.map, 'diffuse'],
      ['map_Ks', mat.specularMap, 'specular'],
      ['map_Ke', mat.emissiveMap, 'emissive'],
      ['map_d', mat.alphaMap, 'alpha'],
      ['map_Bump', mat.normalMap || mat.bumpMap, 'normal'],
    ];
    for (const [key, tex, kind] of maps) {
      const file = await textureFile(tex, `${name}_${kind}`);
      if (file) lines.push(`${key} ${file}`);
    }
    mtl.push(...lines, '');
    return name;
  }

  // ---- geometry ----
  const obj = [`# Exported by 3D File Converter`, `mtllib ${baseName}.mtl`, ''];
  let vOffset = 1;
  let vtOffset = 1;
  let vnOffset = 1;
  const usedObjNames = new Set();
  let skipped = 0;

  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.visible !== false) meshes.push(o);
    else if (o.isPoints || o.isLine) skipped++;
  });

  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  const instMatrix = new THREE.Matrix4();
  const world = new THREE.Matrix4();

  for (const mesh of meshes) {
    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    if (!pos) continue;
    const uv = geom.attributes.uv;
    const normal = geom.attributes.normal;
    const index = geom.index;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const flipV = (() => {
      const m = mats.find((x) => x?.map);
      return m ? m.map.flipY === false : !uvFlipY;
    })();
    const instances = mesh.isInstancedMesh ? mesh.count : 1;

    for (let inst = 0; inst < instances; inst++) {
      world.copy(mesh.matrixWorld);
      if (mesh.isInstancedMesh) {
        mesh.getMatrixAt(inst, instMatrix);
        world.multiply(instMatrix);
      }
      normalMatrix.getNormalMatrix(world);
      const flipWinding = world.determinant() < 0;

      const name = uniqueName(safeName(mesh.name || mesh.parent?.name, 'mesh'), usedObjNames);
      obj.push(`o ${name}`);

      const out = [];
      for (let i = 0; i < pos.count; i++) {
        mesh.getVertexPosition(i, v); // applies morph targets & skinning
        v.applyMatrix4(world);
        out.push(`v ${num(v.x)} ${num(v.y)} ${num(v.z)}`);
      }
      if (uv) {
        for (let i = 0; i < uv.count; i++) {
          const y = uv.getY(i);
          out.push(`vt ${num(uv.getX(i))} ${num(flipV ? 1 - y : y)}`);
        }
      }
      if (normal) {
        for (let i = 0; i < normal.count; i++) {
          n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
          if (flipWinding) n.negate();
          out.push(`vn ${num(n.x)} ${num(n.y)} ${num(n.z)}`);
        }
      }
      obj.push(out.join('\n'));

      const count = index ? index.count : pos.count;
      const groups = geom.groups.length ? geom.groups : [{ start: 0, count, materialIndex: 0 }];
      for (const group of groups) {
        const mName = await materialName(mats[group.materialIndex ?? 0] ?? mats[0]);
        obj.push(`usemtl ${mName}`);
        const faces = [];
        const end = Math.min(group.start + group.count, count);
        for (let i = group.start; i + 2 < end; i += 3) {
          let a = index ? index.getX(i) : i;
          let b = index ? index.getX(i + 1) : i + 1;
          let c = index ? index.getX(i + 2) : i + 2;
          if (flipWinding) [b, c] = [c, b];
          const f = (k) => {
            let s = `${k + vOffset}`;
            if (uv || normal) s += `/${uv ? k + vtOffset : ''}`;
            if (normal) s += `/${k + vnOffset}`;
            return s;
          };
          faces.push(`f ${f(a)} ${f(b)} ${f(c)}`);
        }
        obj.push(faces.join('\n'));
      }
      obj.push('');
      vOffset += pos.count;
      if (uv) vtOffset += uv.count;
      if (normal) vnOffset += normal.count;
    }
  }

  if (skipped) warnings.push(`${skipped} point/line object(s) were skipped (OBJ export only includes meshes).`);
  files[`${baseName}.obj`] = obj.join('\n');
  files[`${baseName}.mtl`] = mtl.join('\n');
  return { files, warnings };
}

const DEFAULT_MATERIAL = new THREE.MeshStandardMaterial({ name: 'default', color: 0xcccccc });
