/** 测试用长度帧读取器：4 字节小端长度 + 原始负载，兼容拆包/粘包。 */
export function createFrameReader(source: AsyncIterable<Buffer>) {
  const iterator = source[Symbol.asyncIterator]();
  let rest: Buffer = Buffer.alloc(0);
  const read = async (length: number): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let size = 0;
    while (size < length) {
      if (!rest.length) {
        const next = await iterator.next();
        if (next.done) throw new Error('Truncated R response');
        rest = next.value;
      }
      const take = Math.min(length - size, rest.length);
      chunks.push(rest.subarray(0, take));
      rest = rest.subarray(take);
      size += take;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  };
  return async (): Promise<Buffer> => {
    const length = (await read(4)).readUInt32LE(0);
    if (length > 256 * 1024 * 1024) throw new Error('R response exceeds 256 MiB');
    // 每个负载最多合并一次，不将二进制转字符串，也不反复拼接已有数据。
    return read(length);
  };
}
