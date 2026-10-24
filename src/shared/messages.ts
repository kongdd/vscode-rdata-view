import type { CellValue, ColumnSchema } from './schema.js';
import type { FileType } from './constants.js';

export interface InitPayload {
  fileType: FileType;
  fileName: string;
  totalRows: number;
  totalBytes: number;
  schema: ColumnSchema[];
  rows: CellValue[][];
  paged: boolean;
  choices: string[];
  selected: string;
  dplyrFilter?: string;
}

export type HostMessage =
  | { type: 'INIT'; payload: InitPayload }
  | { type: 'CHUNK'; payload: { requestId: string; rows: CellValue[][] } }
  | { type: 'DATA_VISIBILITY'; payload: { visible: boolean } }
  | { type: 'LOADING'; payload: { active: boolean; message?: string } }
  | { type: 'ERROR'; payload: { requestId?: string; message: string } }
  | { type: 'EXPORT_PROGRESS'; payload: { pct: number } }
  | { type: 'EXPORT_DONE'; payload: { path?: string; error?: string } }
  | { type: 'QUERY_DONE'; payload: { error?: string } };

export type WebviewMessage =
  | { type: 'READY' }
  | { type: 'SELECT_TABLE'; payload: { name: string } }
  | { type: 'APPLY_DPLYR_FILTER'; payload: { expression: string } }
  | { type: 'PREPARE_R' }
  | { type: 'EXECUTE_R_QUERY'; payload: { code: string } }
  | { type: 'QUERY_CANCEL' }
  | { type: 'REQUEST_CHUNK'; payload: { requestId: string; startRow: number; endRow: number } }
  | { type: 'EXPORT'; payload: { order?: number[] } }
  | { type: 'EXPORT_CANCEL' }
  | { type: 'OPEN_EXTERNAL'; payload: { url: string } };
