const { collectLocalSyncFiles, toRepositoryRelativePath } = require("./config");
const { GitClient } = require("./git-client");

// Structural subset of RunConfig in src/config/loader.ts. Keep in sync if RunConfig drifts.
interface SnapshotConfig {
  rootDir: string;
  stateDir: string;
  repositorySubdir: string;
  remoteUrl: string;
  branch: string;
  gitBinary: string;
  syncPaths: Array<{
    source: string;
    destination?: string;
    kind?: "file" | "directory";
    required?: boolean;
  }>;
}

interface SnapshotResult {
  status: "committed" | "no-changes";
  commitSha: string | null;
  addedOrChangedFiles: string[];
  deletedFiles: string[];
}

function commitAndPushSnapshot(config: SnapshotConfig, commitMessage: string): SnapshotResult {
  const gitClient = new GitClient(config.gitBinary);
  const workingCopy = gitClient.prepareWorkingCopy(
    config.remoteUrl,
    config.branch,
    gitClient.createTempRepoDir(config.stateDir, "watch")
  );

  const localFiles = collectLocalSyncFiles(config);
  const desiredRepoPaths = new Set<string>();
  const addedOrChangedFiles: string[] = [];

  for (const file of localFiles) {
    const repoRelativePath = toRepositoryRelativePath(config, file.remoteRelativePath);
    desiredRepoPaths.add(repoRelativePath);

    const existing = gitClient.readFile(workingCopy.repoDir, repoRelativePath);
    if (existing !== file.content) {
      gitClient.writeFile(workingCopy.repoDir, repoRelativePath, file.content);
      addedOrChangedFiles.push(file.remoteRelativePath);
    }
  }

  const deletedFiles: string[] = [];
  const existingRepoPaths = gitClient.listFiles(workingCopy.repoDir, config.repositorySubdir);
  for (const repoRelativePath of existingRepoPaths) {
    if (!repoRelativePath.startsWith(`${config.repositorySubdir}/`)) {
      continue;
    }
    if (desiredRepoPaths.has(repoRelativePath)) {
      continue;
    }

    gitClient.deleteFile(workingCopy.repoDir, repoRelativePath);
    deletedFiles.push(repoRelativePath.slice(config.repositorySubdir.length + 1));
  }

  const commitSha = gitClient.commitAll(workingCopy.repoDir, commitMessage);
  if (!commitSha) {
    return {
      status: "no-changes",
      commitSha: null,
      addedOrChangedFiles: [],
      deletedFiles: []
    };
  }

  gitClient.push(workingCopy.repoDir, config.branch);

  return {
    status: "committed",
    commitSha,
    addedOrChangedFiles: addedOrChangedFiles.sort(),
    deletedFiles: deletedFiles.sort()
  };
}

function buildCommitMessage(changedFiles: string[], deletedFiles: string[]): string {
  const all = Array.from(new Set([...changedFiles, ...deletedFiles])).sort();

  if (all.length === 0) {
    return "snapshot: noop";
  }

  if (all.length === 1) {
    const isDelete = deletedFiles.includes(all[0]);
    return `${isDelete ? "remove" : "update"} ${all[0]}`;
  }

  const bullets = all
    .map((file) => (deletedFiles.includes(file) ? `- remove ${file}` : `- update ${file}`))
    .join("\n");

  return `update ${all.length} memories\n\n${bullets}`;
}

module.exports = {
  commitAndPushSnapshot,
  buildCommitMessage
};
