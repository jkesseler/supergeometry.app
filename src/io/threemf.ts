// 3MF export (what slicers open): one mesh object per body, in millimetres,
// with the bodies' colours, plus the exact STEP model packed in the file as
// an attachment (slicers skip it; it travels with the print file).

export interface MeshBody {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** "#rrggbb" */
  color?: string;
}

const esc = (text: string) => text.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
const num = (value: number) => (Math.round(value * 1e5) / 1e5).toString();

function modelXml(bodies: MeshBody[], title: string): string {
  const colors = [...new Set(bodies.map(b => b.color).filter((color): color is string => !!color))];
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  out.push(`<metadata name="Title">${esc(title)}</metadata>`);
  out.push('<metadata name="Application">superGeometry.app</metadata>');
  out.push('<resources>');
  if (colors.length) {
    out.push('<basematerials id="1">');
    for (const color of colors) {
      out.push(`<base name="${esc(color)}" displaycolor="${esc(color.toUpperCase())}FF"/>`);
    }
    out.push('</basematerials>');
  }
  bodies.forEach((b, bodyIndex) => {
    const id = bodyIndex + 2;
    const ci = b.color ? colors.indexOf(b.color) : -1;
    out.push(`<object id="${id}" type="model" name="${esc(b.name)}"${ci >= 0 ? ` pid="1" pindex="${ci}"` : ''}><mesh><vertices>`);
    // Shared corners once (the display mesh repeats them per face).
    const map = new Map<string, number>();
    const remap: number[] = [];
    const positions = b.positions;
    for (let i = 0; i < positions.length / 3; i++) {
      const key = `${num(positions[3 * i])},${num(positions[3 * i + 1])},${num(positions[3 * i + 2])}`;
      let index = map.get(key);
      if (index === undefined) {
        index = map.size;
        map.set(key, index);
        out.push(`<vertex x="${num(positions[3 * i])}" y="${num(positions[3 * i + 1])}" z="${num(positions[3 * i + 2])}"/>`);
      }
      remap.push(index);
    }
    out.push('</vertices><triangles>');
    const ix = b.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const [a, indexB, indexC] = [remap[ix[t]], remap[ix[t + 1]], remap[ix[t + 2]]];
      if (a === indexB || indexB === indexC || a === indexC) {
        continue;
      } // collapsed by the shared corners
      out.push(`<triangle v1="${a}" v2="${indexB}" v3="${indexC}"/>`);
    }
    out.push('</triangles></mesh></object>');
  });
  out.push('</resources><build>');
  bodies.forEach((_, bodyIndex) => out.push(`<item objectid="${bodyIndex + 2}"/>`));
  out.push('</build></model>');

  return out.join('\n');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
<Default Extension="step" ContentType="application/step"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
<Relationship Target="/Attachments/model.step" Id="rel1" Type="http://schemas.supergeometry.app/2025/step"/>
</Relationships>`;

export async function exportThreeMF(bodies: MeshBody[], title: string, step: Blob): Promise<Blob> {
  const enc = new TextEncoder();

  return zip([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(RELS) },
    { name: '3D/3dmodel.model', data: enc.encode(modelXml(bodies, title)) },
    { name: 'Attachments/model.step', data: new Uint8Array(await step.arrayBuffer()) }
  ]);
}

// ------------------------------------------------------------- tiny zip

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let entry = 0; entry < 256; entry++) {
    let value = entry;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    t[entry] = value >>> 0;
  }

  return t;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/** Deflate when the browser can (much smaller meshes), else store. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') {
    return null;
  }
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));

    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** A ZIP archive (what 3MF is). */
export async function zip(files: { name: string; data: Uint8Array }[]): Promise<Blob> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const file of files) {
    const name = enc.encode(file.name);
    const crc = crc32(file.data);
    const packed = await deflate(file.data);
    const method = packed && packed.length < file.data.length ? 8 : 0;
    const body = method ? packed! : file.data;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, file.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(10, method, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, file.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const size = central.reduce((total, bytes) => total + bytes.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
}
