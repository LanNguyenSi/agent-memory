const { existsSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const {
  collectLocalSyncFiles,
  mapRemotePathToLocalAbsolute,
  normalizeRemoteRelativePath
} = require("./config");
const { GitClient } = require("./git-client");
const { mergeText } = require("./merge");
const { StateStore } = require("./state-store");

interface PullOptions {
  dryRun: boolean;
}

async function performPull(config: {
  profile: string;
  stateDir: string;
  rootDir: string;
  repositorySubdir: string;
  conflictStrategy: "inline-markers" | "local-wins" | "remote-wins";
  remoteUrl: string;
  branch: string;
  gitBinary: string;
  syncPaths: Array<{
    source: string;
    destination?: string;
    kind?: "file" | "directory";
    required?: boolean;
  }>;
}, options: PullOptions) {
  const stateStore = new StateStore(config.stateDir, config.profile);
  stateStore.ensure();

  const gitClient = new GitClient(config.gitBinary);
  const workingCopy = gitClient.prepareWorkingCopy(
    config.remoteUrl,
    config.branch,
    gitClient.createTempRepoDir(config.stateDir, "pull")
  );

  const localFiles = collectLocalSyncFiles(config);
  const localMap = Object.fromEntries(
    localFiles.map((file: { remoteRelativePath: string; content: string }) => [
      file.remoteRelativePath,
      file.content
    ])
  );
  const baseMap = stateStore.readBaseSnapshots();
  const remoteMap = collectRemoteFiles(config, gitClient, workingCopy.repoDir);
  const targetPaths = new Set<string>([
    ...Object.keys(localMap),
    ...Object.keys(baseMap),
    ...Object.keys(remoteMap)
  ]);

  const changedFiles: string[] = [];
  const mergedFiles: string[] = [];
  const conflictFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const remoteRelativePath of Array.from(targetPaths).sort()) {
    const mergeResult = mergeText({
      base: readSnapshotValue(baseMap, remoteRelativePath),
      local: readSnapshotValue(localMap, remoteRelativePath),
      remote: readSnapshotValue(remoteMap, remoteRelativePath),
      strategy: config.conflictStrategy
    });

    if (mergeResult.status === "merged") {
      mergedFiles.push(remoteRelativePath);
    }
    if (mergeResult.conflict) {
      conflictFiles.push(remoteRelativePath);
    }

    const currentLocalValue = readSnapshotValue(localMap, remoteRelativePath);
    if (mergeResult.content === currentLocalValue) {
      continue;
    }

    changedFiles.push(remoteRelativePath);
    const localAbsolutePath = mapRemotePathToLocalAbsolute(config, remoteRelativePath);
    if (!localAbsolutePath) {
      continue;
    }

    if (options.dryRun) {
      if (mergeResult.content === null) {
        deletedFiles.push(remoteRelativePath);
      }
      continue;
    }

    if (mergeResult.content === null) {
      rmSync(localAbsolutePath, { force: true });
      deletedFiles.push(remoteRelativePath);
      continue;
    }

    mkdirSync(path.dirname(localAbsolutePath), { recursive: true });
    writeFileSync(localAbsolutePath, mergeResult.content, "utf8");
  }

  if (!options.dryRun) {
    const remoteHeadAfter = workingCopy.remoteHead ? gitClient.revParseHead(workingCopy.repoDir) : null;
    const state = stateStore.loadState();
    state.lastRemoteHead = remoteHeadAfter;
    state.lastRunAt = new Date().toISOString();
    stateStore.replaceBaseSnapshots(remoteMap);
    stateStore.saveState(state);
    stateStore.clearTemp();

    return {
      kind: "pull",
      status: "applied",
      remoteHeadBefore: workingCopy.remoteHead,
      remoteHeadAfter,
      appliedFiles: changedFiles,
      mergedFiles,
      conflictFiles,
      deletedFiles,
      notes: []
    };
  }

  return {
    kind: "pull",
    status: "dry-run",
    remoteHeadBefore: workingCopy.remoteHead,
    remoteHeadAfter: workingCopy.remoteHead,
    appliedFiles: changedFiles,
    mergedFiles,
    conflictFiles,
    deletedFiles,
    notes: []
  };
}

function collectRemoteFiles(
  config: { repositorySubdir: string },
  gitClient: InstanceType<typeof GitClient>,
  repoDir: string
): Record<string, string | null> {
  const repoRelativeFiles = gitClient.listFiles(repoDir, config.repositorySubdir);
  const result: Record<string, string | null> = {};

  for (const repoRelativeFile of repoRelativeFiles) {
    if (!repoRelativeFile.startsWith(`${config.repositorySubdir}/`)) {
      continue;
    }

    const remoteRelativePath = normalizeRemoteRelativePath(
      repoRelativeFile.slice(config.repositorySubdir.length + 1)
    );
    result[remoteRelativePath] = gitClient.readFile(repoDir, repoRelativeFile);
  }

  return result;
}

function readSnapshotValue(source: Record<string, string | null>, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : null;
}

module.exports = {
  performPull
};
