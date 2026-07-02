import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function readJsonArtifactTree(root, { maxArtifactBytes = 1024 * 1024 } = {}) {
  const artifacts = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const size = statSync(entryPath).size;
      if (size > maxArtifactBytes) {
        artifacts.push({ path: entryPath, skipped: true, reason: 'artifact_size_limit', size });
        continue;
      }

      artifacts.push({ path: entryPath, size, json: JSON.parse(readFileSync(entryPath, 'utf8')) });
    }
  };

  visit(root);
  return artifacts;
}

export function writeJsonArtifact(outputPath, payload) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function normalizeArtifactRootInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Artifact postprocess args.input must be an object');
  }
  if (input.type !== 'artifact-root') {
    throw new Error(`Unsupported artifact postprocess input type: ${input.type}`);
  }
  if (typeof input.path !== 'string' || input.path.trim() === '') {
    throw new Error('Artifact postprocess args.input.path must be a non-empty string');
  }
  if (!Array.isArray(input.artifact_globs) || input.artifact_globs.length === 0) {
    throw new Error('Artifact postprocess args.input.artifact_globs must be a non-empty array');
  }

  return {
    inputRoot: input.path,
    maxArtifactBytes: input.max_bytes ?? 1024 * 1024,
  };
}

export function normalizeJsonArtifactOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Artifact postprocess args.output must be an object');
  }
  for (const field of ['artifact', 'path', 'kind', 'contentType', 'schema', 'semantic_key']) {
    if (typeof output[field] !== 'string' || output[field].trim() === '') {
      throw new Error(`Artifact postprocess args.output.${field} must be a non-empty string`);
    }
  }
  if (output.kind !== 'json') {
    throw new Error(`Unsupported artifact postprocess output kind: ${output.kind}`);
  }
  if (output.contentType !== 'application/json') {
    throw new Error(`Unsupported artifact postprocess output contentType: ${output.contentType}`);
  }

  return {
    outputPath: output.path,
    outputSchema: output.schema,
  };
}
