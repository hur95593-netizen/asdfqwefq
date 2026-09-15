import * as vscode from 'vscode';
import { RetentionPolicy } from '../storage/types';

export interface LocalHistoryConfig {
  enabled: boolean;
  onSave: boolean;
  onPause: boolean;
  onClose: boolean;
  onExternalChange: boolean;
  debounceMs: number;
  mergeWindowMs: number;
  retention: RetentionPolicy;
  largeFileThresholdBytes: number;
  maxFileSizeBytes: number;
  exclude: string[];
  storageDirName: string;
  addToGitignore: boolean;
  keepBackupBeforeRestore: boolean;
  confirmRestore: boolean;
  searchMaxVersions: number;
  encryptionEnabled: boolean;
}

export const SECTION = 'localHistory';

export function readConfig(scope?: vscode.Uri): LocalHistoryConfig {
  const c = vscode.workspace.getConfiguration(SECTION, scope ?? undefined);
  const storageDirName = (c.get<string>('storageDirName') || '.local-history').replace(
    /^[\\/]+|[\\/]+$/g,
    '',
  );
  return {
    enabled: c.get<boolean>('enabled', true),
    onSave: c.get<boolean>('trigger.onSave', true),
    onPause: c.get<boolean>('trigger.onPause', true),
    onClose: c.get<boolean>('trigger.onClose', true),
    onExternalChange: c.get<boolean>('trigger.onExternalChange', true),
    debounceMs: Math.max(1, c.get<number>('debounceSeconds', 3)) * 1000,
    mergeWindowMs: Math.max(0, c.get<number>('mergeWindowSeconds', 5)) * 1000,
    retention: {
      maxVersionsPerFile: Math.max(1, c.get<number>('maxVersionsPerFile', 100)),
      maxAgeDays: Math.max(0, c.get<number>('maxAgeDays', 30)),
      maxTotalSizeMB: Math.max(0, c.get<number>('maxTotalSizeMB', 500)),
    },
    largeFileThresholdBytes: Math.max(1, c.get<number>('largeFileThresholdKB', 1024)) * 1024,
    maxFileSizeBytes: Math.max(0, c.get<number>('maxFileSizeMB', 16)) * 1024 * 1024,
    exclude: c.get<string[]>('exclude', []),
    storageDirName: storageDirName || '.local-history',
    addToGitignore: c.get<boolean>('addToGitignore', true),
    keepBackupBeforeRestore: c.get<boolean>('keepBackupBeforeRestore', true),
    confirmRestore: c.get<boolean>('confirmRestore', true),
    searchMaxVersions: Math.max(1, c.get<number>('searchMaxVersions', 300)),
    encryptionEnabled: c.get<boolean>('encryption.enabled', false),
  };
}
