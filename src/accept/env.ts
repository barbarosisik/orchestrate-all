/**
 * The environment acceptance commands run with.
 *
 * Commands run code the worker wrote (its tests), so they get an allowlist, not the conductor's whole
 * environment: what toolchains need to find themselves, their caches and the temp folder. Everything else,
 * such as API keys, tokens and npm_config_* settings (which can hold registry tokens), is left out. GIT_*
 * variables are always left out, as they can point git at another repository.
 *
 * CI=true stops test runners from waiting in watch mode; NO_COLOR keeps the recorded output readable.
 */

/** Variables commands get by default. Names are compared ignoring case (Windows ignores it). */
export const DEFAULT_COMMAND_ENV: readonly string[] = [
  // Every system
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Windows
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'OS',
  // Toolchains and their caches
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'GOCACHE',
  'GOMODCACHE',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'RUSTUP_TOOLCHAIN',
  'NVM_DIR',
  'NVM_HOME',
  'NVM_SYMLINK',
  'NVM_BIN',
  'VOLTA_HOME',
  'FNM_DIR',
  'FNM_MULTISHELL_PATH',
  'PNPM_HOME',
  'COREPACK_HOME',
  'BUN_INSTALL',
  'DENO_DIR',
  'PYENV_ROOT',
  'PYENV_VERSION',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'DOTNET_ROOT',
  'DOTNET_CLI_HOME',
  'NUGET_PACKAGES',
  'GRADLE_USER_HOME',
  'MAVEN_HOME',
  'M2_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'RBENV_ROOT',
  'GEM_HOME',
  'GEM_PATH',
];

/** Name prefixes that are allowed too: locale settings and the XDG base folders. */
const ALLOWED_PREFIXES = ['LC_', 'XDG_'] as const;

export interface CommandEnvOptions {
  /** More variable names to pass through (from the user's config). */
  readonly allow?: readonly string[];
}

export function commandEnv(base: NodeJS.ProcessEnv = process.env, opts: CommandEnvOptions = {}): NodeJS.ProcessEnv {
  const allowed = new Set([...DEFAULT_COMMAND_ENV, ...(opts.allow ?? [])].map((name) => name.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper.startsWith('GIT_')) continue;
    if (allowed.has(upper) || ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix))) env[key] = value;
  }
  env.CI = 'true';
  env.NO_COLOR = '1';
  return env;
}
