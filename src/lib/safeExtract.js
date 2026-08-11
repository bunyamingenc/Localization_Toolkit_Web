const fs = require("fs");
const path = require("path");
const unzipper = require("unzipper");

/**
 * Extracts a zip file to destDir, rejecting any entry whose resolved path
 * would land outside destDir — the classic "zip-slip" attack, where a zip
 * entry named e.g. "../../etc/passthrough" is crafted to escape the
 * intended extraction folder and overwrite arbitrary files on the server.
 *
 * unzipper's built-in Extract() does not guarantee this on its own, so we
 * walk entries ourselves and validate each one before writing.
 */
async function safeExtract(zipFilePath, destDir) {
  const directory = await unzipper.Open.file(zipFilePath);
  fs.mkdirSync(destDir, { recursive: true });
  const destReal = path.resolve(destDir);

  for (const entry of directory.files) {
    const targetPath = path.resolve(destDir, entry.path);

    // Every extracted path must stay inside destDir. path.resolve collapses
    // ".." segments, so this catches traversal regardless of how it's encoded.
    if (targetPath !== destReal && !targetPath.startsWith(destReal + path.sep)) {
      throw new Error(`Rejected unsafe zip entry (path traversal attempt): ${entry.path}`);
    }

    if (entry.type === "Directory") {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await new Promise((resolve, reject) => {
      entry.stream()
        .pipe(fs.createWriteStream(targetPath))
        .on("finish", resolve)
        .on("error", reject);
    });
  }
}

module.exports = { safeExtract };
