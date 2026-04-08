const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");
const { CliError } = require("../errors");

interface SyncPathConfig {
  source: string;
  destination?: string;
  kind?: "file" | "directory";
  required?: boolean;
}

interface RunConfig {
  rootDir: string;
  repositorySubdir: string;
  syncPaths: SyncPathConfig[];
}

interface LocalSyncFile {
  absolutePath: string;
  localRelativePath: string;
  remoteRelativePath: string;
  content: string;
}

function collectLocalSyncFiles(config: RunConfig): LocalSyncFile[] {
  const results: LocalSyncFile[] = [];

  for (const entry of config.syncPaths) {
    const absoluteSource = resolveWorkspacePath(config.rootDir, entry.source);
    const destination = normalizeRemoteRelativePath(entry.destination || entry.source);
    const kind = resolveSyncPathKind(absoluteSource, entry);

    if (!existsSync(absoluteSource)) {
      if (entry.required) {
        throw new CliError(`required sync path '${entry.source}' does not exist.`, 4);
      }
      continue;
    }

    if (kind === "file") {
      results.push({
        absolutePath: absoluteSource,
        localRelativePath: normalizeLocalRelativePath(config.rootDir, absoluteSource),
        remoteRelativePath: destination,
        content: readFileSync(absoluteSource, "utf8")
      });
      continue;
    }

    for (const nestedFile of walkFiles(absoluteSource)) {
      const nestedRelative = path.relative(absoluteSource, nestedFile).replace(/\\/g, "/");
      results.push({
        absolutePath: nestedFile,
        localRelativePath: normalizeLocalRelativePath(config.rootDir, nestedFile),
        remoteRelativePath: path.posix.join(destination, nestedRelative),
        content: readFileSync(nestedFile, "utf8")
      });
    }
  }

  return results.sort((left, right) => left.remoteRelativePath.localeCompare(right.remoteRelativePath));
}

function mapRemotePathToLocalAbsolute(config: RunConfig, remoteRelativePath: string): string | null {
  const normalizedRemotePath = normalizeRemoteRelativePath(remoteRelativePath);

  for (const entry of config.syncPaths) {
    const absoluteSource = resolveWorkspacePath(config.rootDir, entry.source);
    const destination = normalizeRemoteRelativePath(entry.destination || entry.source);
    const kind = resolveSyncPathKind(absoluteSource, entry);

    if (kind === "file" && normalizedRemotePath === destination) {
      return absoluteSource;
    }

    if (
      kind === "directory" &&
      (normalizedRemotePath === destination || normalizedRemotePath.startsWith(`${destination}/`))
    ) {
      const relativeSuffix = normalizedRemotePath.slice(destination.length).replace(/^\/+/, "");
      return path.resolve(absoluteSource, relativeSuffix);
    }
  }

  return null;
}

function toRepositoryRelativePath(config: RunConfig, remoteRelativePath: string): string {
  return path.posix.join(config.repositorySubdir, normalizeRemoteRelativePath(remoteRelativePath));
}

function normalizeRemoteRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("..")) {
    throw new CliError(`sync destination '${value}' is invalid.`, 3);
  }
  return normalized;
}

function resolveWorkspacePath(rootDir: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(rootDir, candidate);
}

function normalizeLocalRelativePath(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).replace(/\\/g, "/");
}

function resolveSyncPathKind(absoluteSource: string, entry: SyncPathConfig): "file" | "directory" {
  if (entry.kind) {
    return entry.kind;
  }

  if (existsSync(absoluteSource)) {
    return statSync(absoluteSource).isDirectory() ? "directory" : "file";
  }

  return path.extname(entry.source) ? "file" : "directory";
}

function walkFiles(rootDir: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      results.push(absolutePath);
    }
  }

  return results;
}

module.exports = {
  collectLocalSyncFiles,
  mapRemotePathToLocalAbsolute,
  normalizeRemoteRelativePath,
  toRepositoryRelativePath
};
