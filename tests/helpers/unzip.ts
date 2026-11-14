// Читатель ZIP (только stored) по центральному каталогу — для проверки генератора xlsx.
export interface Unzipped { name: string; data: Uint8Array; crc: number; flags: number; offset: number }

export function unzip(buf: Uint8Array): Unzipped[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  if (dv.getUint32(eocd, true) !== 0x06054b50) throw new Error('нет EOCD');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p + cdSize !== eocd) throw new Error('размер центрального каталога не сходится');
  const out: Unzipped[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('битая запись каталога');
    const flags = dv.getUint16(p + 8, true);
    if (dv.getUint16(p + 10, true) !== 0) throw new Error('ожидалось stored');
    const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(offset, true) !== 0x04034b50) throw new Error('битый локальный заголовок ' + name);
    const lName = dv.getUint16(offset + 26, true), lExtra = dv.getUint16(offset + 28, true);
    if (dv.getUint32(offset + 14, true) !== crc) throw new Error('crc в заголовках различается');
    const start = offset + 30 + lName + lExtra;
    out.push({ name, data: buf.slice(start, start + size), crc, flags, offset });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
