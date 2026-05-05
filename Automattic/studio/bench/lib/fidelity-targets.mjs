import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function stringArray(value) {
  return asArray(value).filter((item) => typeof item === 'string' && item.trim() !== '');
}

export function safeSlug(value, fallback) {
  const slug = String(value || fallback || 'target')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'target';
}

export function comparisonTargets(importReport) {
  return asArray(importReport?.report?.visual_fidelity?.comparison_targets).filter(
    (target) => target && typeof target === 'object'
  );
}

export function semanticComparisonTargets(importReport) {
  const semanticTargets = asArray(importReport?.report?.semantic_fidelity?.comparison_targets).filter(
    (target) => target && typeof target === 'object'
  );
  return semanticTargets.length ? semanticTargets : comparisonTargets(importReport);
}

export function resolveSourceStaticFile(sourceFile, reportPath, sitePath) {
  if (!sourceFile) {
    return '';
  }

  if (path.isAbsolute(sourceFile)) {
    const wordpressRoot = '/wordpress';
    if (sitePath && (sourceFile === wordpressRoot || sourceFile.startsWith(`${wordpressRoot}/`))) {
      return path.join(sitePath, sourceFile.slice(wordpressRoot.length));
    }

    return sourceFile;
  }

  return path.resolve(path.dirname(reportPath), sourceFile);
}

export function surfaceUrl(target, surface, reportPath, sitePath) {
  const surfaces = target?.comparison_hooks?.render_surfaces || {};
  const configured = surfaces[surface]?.url || '';
  if (surface === 'source_static') {
    const sourceFile = configured || target?.source_file || '';
    if (!sourceFile) {
      return '';
    }
    const absoluteSource = resolveSourceStaticFile(sourceFile, reportPath, sitePath);
    return pathToFileURL(absoluteSource).toString();
  }

  if (surface === 'wordpress_frontend') {
    return configured || target?.wordpress_url || '';
  }

  if (surface === 'wordpress_editor') {
    if (configured) {
      return configured;
    }

    const postId = Number(target?.wordpress_page_id || target?.home_page_id || target?.front_page_id || 0);
    const frontendUrl = surfaceUrl(target, 'wordpress_frontend', reportPath, sitePath);
    if (!postId || !frontendUrl) {
      return '';
    }

    const url = new URL(frontendUrl);
    url.pathname = '/studio-auto-login';
    url.search = '';
    url.searchParams.set('redirect_to', `/wp-admin/post.php?post=${postId}&action=edit`);
    return url.toString();
  }

  return configured;
}
