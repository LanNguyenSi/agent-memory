export interface MemoryFile {
  path: string;
  filename: string;
  date: Date;
  content: string;
  size: number;
}

export interface ScanOptions {
  directory: string;
  pattern?: string;
  daysBack?: number;
  recursive?: boolean;
}

export interface ScanResult {
  files: MemoryFile[];
  totalScanned: number;
  totalMatched: number;
  errors: string[];
}
