import path from 'node:path';

function artifactDirectory(output) {
  return output?.artifacts?.directory || output?.artifactsDir || '';
}

function artifactFiles(output) {
  const candidates = [
    output?.artifacts?.files,
    output?.artifacts?.manifest?.files,
    output?.manifest?.artifacts?.files,
    output?.manifest?.files,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === 'object') {
      return Object.entries(candidate).map(([name, value]) => (
        typeof value === 'string'
          ? { name, path: value }
          : { name, ...value }
      ));
    }
  }

  return [];
}

function normalizePathname(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function manifestEntryPath(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }

  return entry.path || entry.pathname || entry.file || entry.relativePath || entry.relative_path || '';
}

function manifestEntryMatches(entry, relativePath) {
  const wanted = normalizePathname(relativePath);
  const values = [
    entry?.path,
    entry?.pathname,
    entry?.file,
    entry?.relativePath,
    entry?.relative_path,
    entry?.name,
    entry?.id,
    entry?.label,
  ].map(normalizePathname).filter(Boolean);

  return values.some((value) => value === wanted || value.endsWith(`/${wanted}`));
}

export function wpCodeboxArtifactPath(output, relativePath) {
  const directory = artifactDirectory(output);
  if (!directory) {
    return '';
  }

  const entry = artifactFiles(output).find((candidate) => manifestEntryMatches(candidate, relativePath));
  const entryPath = manifestEntryPath(entry);
  if (entryPath) {
    return path.isAbsolute(entryPath) ? entryPath : path.join(directory, entryPath);
  }

  return path.join(directory, relativePath);
}

export function wpCodeboxBrowserArtifacts(output, names) {
  const result = {
    directory: wpCodeboxArtifactPath(output, 'files/browser'),
  };

  for (const name of names) {
    result[name] = wpCodeboxArtifactPath(output, `files/browser/${name}`);
  }

  return result;
}
