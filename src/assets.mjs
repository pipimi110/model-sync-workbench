import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';

export function inspect3mf(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 1024 ** 3 || stat.size < 22) throw new Error('3MF 文件为空、不是普通文件或超过 1GB');
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  if (entries.length > 20000) throw new Error('3MF 条目数量异常');
  const geometry = entries.filter(e => /\.model$/i.test(e.entryName) && e.header.size > 0);
  if (!geometry.length) throw new Error('3MF 中没有非空模型几何文件');
  const parameters = {};
  for (const e of entries.filter(e => /(?:project_settings|slice_info|model_settings).*\.(?:json|config)$/i.test(e.entryName))) {
    if (e.header.size > 8 * 1024 ** 2) continue;
    try {
      const data = JSON.parse(e.getData().toString('utf8'));
      for (const key of ['layer_height', 'nozzle_diameter', 'wall_loops', 'sparse_infill_density', 'print_settings_id', 'printer_settings_id'])
        if (data[key] !== undefined) parameters[key] = data[key];
    } catch { /* XML/config variants are left unknown rather than guessed. */ }
  }
  return { geometryCount: geometry.length, plateImages: entries.filter(e => /(?:^|\/)plate_\d+\.png$/i.test(e.entryName)).length, parameters };
}
export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  throw new Error('不支持的图片内容（可能下载到错误页面）');
}
export function ingestFile(root, modelId, sourcePath, kind, role = 'unknown') {
  const real = fs.realpathSync(sourcePath), stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > 1024 ** 3) throw new Error('文件无效或超过 1GB');
  const bytes = fs.readFileSync(real);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const analysis = kind === 'model' ? inspect3mf(real) : { mime: imageMime(bytes) };
  if (kind === 'image' && stat.size > 20 * 1024 ** 2) throw new Error('图片超过 20MB，请先调整大小');
  const ext = kind === 'model' ? '.3mf' : ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[analysis.mime];
  const dir = path.join(root, 'library', modelId);
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, sha256 + ext);
  if (!fs.existsSync(destination)) fs.copyFileSync(real, destination);
  return { id: randomUUID(), name: path.basename(real), path: destination, sha256, bytes: stat.size, role, ...analysis };
}
