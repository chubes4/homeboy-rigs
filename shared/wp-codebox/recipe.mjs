import { loadWordPressHelperModule } from '../wordpress-helper-loader.mjs';
import { truncateString } from '../bounds.mjs';

function loadRecipeHelper() {
  return loadWordPressHelperModule({
    helperName: 'wp-codebox-recipe-helper',
    envVar: 'HOMEBOY_WP_CODEBOX_RECIPE_HELPER',
    manifestFileName: 'wp-codebox-recipe-helper.js',
    packageImport: 'homeboy-extension-wordpress/wp-codebox-recipe-helper',
  });
}

export function wpCodeboxBin(env = process.env) {
  return loadRecipeHelper().wpCodeboxBin({ env });
}

export function wpCodeboxCommand(bin = wpCodeboxBin()) {
  return loadRecipeHelper().wpCodeboxCommand(bin);
}

// Default wall-clock cap for a single recipe-run before the watchdog kills it and
// surfaces a failed batch (#559). A wedged run (duplicate, idle child, no output
// progress) otherwise hangs the whole bench indefinitely and orphans the rig
// lock — one observed wedge idled 28+ minutes. 20 minutes is generous for a full
// batch (sandbox provision + WP boot + multi-fixture import) while bounding
// "forever". Override per-call with `timeoutMs`, globally with
// HOMEBOY_WP_CODEBOX_RECIPE_TIMEOUT_MS, or disable with a non-positive value.
export const DEFAULT_RECIPE_TIMEOUT_MS = 20 * 60 * 1000;

// Conventional timeout exit status (matches GNU `timeout`). Numeric so the bench
// records it as an integer exit_status and propagates a valid process exit code.
const WATCHDOG_TIMEOUT_EXIT_CODE = 124;

// In-flight recipe-runs keyed by their recipe file. A second call for the SAME
// batch while the first child is still alive returns the in-flight promise
// instead of spawning a duplicate recipe-run — the #559 duplicate-process root
// (a retry/respawn that never reaped the prior child). The entry is cleared once
// the run settles, so a later retry of the same batch is allowed.
const inFlightRecipeRuns = new Map();

function resolveTimeoutMs(options, env = process.env) {
  const explicit = Number(options?.timeoutMs);
  if (Number.isFinite(explicit)) {
    return explicit > 0 ? explicit : 0;
  }
  const rawEnv = env.HOMEBOY_WP_CODEBOX_RECIPE_TIMEOUT_MS;
  if (rawEnv !== undefined && rawEnv !== '') {
    const fromEnv = Number(rawEnv);
    if (Number.isFinite(fromEnv)) {
      return fromEnv > 0 ? fromEnv : 0;
    }
  }
  return DEFAULT_RECIPE_TIMEOUT_MS;
}

// Fold the child's real stderr (+ a bounded stdout tail) into the thrown error
// message so the cause propagates into the bench output and homeboy's
// `stderr_tail` instead of a bare "Command failed: node … recipe-run …" (#560).
// The captured text is bounded (#555 truncation) so this can not reintroduce the
// V8 string-length issue. The original `.stdout`/`.stderr`/`.code`/`.signal`
// fields are preserved so the structured child-command failure the bench builds
// from them is unchanged.
function enrichRecipeError(error) {
  if (!error || typeof error !== 'object') {
    return error;
  }
  const baseMessage = error.message || 'WP Codebox recipe-run failed';
  const stderrTail = truncateString(typeof error.stderr === 'string' ? error.stderr.trim() : '');
  const stdoutTail = truncateString(typeof error.stdout === 'string' ? error.stdout.trim() : '');
  const parts = [baseMessage];
  if (stderrTail) {
    parts.push(`stderr:\n${stderrTail}`);
  }
  if (stdoutTail) {
    parts.push(`stdout (tail):\n${stdoutTail}`);
  }
  error.message = parts.join('\n\n');
  return error;
}

async function runWatchedRecipe(options) {
  const timeoutMs = resolveTimeoutMs(options);
  const controller = new AbortController();

  // Pass the abort signal + wall cap to the runner so a cooperating helper can
  // SIGKILL and reap the OS child. The wrapper enforces the cap regardless, so a
  // wedged run can never hang the bench even if the helper ignores the signal.
  const helperPromise = Promise.resolve().then(() => loadRecipeHelper().runWpCodeboxRecipe({
    ...options,
    signal: controller.signal,
    timeoutMs,
  }));
  // Defensive: never let a late helper rejection (after the watchdog already won
  // the race) surface as an unhandled rejection.
  helperPromise.catch(() => {});

  if (!timeoutMs) {
    try {
      return await helperPromise;
    } catch (error) {
      throw enrichRecipeError(error);
    }
  }

  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`WP Codebox recipe-run exceeded ${timeoutMs}ms wall cap and was killed by the watchdog`);
      error.code = WATCHDOG_TIMEOUT_EXIT_CODE;
      error.killed = true;
      error.signal = 'SIGKILL';
      error.timeout_ms = timeoutMs;
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([helperPromise, timeout]);
  } catch (error) {
    throw enrichRecipeError(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function runWpCodeboxRecipe(options = {}) {
  const recipeKey = options?.recipeFile ? String(options.recipeFile) : '';
  if (recipeKey && inFlightRecipeRuns.has(recipeKey)) {
    return inFlightRecipeRuns.get(recipeKey);
  }

  const promise = runWatchedRecipe(options);
  if (!recipeKey) {
    return promise;
  }

  inFlightRecipeRuns.set(recipeKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightRecipeRuns.get(recipeKey) === promise) {
      inFlightRecipeRuns.delete(recipeKey);
    }
  }
}
