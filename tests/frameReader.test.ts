import { expect, it } from 'vitest';
import { createFrameReader } from './frameReader.js';

const frame = (payload: Buffer) => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
};
async function* source(chunks: Buffer[]) { yield* chunks; }

it.each([1, 2, 3, 7, 1024])('reads split/coalesced binary frames with %i-byte chunks', async size => {
  const payloads = [Buffer.from('中文\n'), Buffer.from([0, 255, 10, 13, 128]), Buffer.alloc(0)];
  const bytes = Buffer.concat(payloads.map(frame));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  const read = createFrameReader(source(chunks));
  for (const payload of payloads) expect(await read()).toEqual(payload);
});

it.each([Buffer.from([3, 0]), Buffer.from([3, 0, 0, 0, 1, 2])])('rejects truncated frames (%j)', async bytes => {
  await expect(createFrameReader(source([bytes]))()).rejects.toThrow('Truncated');
});

it('rejects oversized frames before allocating their payload', async () => {
  await expect(createFrameReader(source([Buffer.from([255, 255, 255, 255])]))()).rejects.toThrow('256 MiB');
});
