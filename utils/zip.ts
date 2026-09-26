const encoder = new TextEncoder();

const crcTables = Array.from({ length: 8 }, () => new Uint32Array(256));
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTables[0][n] = value >>> 0;
  for (let table = 1; table < 8; table++) {
    value = crcTables[0][value & 0xff] ^ (value >>> 8);
    crcTables[table][n] = value >>> 0;
  }
}

function updateCrc(crc: number, bytes: Uint8Array) {
  let index = 0;
  for (; index + 8 <= bytes.length; index += 8) {
    const value = crc ^ (
      bytes[index] |
      (bytes[index + 1] << 8) |
      (bytes[index + 2] << 16) |
      (bytes[index + 3] << 24)
    );
    crc = crcTables[7][value & 0xff] ^
      crcTables[6][(value >>> 8) & 0xff] ^
      crcTables[5][(value >>> 16) & 0xff] ^
      crcTables[4][value >>> 24] ^
      crcTables[3][bytes[index + 4]] ^
      crcTables[2][bytes[index + 5]] ^
      crcTables[1][bytes[index + 6]] ^
      crcTables[0][bytes[index + 7]];
  }
  for (; index < bytes.length; index++)
    crc = crcTables[0][(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

function header(size: number, signature: number) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  return { bytes, view };
}

function localHeader(name: Uint8Array) {
  const { bytes, view } = header(30 + name.length, 0x04034b50);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0808, true); // data descriptor and UTF-8 filename
  view.setUint16(8, 0, true); // stored without compression
  view.setUint16(12, 0x21, true); // 1980-01-01
  view.setUint16(26, name.length, true);
  bytes.set(name, 30);
  return bytes;
}

function dataDescriptor(crc: number, size: number) {
  const { bytes, view } = header(16, 0x08074b50);
  view.setUint32(4, crc, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  return bytes;
}

function centralHeader(
  name: Uint8Array,
  crc: number,
  size: number,
  offset: number
) {
  const { bytes, view } = header(46 + name.length, 0x02014b50);
  view.setUint16(4, 0x0314, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0808, true);
  view.setUint16(10, 0, true);
  view.setUint16(14, 0x21, true); // 1980-01-01
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint32(42, offset, true);
  bytes.set(name, 46);
  return bytes;
}

function endRecord(count: number, size: number, offset: number) {
  const { bytes, view } = header(22, 0x06054b50);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return bytes;
}

export async function* streamZip(
  entries: Array<{ key: string; name: string; size: number }>,
  getBody: (key: string) => Promise<ReadableStream<Uint8Array>>
) {
  let offset = 0;
  const directory: Uint8Array[] = [];
  let directorySize = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const start = offset;
    const first = localHeader(name);
    offset += first.length;
    yield first;

    const reader = (await getBody(entry.key)).getReader();
    let crc = 0xffffffff;
    let size = 0;
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }
        if (size + value.byteLength > 0xffffffff)
          throw new Error("单个文件超过 ZIP 格式限制");
        crc = updateCrc(crc, value);
        size += value.byteLength;
        offset += value.byteLength;
        yield value;
      }
    } finally {
      try {
        if (!completed) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    if (size !== entry.size) throw new Error(`文件大小已变化：${entry.key}`);

    const descriptor = dataDescriptor(crc, size);
    offset += descriptor.length;
    yield descriptor;

    const central = centralHeader(name, crc, size, start);
    directory.push(central);
    directorySize += central.length;
  }

  const directoryOffset = offset;
  for (const record of directory) yield record;
  yield endRecord(directory.length, directorySize, directoryOffset);
}
