export type CellValue = string | number | boolean | null;
export type InferredType = 'string' | 'number' | 'boolean' | 'date' | 'null';

export interface ColumnSchema {
  name: string;
  index: number;
  inferredType: InferredType;
  nullable: boolean;
}

export type FilterOp = 'eq' | 'neq' | 'contains' | 'not_contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'regex' | 'is_null' | 'is_not_null';
export interface FilterSpec { colIndex: number; op: FilterOp; value: string | number }
export interface SortSpec { colIndex: number; direction: 'asc' | 'desc' }
