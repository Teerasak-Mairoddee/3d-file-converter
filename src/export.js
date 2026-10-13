import { zipSync, strToU8 } from 'fflate';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { PLYExporter } from 'three/addons/exporters/PLYExporter.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { exportOBJ } from './objExport.js';

export const OUTPUT_FORMATS = [
  { id: 'obj', label: 'OBJ + MTL + textures (.zip) — best for Unity' },
  { id: 'glb', label: 'GLB (binary glTF, single file)' },
  { id: 'gltf', label: 'glTF (.gltf, embedded)' },
  { id: 'stl', label: 'STL (binary, geometry only)' },
  { id: 'ply', label: 'PLY (binary, geometry + vertex colors)' },
  { id: 'usdz', label: 'USDZ (Apple AR Quick Look)' },
];

function toU8(content) {
  if (content instanceof Uint8Array) return content;
  if (typeof content === 'string') return strToU8(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  throw new Error('Unexpected export output');
}

/**
 * Converts `root` to the chosen format.
 * Returns { blob, filename, warnings }.
 */
export async function convert(root, format, { baseName, animations = [], uvFlipY, resolver }) {
  root.updateMatrixWorld(true);
  const warnings = [];
  switch (format) {
    case 'obj': {
      const res = await exportOBJ(root, { baseName, uvFlipY, resolver });
      warnings.push(...res.warnings);
      if (animations.length) warnings.push('OBJ has no animation support; the model was exported in its rest pose.');
      const entries = {};
      for (const [name, content] of Object.entries(res.files)) entries[`${baseName}/${name}`] = toU8(content);
      const zip = zipSync(entries, { level: 6 });
      return { blob: new Blob([zip], { type: 'application/zip' }), filename: `${baseName}_obj.zip`, warnings };
    }
    case 'glb':
    case 'gltf': {
      const binary = format === 'glb';
      const result = await new GLTFExporter().parseAsync(root, { binary, animations, onlyVisible: true });
      const blob = binary
        ? new Blob([result], { type: 'model/gltf-binary' })
        : new Blob([JSON.stringify(result)], { type: 'model/gltf+json' });
      return { blob, filename: `${baseName}.${format}`, warnings };
    }
    case 'stl': {
      const data = new STLExporter().parse(root, { binary: true });
      return { blob: new Blob([data], { type: 'model/stl' }), filename: `${baseName}.stl`, warnings: ['STL stores geometry only; materials and textures are not included.'] };
    }
    case 'ply': {
      const data = await new Promise((resolve) => new PLYExporter().parse(root, resolve, { binary: true }));
      return { blob: new Blob([data], { type: 'application/octet-stream' }), filename: `${baseName}.ply`, warnings: ['PLY stores geometry and vertex colors only; textures are not included.'] };
    }
    case 'usdz': {
      const data = await new USDZExporter().parseAsync(root);
      return { blob: new Blob([data], { type: 'model/vnd.usdz+zip' }), filename: `${baseName}.usdz`, warnings };
    }
    default:
      throw new Error(`Unknown format ${format}`);
  }
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
