const fs = require("fs");
const path = require("path");

const S3_BUCKET = process.env.S3_BUCKET;
const isS3Enabled = !!S3_BUCKET;

let s3Client = null;
if (isS3Enabled) {
  const { S3Client } = require("@aws-sdk/client-s3");
  s3Client = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    // Supports S3-compatible services too (Cloudflare R2, MinIO, etc.)
    // via S3_ENDPOINT — leave unset for real AWS S3.
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
  });
  console.log(`[storage] S3_BUCKET set — projects are stored in s3://${S3_BUCKET}/`);
} else {
  console.log("[storage] No S3_BUCKET set — using local disk (fine for local dev and small deployments).");
}

const STORAGE_PREFIX = "s3://"; // marks a project's storage_path as an S3 reference rather than a real local path

function s3KeyPrefix(projectId) {
  return `projects/${projectId}/`;
}

/** Walks a local directory recursively and uploads every file to S3 under the given key prefix. */
async function uploadDirToS3(localDir, keyPrefix) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  })(localDir);

  for (const filePath of files) {
    const relKey = path.relative(localDir, filePath).replace(/\\/g, "/");
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: keyPrefix + relKey,
      Body: fs.readFileSync(filePath),
    }));
  }
  return files.length;
}

/** Downloads every object under a key prefix into a local directory, recreating the relative structure. */
async function downloadPrefixFromS3(keyPrefix, localDir) {
  const { ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
  fs.mkdirSync(localDir, { recursive: true });

  let continuationToken;
  let count = 0;
  do {
    const listResp = await s3Client.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: keyPrefix,
      ContinuationToken: continuationToken,
    }));

    for (const obj of listResp.Contents || []) {
      const relKey = obj.Key.slice(keyPrefix.length);
      if (!relKey) continue; // the "directory marker" object itself, if any
      const localPath = path.join(localDir, relKey);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });

      const getResp = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
      const bytes = await getResp.Body.transformToByteArray();
      fs.writeFileSync(localPath, Buffer.from(bytes));
      count++;
    }
    continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
  } while (continuationToken);

  return count;
}

/** Deletes every object under a key prefix — used when a project is deleted. */
async function deleteS3Prefix(keyPrefix) {
  const { ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
  let continuationToken;
  do {
    const listResp = await s3Client.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: keyPrefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (listResp.Contents || []).map(o => ({ Key: o.Key }));
    if (objects.length > 0) {
      await s3Client.send(new DeleteObjectsCommand({ Bucket: S3_BUCKET, Delete: { Objects: objects } }));
    }
    continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * After a zip is extracted to a local scratch directory, this either:
 *   - leaves it exactly where it is and returns that real local path (S3 off), or
 *   - uploads everything to S3, deletes the local scratch copy, and returns
 *     an "s3://bucket/prefix" reference string to store as storage_path.
 */
async function persistUpload(localScratchDir, projectId) {
  if (!isS3Enabled) return localScratchDir;

  const keyPrefix = s3KeyPrefix(projectId);
  await uploadDirToS3(localScratchDir, keyPrefix);
  fs.rmSync(localScratchDir, { recursive: true, force: true });
  return STORAGE_PREFIX + S3_BUCKET + "/" + keyPrefix;
}

function isS3Reference(storagePath) {
  return typeof storagePath === "string" && storagePath.startsWith(STORAGE_PREFIX);
}

function s3ReferenceToPrefix(storagePath) {
  // "s3://bucket/projects/<id>/" -> "projects/<id>/"
  const withoutScheme = storagePath.slice(STORAGE_PREFIX.length);
  const firstSlash = withoutScheme.indexOf("/");
  return withoutScheme.slice(firstSlash + 1);
}

/**
 * Materializes a project's files to a local directory regardless of
 * backend — if storage_path is already a real local path, returns it
 * unchanged; if it's an S3 reference, downloads everything to localDir
 * first. Used by the pipeline runner and by download/zip endpoints so
 * step logic and archiver never need to know which backend is active.
 */
async function materializeToLocal(storagePath, localDir) {
  if (!isS3Reference(storagePath)) return storagePath; // already local, nothing to do
  await downloadPrefixFromS3(s3ReferenceToPrefix(storagePath), localDir);
  return localDir;
}

async function deleteProjectStorage(storagePath) {
  if (isS3Reference(storagePath)) {
    await deleteS3Prefix(s3ReferenceToPrefix(storagePath));
  } else if (fs.existsSync(storagePath)) {
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
}

module.exports = {
  isS3Enabled,
  s3KeyPrefix,
  persistUpload,
  isS3Reference,
  materializeToLocal,
  deleteProjectStorage,
};
