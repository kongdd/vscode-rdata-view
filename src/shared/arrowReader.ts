import { CompressionType, compressionRegistry, DataType, tableFromIPC } from 'apache-arrow';
import type { CellValue, InferredType } from './schema.js';
import { decompress as decompressLz4 } from 'lz4js';
import { decompress as decompressZstd } from 'fzstd';

// Feather V2 (including R's write_feather defaults) uses compressed Arrow IPC.
compressionRegistry.set(CompressionType.LZ4_FRAME, { decode: decompressLz4 });
compressionRegistry.set(CompressionType.ZSTD, {
  // fzstd may return an unaligned subarray; Arrow constructs typed views.
  decode: bytes => decompressZstd(bytes).slice(),
});

export function readArrowIPC(bytes: Uint8Array) {
  return tableFromIPC(bytes);
}

export function arrowTypeToInferred(type: DataType): InferredType {
  if (DataType.isInt(type) || DataType.isFloat(type) || DataType.isDecimal(type)) return 'number';
  if (DataType.isBool(type)) return 'boolean';
  if (DataType.isDate(type) || DataType.isTimestamp(type) || DataType.isTime(type)) return 'date';
  return 'string';
}

export function coerceArrowValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  // Arrow proxies / typed arrays may expose their scalar value through valueOf.
  const primitive = typeof value.valueOf === 'function' ? value.valueOf() : value;
  if (typeof primitive === 'bigint') return Number.isSafeInteger(Number(primitive)) ? Number(primitive) : String(primitive);
  if (typeof primitive === 'boolean' || typeof primitive === 'number' || typeof primitive === 'string') return primitive;
  return JSON.stringify(value);
}
