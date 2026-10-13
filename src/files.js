import { unzipSync } from 'fflate';

// Formats we can try to open as a model, in the order we prefer them as the "main" file
// when several are uploaded together.
export const MODEL_EXTS = [
  'glb', 'gltf', 'fbx', 'obj', 'dae', '3ds', 'blend', 'usdz', 'usda', 'usdc', 'usd', '3mf', 'stl', 'ply',
  'wrl', 'vrml', 'amf', 'lwo', 'x', 'ase', 'ms3d', 'b3d', 'md2', 'md3', 'md5mesh', 'mdl', 'smd',
  'off', 'ac', 'ac3d', 'dxf', 'ifc', 'irrmesh', 'irr', 'lws', 'lxo', 'nff', 'cob', 'scn', 'xgl',
  'zgl', 'ogex', 'q3o', 'q3s', 'raw', 'ter', 'hmp', 'mesh', 'csm', 'bvh', 'x3d', 'x3db', 'm3d',
  'pmx', 'sib', 'vtk', 'vtp', 'xyz', 'pcd', 'kmz', 'vox',
];

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'tga', 'bmp', 'gif', 'webp', 'tif', 'tiff', 'dds', 'ktx2', 'psd', 'hdr', 'exr'];

// texture -> uploaded file it was decoded from (kept out of userData so exporters don't serialize it)
export const textureSources = new WeakMap();
// texture -> URL the model referenced it by (used to keep references to textures that were not supplied)
export const textureUrls = new WeakMap();

export function extOf(name) {
  const base = baseName(name);
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i + 1).toLowerCase();
}

export function baseName(path) {
  return path.split(/[\\/]/).pop();
}

export function stripExt(name) {
  const base = baseName(name);
  const i = base.lastIndexOf('.');
  return i < 0 ? base : base.slice(0, i);
}

/**
 * Turns dropped/selected files (including .zip archives) into a flat list of
 * { name, path, ext, data: Uint8Array }.
 */
export async function collectFiles(fileArray) {
  const out = [];
  for (const file of fileArray) {
    const path = file.webkitRelativePath || file.relativePath || file.name;
    const data = new Uint8Array(await file.arrayBuffer());
    if (extOf(file.name) === 'zip') {
      let entries;
      try {
        entries = unzipSync(data);
      } catch (e) {
        throw new Error(`Could not open ${file.name}: ${e.message}`);
      }
      for (const [entryPath, entryData] of Object.entries(entries)) {
        if (entryPath.endsWith('/') || entryPath.startsWith('__MACOSX') || baseName(entryPath).startsWith('._')) continue;
        if (extOf(entryPath) === 'zip') {
          // nested zips are common in store downloads
          const inner = await collectFiles([new File([entryData], baseName(entryPath))]);
          out.push(...inner);
          continue;
        }
        out.push(makeEntry(entryPath, entryData));
      }
    } else {
      out.push(makeEntry(path, data));
    }
  }
  return out;
}

function makeEntry(path, data) {
  const name = baseName(path);
  return { name, path, ext: extOf(name), data };
}

/** Model files in preference order. */
export function findModels(files) {
  const models = files.filter((f) => MODEL_EXTS.includes(f.ext));
  // A .bin next to a .gltf is a buffer, not a model; .mtl is never a model.
  return models.sort((a, b) => {
    const d = MODEL_EXTS.indexOf(a.ext) - MODEL_EXTS.indexOf(b.ext);
    return d !== 0 ? d : b.data.byteLength - a.data.byteLength;
  });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
