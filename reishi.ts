#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=HOME,EDITOR,REISHI_CONFIG,REISHI_LOCKFILE --allow-net=platform.claude.com,code.claude.com,github.com,codeload.github.com --allow-run

/**
 * reishi - Unified CLI for Claude Agent Skill management
 *
 * Run in dev mode:
 *   deno task cli <command> [options]
 *   deno task check  (type check)
 *   deno task test   (run tests)
 *
 * Install as global binary:
 *   deno task install
 *   then...
 *   rei <command> [options]
 */

import { parse as parseYAML } from '@std/yaml';
import { stringify as stringifyTOML } from '@std/toml';
import { join, resolve } from '@std/path';
import { exists, move } from '@std/fs';
import { Command } from '@cliffy/command';
import { CompletionsCommand } from '@cliffy/command/completions';
import { dim, green, italic, magenta, red, yellow } from '@std/fmt/colors';
import {
  getConfigPath,
  getLockfilePath,
  initConfig,
  loadConfig,
  loadLockfile,
  saveConfig,
  saveLockfile,
  type SkillEntry,
  type SkillLockEntry,
} from './config.ts';
import { getDeactivatedDir, getSourceDir } from './paths.ts';
import {
  checkForUpdates,
  maybeNotifyOfUpdates,
  printStatus,
  printSummary,
  pullAll,
  pullSkill,
  type PullOptions,
  type PullSkillResult,
  summarizeDiff,
  syncAll,
  syncSkill,
  syncStatus,
  type SyncOptions,
  unsyncSkill,
} from './sync.ts';
import {
  getRuleNames,
  listRules,
  printRulesSummary,
  syncRules,
} from './rules.ts';
import {
  addDocProject,
  formatCompileSummary,
  getDocProjectNames,
  listDocProjects,
  listFragments,
  removeDocProject,
  syncDocs,
} from './docs.ts';

// ============================================================================
// Configuration
// ============================================================================

const homeDir = Deno.env.get('HOME');
if (!homeDir) throw new Error('HOME not set');

// Resolve TEMPLATE_DIR relative to this script so it works both via `deno run`
// from any CWD and in a compiled binary (where `assets/` is embedded via
// `deno compile --include assets/`). `import.meta.dirname` points at the
// script's directory in both cases.
const TEMPLATE_DIR = import.meta.dirname
  ? join(import.meta.dirname, 'assets')
  : resolve('./assets');

const TEMPLATES = {
  skill: 'SKILL.md.tmpl',
  script: 'example_script.ts.tmpl',
  reference: 'example_reference.md.tmpl',
  asset: 'example_asset.txt.tmpl',
};

// Anthropic documentation sources
const DOC_SOURCES = [
  {
    url: 'https://code.claude.com/docs/en/skills.md',
    filename: 'overview.md',
  },
];

// ============================================================================
// Types
// ============================================================================

interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  'allowed-tools'?: string[];
  metadata?: Record<string, unknown>;
}

interface ValidationResult {
  valid: boolean;
  message: string;
}

// ============================================================================
// Skill Name Helpers (used by completions and list command)
// ============================================================================

/** List active skill directory names, excluding internal dirs (prefixed with _). */
async function getActiveSkillNames(): Promise<string[]> {
  const sourceDir = await getSourceDir();
  const names: string[] = [];
  if (await exists(sourceDir)) {
    for await (const entry of Deno.readDir(sourceDir)) {
      if (entry.isDirectory && !entry.name.startsWith('_')) {
        names.push(entry.name);
      }
    }
  }
  return names.sort();
}

/** List deactivated skill directory names. */
async function getDeactivatedSkillNames(): Promise<string[]> {
  const deactivatedDir = await getDeactivatedDir();
  const names: string[] = [];
  if (await exists(deactivatedDir)) {
    for await (const entry of Deno.readDir(deactivatedDir)) {
      if (entry.isDirectory) {
        names.push(entry.name);
      }
    }
  }
  return names.sort();
}

// ============================================================================
// Utilities
// ============================================================================

function titleCase(hyphenated: string): string {
  return hyphenated
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function loadTemplate(name: string): Promise<string> {
  const templateName = TEMPLATES[name as keyof typeof TEMPLATES];
  if (!templateName) {
    throw new Error(`Unknown template: ${name}`);
  }

  const templatePath = join(TEMPLATE_DIR, templateName);
  try {
    return await Deno.readTextFile(templatePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ Error loading template:')} ${templatePath}`);
    console.error(`   ${message}`);
    console.error(
      `   ${dim(italic('Make sure templates exist at:'))} ${TEMPLATE_DIR}`,
    );
    throw error;
  }
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
}

/**
 * Run sync after a mutating command and print a one-line follow-up. No
 * output when there are no targets to act on — keeps the common "no
 * targets configured" case silent instead of spammy.
 */
async function syncAndReport(
  skillName: string,
  mode: 'sync' | 'unsync',
): Promise<void> {
  try {
    const results = mode === 'sync'
      ? await syncSkill(skillName)
      : await unsyncSkill(skillName);
    if (results.length === 0) return;
    const touched = results.filter((r) => r.action !== 'skipped' && r.action !== 'failed');
    if (touched.length === 0) return;
    const targetNames = [...new Set(touched.map((r) => r.target))].join(', ');
    const verb = mode === 'sync' ? 'Synced to' : 'Removed from';
    console.log(`${green('✨')} ${verb} ${magenta(targetNames)}`);
    const failed = results.filter((r) => r.action === 'failed');
    for (const f of failed) {
      console.error(
        `  ${red('❌ sync failed')} ${magenta(f.skillName)} → ${f.target} ${dim(italic(`(${f.reason ?? ''})`))}`,
      );
    }
  } catch (error) {
    // Sync is a side-effect — surface the error but don't flip the caller's
    // success back to failure. The primary operation already succeeded.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('⚠ sync error:')} ${message}`);
  }
}

// Returns an error message string if invalid, null if valid.
// When `separator` is provided AND present in the name, each side of the first
// occurrence is validated independently with the unprefixed rules. Names
// without the separator always validate under the stricter core rules — so
// unprefixed names continue to reject `_`.
function validateSkillName(skillName: string, separator?: string): string | null {
  if (separator && separator.length > 0 && skillName.includes(separator)) {
    const sepIdx = skillName.indexOf(separator);
    const prefix = skillName.slice(0, sepIdx);
    const rest = skillName.slice(sepIdx + separator.length);
    if (prefix.length === 0 || rest.length === 0) {
      return `Invalid skill name '${skillName}'\n   Prefix and skill name cannot be empty around '${separator}'`;
    }
    const prefixError = validateSkillName(prefix);
    if (prefixError) return prefixError;
    const restError = validateSkillName(rest);
    if (restError) return restError;
    if (skillName.length > 64) {
      return `Skill name too long (${skillName.length} characters)\n   Maximum length is 64 characters`;
    }
    return null;
  }
  if (!/^[a-z0-9-]+$/.test(skillName)) {
    return `Invalid skill name '${skillName}'\n   Skill names must be lowercase letters, digits, and hyphens only`;
  }
  if (
    skillName.startsWith('-') ||
    skillName.endsWith('-') ||
    skillName.includes('--')
  ) {
    return `Invalid skill name '${skillName}'\n   Skill names cannot start/end with hyphen or contain consecutive hyphens`;
  }
  if (skillName.length > 64) {
    return `Skill name too long (${skillName.length} characters)\n   Maximum length is 64 characters`;
  }
  return null;
}

// ============================================================================
// Command: init
// ============================================================================

async function initSkill(
  skillName: string,
  basePath: string,
): Promise<boolean> {
  const skillDir = resolve(basePath, skillName);
  const skillTitle = titleCase(skillName);

  // Validate skill name format first (before creating anything)
  const nameError = validateSkillName(skillName);
  if (nameError) {
    console.error(`${red('❌ Error:')} ${nameError}`);
    return false;
  }

  // Check if directory exists
  if (await exists(skillDir)) {
    console.error(
      `${red('❌ Error:')} Skill directory already exists: ${magenta(skillDir)}`,
    );
    return false;
  }

  // All validation passed - now we can start
  console.log(`${green('Initializing skill:')} ${skillName}`);
  console.log(`${dim(italic('Location:'))} ${magenta(skillDir)}\n`);

  try {
    // Create skill directory
    await Deno.mkdir(skillDir, { recursive: true });
    console.log(`${green('✅ Created skill directory:')} ${magenta(skillDir)}`);

    // Load and interpolate templates
    const vars = { skill_name: skillName, skill_title: skillTitle };

    // Create SKILL.md
    const skillTemplate = await loadTemplate('skill');
    const skillContent = interpolate(skillTemplate, vars);
    await Deno.writeTextFile(join(skillDir, 'SKILL.md'), skillContent);
    console.log(`${green('✅ Created')} SKILL.md`);

    const referenceTemplate = await loadTemplate('reference');
    const referenceContent = interpolate(referenceTemplate, vars);
    await Deno.writeTextFile(
      join(skillDir, 'example-reference.md'),
      referenceContent,
    );
    console.log(`${green('✅ Created')} example-reference.md`);

    // Create scripts/ directory
    await Deno.mkdir(join(skillDir, 'scripts'));
    const scriptTemplate = await loadTemplate('script');
    const scriptContent = interpolate(scriptTemplate, vars);
    await Deno.writeTextFile(
      join(skillDir, 'scripts', 'example.ts'),
      scriptContent,
    );
    await Deno.chmod(join(skillDir, 'scripts', 'example.ts'), 0o755);
    console.log(`${green('✅ Created')} scripts/example.ts`);

    // Create assets/ directory
    await Deno.mkdir(join(skillDir, 'assets'));
    const assetTemplate = await loadTemplate('asset');
    await Deno.writeTextFile(
      join(skillDir, 'assets', 'example_asset.txt'),
      assetTemplate,
    );
    console.log(`${green('✅ Created')} assets/example_asset.txt`);

    // Print next steps
    console.log(
      `\n${green('✅ Skill')} ${magenta(skillName)} ${green('initialized successfully')}`,
    );
    console.log(`\n${dim(italic('Next steps:'))}`);
    console.log(
      '1. Edit SKILL.md to complete the TODO items and update the description',
    );
    console.log(
      '2. Customize or delete the example reference file or the examples in scripts/, and assets/',
    );
    console.log('3. Run the validator when ready to check the skill structure');
    console.log(`   ${dim(italic('rei validate'))} ${magenta(skillDir)}`);

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ Error creating skill:')} ${message}`);
    return false;
  }
}

// ============================================================================
// Command: init --fork
// ============================================================================

async function forkSkill(
  skillName: string,
  basePath: string,
  forkUrl: string,
): Promise<boolean> {
  const skillDir = resolve(basePath, skillName);

  const nameError = validateSkillName(skillName);
  if (nameError) {
    console.error(`${red('❌ Error:')} ${nameError}`);
    return false;
  }

  // Validate GitHub URL and extract user/repo
  const match = forkUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/,
  );
  if (!match) {
    console.error(`${red('❌ Error:')} Invalid GitHub URL`);
    console.error(
      `   ${dim(italic('Expected format:'))} https://github.com/user/repo`,
    );
    return false;
  }
  const [, user, repo] = match;

  // Check if destination already exists
  if (await exists(skillDir)) {
    console.error(
      `${red('❌ Error:')} Skill directory already exists: ${magenta(skillDir)}`,
    );
    return false;
  }

  const downloadUrl = `https://github.com/${user}/${repo}/archive/refs/heads/main.tar.gz`;

  console.log(
    `Forking ${magenta(`${user}/${repo}`)} as skill: ${magenta(skillName)}`,
  );
  console.log(`${dim(italic('Location:'))} ${magenta(skillDir)}\n`);

  let tmpFile: string | undefined;
  try {
    console.log('Downloading main branch HEAD...');
    const response = await fetch(downloadUrl);

    if (!response.ok) {
      console.error(
        `${red('❌ Error:')} Failed to fetch repository ${
          dim(italic(`(HTTP ${response.status})`))
        }`,
      );
      if (response.status === 404) {
        console.error(
          `   Repository not found or no main branch: ${magenta(forkUrl)}`,
        );
      }
      return false;
    }

    await Deno.mkdir(skillDir, { recursive: true });

    // Write tarball to temp file then extract (avoids streaming complexity)
    tmpFile = await Deno.makeTempFile({ suffix: '.tar.gz' });
    await Deno.writeFile(tmpFile, new Uint8Array(await response.arrayBuffer()));

    // --strip-components=1 removes the `repo-main/` prefix GitHub adds
    const tar = new Deno.Command('tar', {
      args: ['xzf', tmpFile, '--strip-components=1', '-C', skillDir],
      stderr: 'piped',
    });
    const { success, stderr } = await tar.output();

    if (!success) {
      const errMsg = new TextDecoder().decode(stderr);
      console.error(`${red('❌ Error extracting archive:')} ${errMsg}`);
      await Deno.remove(skillDir, { recursive: true });
      return false;
    }

    console.log(
      `${green('✅ Forked')} ${magenta(`${user}/${repo}`)} to ${magenta(skillDir)}`,
    );

    const hasSkillMd = await exists(join(skillDir, 'SKILL.md'));
    console.log(`\n${dim(italic('Next steps:'))}`);
    if (hasSkillMd) {
      console.log('1. Review and edit SKILL.md to fit your needs');
    } else {
      console.log(
        '1. Create SKILL.md with required frontmatter (name, description)',
      );
    }
    console.log('2. Customize the skill contents for your use case');
    console.log(
      `3. Validate when ready: ${dim(italic('rei validate'))} ${magenta(skillDir)}`,
    );

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ Error forking repository:')} ${message}`);
    if (await exists(skillDir)) {
      await Deno.remove(skillDir, { recursive: true });
    }
    return false;
  } finally {
    if (tmpFile) {
      try {
        await Deno.remove(tmpFile);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}

// ============================================================================
// Command: validate
// ============================================================================

async function validateSkill(skillPath: string): Promise<ValidationResult> {
  const skillDir = resolve(skillPath);
  const skillMdPath = join(skillDir, 'SKILL.md');

  // Check SKILL.md exists
  if (!(await exists(skillMdPath))) {
    return { valid: false, message: 'SKILL.md not found' };
  }

  // Read and parse frontmatter
  const content = await Deno.readTextFile(skillMdPath);

  if (!content.startsWith('---')) {
    return { valid: false, message: 'No YAML frontmatter found' };
  }

  const frontmatterMatch = content.match(/^---\n(.*?)\n---/s);
  if (!frontmatterMatch) {
    return { valid: false, message: 'Invalid frontmatter format' };
  }

  // Parse YAML
  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = parseYAML(frontmatterMatch[1]) as SkillFrontmatter;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, message: `Invalid YAML in frontmatter: ${message}` };
  }

  // Validate structure
  const ALLOWED_PROPERTIES = new Set([
    'name',
    'description',
    'license',
    'allowed-tools',
    'metadata',
  ]);

  const unexpectedKeys = Object.keys(frontmatter).filter(
    (key) => !ALLOWED_PROPERTIES.has(key),
  );

  if (unexpectedKeys.length > 0) {
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpectedKeys.join(', ')}. ` +
        `Allowed properties are: ${Array.from(ALLOWED_PROPERTIES).join(', ')}`,
    };
  }

  // Check required fields exist and are strings
  if (frontmatter.name === undefined || frontmatter.name === null) {
    return { valid: false, message: "Missing 'name' in frontmatter" };
  }
  if (
    frontmatter.description === undefined ||
    frontmatter.description === null
  ) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }

  // Ensure name and description are strings
  if (typeof frontmatter.name !== 'string') {
    return { valid: false, message: "'name' must be a string" };
  }
  if (typeof frontmatter.description !== 'string') {
    return { valid: false, message: "'description' must be a string" };
  }

  // Validate name
  const name = frontmatter.name.trim();
  const nameError = validateSkillName(name);
  if (nameError) {
    return { valid: false, message: nameError };
  }

  // Validate description
  const description = frontmatter.description.trim();
  if (/<|>/.test(description)) {
    return {
      valid: false,
      message: 'Description cannot contain angle brackets (< or >)',
    };
  }
  if (description.length > 1024) {
    return {
      valid: false,
      message:
        `Description is too long (${description.length} characters). Maximum is 1024 characters.`,
    };
  }

  return { valid: true, message: green('✅ Skill is valid!') };
}

// ============================================================================
// Command: refresh-docs
// ============================================================================

async function refreshDocs(): Promise<boolean> {
  console.log('Fetching latest Anthropic skill documentation...\n');

  const skillDevDir = join(await getSourceDir(), 'develop-agent-skills');

  try {
    let successCount = 0;

    // Ensure the target dir exists before writing docs into it.
    await Deno.mkdir(skillDevDir, { recursive: true });

    for (const source of DOC_SOURCES) {
      try {
        console.log(`Fetching ${magenta(source.filename)}...`);
        const response = await fetch(source.url);

        if (!response.ok) {
          console.error(
            `  ${red('❌ Failed')} ${dim(italic(`(${response.status})`))} ${source.url}`,
          );
          continue;
        }

        const content = await response.text();
        const outputPath = join(skillDevDir, source.filename);
        await Deno.writeTextFile(outputPath, content);
        console.log(`  ${green('✅ Saved to')} ${magenta(outputPath)}`);
        successCount++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `  ${red('❌ Error fetching')} ${magenta(source.filename)}: ${message}`,
        );
      }
    }

    console.log(
      `\n${green('✅ Fetched')} ${successCount}/${DOC_SOURCES.length} documents to ${
        magenta(skillDevDir)
      }`,
    );
    return successCount > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ Error refreshing docs:')} ${message}`);
    return false;
  }
}

// ============================================================================
// Command: activate / deactivate
// ============================================================================

async function activateSkill(skillName: string): Promise<boolean> {
  const sourceDir = await getSourceDir();
  const deactivatedDir = await getDeactivatedDir();
  const sourcePath = join(deactivatedDir, skillName);
  const destPath = join(sourceDir, skillName);

  // Check source exists
  if (!(await exists(sourcePath))) {
    console.error(
      `${red('❌ Error:')} Skill ${magenta(skillName)} not found in deactivated skills`,
    );
    console.error(`   ${dim(italic('Expected at:'))} ${sourcePath}`);

    // Check if already active
    if (await exists(destPath)) {
      console.log(
        `   ${dim(italic(`(Skill is already active at: ${destPath})`))}`,
      );
    }
    return false;
  }

  // Check destination doesn't exist
  if (await exists(destPath)) {
    console.error(
      `${red('❌ Error:')} Skill ${magenta(skillName)} already exists in active skills`,
    );
    console.error(`   ${dim(italic('Location:'))} ${destPath}`);
    return false;
  }

  try {
    await move(sourcePath, destPath);
    console.log(`${green('✅ Activated')} ${magenta(skillName)}`);
    console.log(`   ${dim(italic('Moved from:'))} ${sourcePath}`);
    console.log(`   ${dim(italic('Moved to:'))}   ${destPath}`);
    await syncAndReport(skillName, 'sync');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ Error activating skill:')} ${message}`);
    return false;
  }
}

async function deactivateSkill(skillName: string): Promise<boolean> {
  const sourceDir = await getSourceDir();
  const deactivatedDir = await getDeactivatedDir();
  const sourcePath = join(sourceDir, skillName);
  const destPath = join(deactivatedDir, skillName);

  // Check source exists
  if (!(await exists(sourcePath))) {
    console.error(
      `${red('❌ Error:')} Skill ${magenta(skillName)} not found in active skills`,
    );
    console.error(`   ${dim(italic('Expected at:'))} ${sourcePath}`);

    // Check if already deactivated
    if (await exists(destPath)) {
      console.log(
        `   ${dim(italic(`(Skill is already deactivated at: ${destPath})`))}`,
      );
    }
    return false;
  }

  // Create deactivated directory if needed
  if (!(await exists(deactivatedDir))) {
    await Deno.mkdir(deactivatedDir, { recursive: true });
  }

  // Check destination doesn't exist
  if (await exists(destPath)) {
    console.error(
      `${red('❌ Error:')} Skill ${magenta(skillName)} already exists in deactivated skills`,
    );
    console.error(`   ${dim(italic('Location:'))} ${destPath}`);
    return false;
  }

  try {
    await move(sourcePath, destPath);
    console.log(`${green('✅ Deactivated')} ${magenta(skillName)}`);
    console.log(`   ${dim(italic('Moved from:'))} ${sourcePath}`);
    console.log(`   ${dim(italic('Moved to:'))}   ${destPath}`);
    await syncAndReport(skillName, 'unsync');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ Error deactivating skill:')} ${message}`);
    return false;
  }
}

// ============================================================================
// Command: list
// ============================================================================

async function listSkills(all: boolean): Promise<boolean> {
  const sourceDir = await getSourceDir();
  const deactivatedDir = await getDeactivatedDir();
  const skills: { name: string; active: boolean }[] = [];

  // Collect active skills — exclude the `_deactivated` subdir and any other
  // reserved `_`-prefixed entries from the active listing.
  if (await exists(sourceDir)) {
    for await (const entry of Deno.readDir(sourceDir)) {
      if (entry.isDirectory && !entry.name.startsWith('_')) {
        skills.push({ name: entry.name, active: true });
      }
    }
  }

  // Collect deactivated skills if --all
  if (all && (await exists(deactivatedDir))) {
    for await (const entry of Deno.readDir(deactivatedDir)) {
      if (entry.isDirectory) {
        skills.push({ name: entry.name, active: false });
      }
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));

  if (skills.length === 0) {
    console.log('No skills found.');
    return true;
  }

  for (const skill of skills) {
    if (skill.active) {
      console.log(`  ${skill.name}`);
    } else {
      console.log(`  ${dim(italic(skill.name))}`);
    }
  }

  const activeCount = skills.filter((s) => s.active).length;
  const deactivatedCount = skills.length - activeCount;
  const summary = deactivatedCount > 0
    ? `\n${green(`${activeCount} active`)}, ${dim(italic(`${deactivatedCount} deactivated`))}`
    : `\n${skills.length} skill${skills.length === 1 ? '' : 's'}`;
  console.log(summary);

  return true;
}

// ============================================================================
// Command: add
// ============================================================================

/**
 * installSkill returns an outcome the caller can use to decide whether to
 * write tracking metadata. `existed` signals a dir-already-exists skip so the
 * caller can treat that as a re-track opportunity when tracking is enabled.
 */
interface InstallOutcome {
  ok: boolean;
  existed: boolean;
  destDir: string;
}

async function installSkill(
  sourceDir: string,
  destPath: string,
  skillName: string,
  repoLabel: string,
): Promise<InstallOutcome> {
  const destDir = join(destPath, skillName);

  if (await exists(destDir)) {
    console.error(
      `${yellow('🚧 Skipping')} ${magenta(skillName)}: already exists at ${magenta(destDir)}`,
    );
    return { ok: false, existed: true, destDir };
  }

  try {
    await move(sourceDir, destDir);
    console.log(
      `${green('✅ Added')} ${magenta(skillName)} from ${magenta(italic(repoLabel))} → ${
        magenta(destDir)
      }`,
    );
    return { ok: true, existed: false, destDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${red('❌ Error installing')} ${magenta(skillName)}: ${message}`,
    );
    return { ok: false, existed: false, destDir };
  }
}

/** Narrow fetch signature: tests only need URL-to-Response behavior. */
export type TarballFetcher = (url: string) => Promise<Response>;

export interface AddSkillOptions {
  /** When true, write a `[skills.<name>]` entry to the config after install. */
  track?: boolean;
  /**
   * Prefix behavior:
   *   - undefined: use the config's `default_prefix` setting
   *   - '' (empty string): infer from the URL's user/org
   *   - any other string: literal value
   */
  prefix?: string;
  /** Injected fetcher for tests. Defaults to global `fetch`. */
  fetcher?: TarballFetcher;
}

/**
 * Write or update the lockfile entry for a just-installed skill. Returns the
 * path to the lockfile that was written.
 */
async function trackSkill(
  installedName: string,
  entry: SkillLockEntry,
): Promise<string> {
  const lockfile = await loadLockfile();
  const existing = lockfile.skills[installedName];
  lockfile.skills[installedName] = { ...existing, ...entry };
  await saveLockfile(lockfile);
  return getLockfilePath();
}

async function addSkill(
  githubUrl: string,
  destPath: string,
  options: AddSkillOptions = {},
): Promise<boolean> {
  // Parse GitHub tree URL: https://github.com/user/repo/tree/ref[/subpath]
  // Takes the first path segment after /tree/ as the ref — handles main, master,
  // develop, staging, trunk, etc. Multi-segment branch names (e.g. feature/x) are
  // not supported; use gunk for those.
  const match = githubUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(\/.*)?$/,
  );

  if (!match) {
    console.error(`${red('❌ Error:')} Invalid GitHub tree URL`);
    console.error(
      `   ${dim(italic('Expected:'))} https://github.com/user/repo/tree/branch[/path]`,
    );
    console.error(
      `   ${dim(italic('For plain repo URLs, use:'))} rei init --fork <url>`,
    );
    return false;
  }

  const [, user, repo, ref, subpathRaw] = match;
  const subpath = subpathRaw ? subpathRaw.replace(/^\//, '') : '';
  const sourceUrl = `https://github.com/${user}/${repo}`;

  // Resolve prefix: explicit CLI option > config's default_prefix. An
  // empty-string prefix ('') means "infer from user/org".
  const config = await loadConfig();
  const separator = config.prefix_separator;
  let prefix: string | undefined = options.prefix;
  if (prefix === undefined && config.default_prefix === 'infer') {
    prefix = '';
  }
  if (prefix === '') prefix = user;

  console.log(`Adding from ${magenta(`${user}/${repo}`)} @ ${magenta(ref)}...`);

  const fetcher: TarballFetcher = options.fetcher ?? fetch;

  // Try branch then tag
  let response = await fetcher(
    `https://github.com/${user}/${repo}/archive/refs/heads/${ref}.tar.gz`,
  );
  if (!response.ok && response.status === 404) {
    response = await fetcher(
      `https://github.com/${user}/${repo}/archive/refs/tags/${ref}.tar.gz`,
    );
  }
  if (!response.ok) {
    console.error(
      `${red('❌ Failed to fetch repository')} ${dim(italic(`(HTTP ${response.status})`))}`,
    );
    if (response.status === 404) {
      console.error(
        `   ${magenta(ref)} not found as a branch or tag in ${magenta(`${user}/${repo}`)}`,
      );
      console.error(
        `   ${dim(italic('For unusual branch names (e.g. feature/x), use gunk manually'))}`,
      );
    }
    return false;
  }

  let tmpFile: string | undefined;
  let tmpDir: string | undefined;

  try {
    console.log('Downloading...');
    tmpFile = await Deno.makeTempFile({ suffix: '.tar.gz' });
    await Deno.writeFile(tmpFile, new Uint8Array(await response.arrayBuffer()));

    tmpDir = await Deno.makeTempDir();

    // Extract full archive, stripping the `repo-ref/` prefix GitHub adds to all paths
    const tar = new Deno.Command('tar', {
      args: ['xzf', tmpFile, '--strip-components=1', '-C', tmpDir],
      stderr: 'piped',
    });
    const { success, stderr } = await tar.output();
    if (!success) {
      console.error(
        `${red('❌ Error extracting archive:')} ${new TextDecoder().decode(stderr)}`,
      );
      return false;
    }

    // Navigate to the target subpath within the extracted tree
    const targetDir = subpath ? join(tmpDir, ...subpath.split('/').filter(Boolean)) : tmpDir;

    if (!(await exists(targetDir))) {
      console.error(
        `${red('❌ Path not found in repository:')} ${magenta(subpath || '(root)')}`,
      );
      return false;
    }

    const applyPrefix = (name: string) => prefix ? `${prefix}${separator}${name}` : name;

    // Validate name (post-prefix) using the separator-aware validator.
    const checkName = (installedName: string): boolean => {
      const nameError = validateSkillName(installedName, prefix ? separator : undefined);
      if (nameError) {
        console.error(`${red('❌ Error:')} ${nameError}`);
        return false;
      }
      return true;
    };

    const maybeTrack = async (
      installedName: string,
      entrySubpath: string,
    ): Promise<void> => {
      if (!options.track) return;
      const entry: SkillLockEntry = {
        source_url: sourceUrl,
        subpath: entrySubpath,
        ref,
        synced_at: new Date().toISOString(),
      };
      if (prefix) entry.prefix = prefix;
      const path = await trackSkill(installedName, entry);
      console.log(
        `${green('📌 Tracked')} ${magenta(installedName)} ${dim(italic(`(${sourceUrl})`))}`,
      );
      console.log(`   ${dim(italic('synced_at:'))} ${entry.synced_at}`);
      console.log(`   ${dim(italic('lockfile:'))} ${magenta(path)}`);
    };

    // Only trigger target sync when the install landed in the configured
    // source of truth. Installs to an arbitrary --path are scaffolding and
    // shouldn't propagate to downstream targets.
    const configuredSourceDir = await getSourceDir();
    const destIsSource = resolve(destPath) === resolve(configuredSourceDir);
    const maybeSync = async (installedName: string): Promise<void> => {
      if (!destIsSource) return;
      await syncAndReport(installedName, 'sync');
    };

    // Single-skill: SKILL.md exists directly at targetDir
    if (await exists(join(targetDir, 'SKILL.md'))) {
      const baseName = subpath.split('/').filter(Boolean).pop() ?? repo;
      const installedName = applyPrefix(baseName);
      if (!checkName(installedName)) return false;

      const outcome = await installSkill(
        targetDir,
        destPath,
        installedName,
        `${user}/${repo}`,
      );

      // Re-track: dir already exists AND skill is already tracked → refresh
      // synced_at and succeed. Full re-sync is Phase 4.
      if (!outcome.ok && outcome.existed && options.track) {
        const existingLock = await loadLockfile();
        if (existingLock.skills[installedName]) {
          await maybeTrack(installedName, subpath);
          return true;
        }
      }

      if (outcome.ok) {
        await maybeTrack(installedName, subpath);
        await maybeSync(installedName);
        console.log(`\n${dim(italic('Next steps:'))}`);
        console.log('1. Review SKILL.md to ensure it fits your setup');
        console.log(
          `2. Validate: ${dim(italic('rei validate'))} ${magenta(join(destPath, installedName))}`,
        );
      }
      return outcome.ok;
    }

    // Multi-skill: scan direct subdirectories for SKILL.md
    const skills: string[] = [];
    for await (const entry of Deno.readDir(targetDir)) {
      if (!entry.isDirectory) continue;
      if (await exists(join(targetDir, entry.name, 'SKILL.md'))) {
        skills.push(entry.name);
      }
    }

    if (skills.length === 0) {
      console.error(
        `${red('❌ No skills found:')} no SKILL.md at the given path or its direct subdirectories`,
      );
      console.error(
        `   ${dim(italic('Checked:'))} ${magenta(subpath || '(repo root)')}`,
      );
      return false;
    }

    skills.sort();
    console.log(
      `Found ${skills.length} skill(s): ${skills.map((s) => magenta(s)).join(', ')}\n`,
    );

    let successCount = 0;
    for (const skillName of skills) {
      const installedName = applyPrefix(skillName);
      if (!checkName(installedName)) continue;

      const outcome = await installSkill(
        join(targetDir, skillName),
        destPath,
        installedName,
        `${user}/${repo}`,
      );
      const entrySubpath = subpath ? `${subpath}/${skillName}` : skillName;

      if (outcome.ok) {
        await maybeTrack(installedName, entrySubpath);
        await maybeSync(installedName);
        successCount++;
      } else if (outcome.existed && options.track) {
        const existingConfig = await loadConfig();
        if (existingConfig.skills?.[installedName]) {
          await maybeTrack(installedName, entrySubpath);
          successCount++;
        }
      }
    }

    console.log(
      `\n${green('✅ Added')} ${successCount}/${skills.length} skills to ${magenta(destPath)}`,
    );
    return successCount > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ Error:')} ${message}`);
    return false;
  } finally {
    if (tmpFile) {
      try {
        await Deno.remove(tmpFile);
      } catch {
        /* ignore */
      }
    }
    if (tmpDir) {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export { addSkill };

// ============================================================================
// Command: config
// ============================================================================

async function configInit(): Promise<boolean> {
  try {
    const result = await initConfig();
    if (result.alreadyExisted) {
      console.log(
        `${yellow('🚧 Config already exists at')} ${magenta(result.configPath)}`,
      );
      console.log(
        `   ${dim(italic('View it with'))} rei config show ${
          dim(italic('or edit with'))
        } rei config edit`,
      );
      return true;
    }
    console.log(`${green('✅ Created config')} ${magenta(result.configPath)} 🌀`);
    for (const dir of result.createdDirs) {
      console.log(`${green('✅ Created directory')} ${magenta(dir)}`);
    }
    if (result.createdDirs.length === 0) {
      console.log(`   ${dim(italic('All source directories already existed.'))}`);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ Error initializing config:')} ${message}`);
    return false;
  }
}

async function configShow(): Promise<boolean> {
  try {
    void maybeNotifyOfUpdates();
    const config = await loadConfig();
    const rendered = stringifyTOML(config as unknown as Record<string, unknown>);
    console.log(rendered.trimEnd());
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ Error loading config:')} ${message}`);
    return false;
  }
}

function configPath(): boolean {
  console.log(getConfigPath());
  return true;
}

/**
 * Minimal yes/no terminal prompt. Returns false when stdin isn't a terminal
 * (non-interactive contexts get the safe default).
 */
async function promptYesNoCli(question: string, defaultNo = true): Promise<boolean> {
  if (!Deno.stdin.isTerminal()) return false;
  const buf = new Uint8Array(64);
  await Deno.stdout.write(new TextEncoder().encode(`${question} `));
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;
  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
  if (answer === '') return !defaultNo;
  return answer.startsWith('y');
}

// ============================================================================
// CLI Definition with Cliffy
// ============================================================================
// CLI Definition with Cliffy
// ============================================================================

// Show the raw config value (may be `~/...`) to avoid awaiting during CLI
// setup. The actual resolved path is used at action-time.
const { paths: { source: configuredSource } } = await loadConfig();

const cli = new Command()
  .name('rei')
  .version('0.1.0')
  .description('Cross-agent Skill management CLI')
  .meta('Author', 'winnie [gwenwindflower@gh] + Claude Code')
  .meta('Docs', 'https://code.claude.com/docs/en/skills')
  .meta('Templates', TEMPLATE_DIR)
  .meta('Source of Truth', configuredSource)
  .globalComplete('active-skill', () => getActiveSkillNames())
  .globalComplete('deactivated-skill', () => getDeactivatedSkillNames())
  .globalComplete('rule-name', () => getRuleNames())
  .globalComplete('doc-project', () => getDocProjectNames());

// Refresh-docs command (top-level — fetches Anthropic doc updates)
cli
  .command('refresh-docs')
  .description('Fetch latest Anthropic skill documentation')
  .example('Update docs', 'rei refresh-docs')
  .action(async () => {
    const success = await refreshDocs();
    Deno.exit(success ? 0 : 1);
  });

// Skills command (parent for: new, validate, add, list, activate, deactivate,
// sync, pull, status, updates)
const skillsCommand = new Command()
  .description('Manage conditionally-activated agent context (skills)')
  .action(function () {
    this.showHelp();
  })
  .command('new <skill-name:string>')
  .description('Scaffold a new skill from the embedded template')
  .option('-p, --path <path:string>', 'Base path for new skill (defaults to config source)')
  .option(
    '-f, --fork <url:string>',
    'Use a GitHub repo as the skill basis (main branch HEAD)',
  )
  .example('Create in default location', 'rei skills new my-new-skill')
  .example(
    'Create in custom location',
    'rei skills new my-new-skill --path skills/public',
  )
  .example(
    'Fork from GitHub',
    'rei skills new my-skill --fork https://github.com/user/repo',
  )
  .action(async (options, skillName) => {
    const sourceDir = await getSourceDir();
    const basePath = options.path ?? sourceDir;
    const success = options.fork
      ? await forkSkill(skillName, basePath, options.fork)
      : await initSkill(skillName, basePath);
    if (success && resolve(basePath) === resolve(sourceDir)) {
      await syncAndReport(skillName, 'sync');
    }
    Deno.exit(success ? 0 : 1);
  })
  .command('validate <skill-path:string>')
  .alias('check')
  .description('Validate skill structure and frontmatter')
  .example('Validate a skill', 'rei skills validate agents/skills/my-skill')
  .action(async (_options, skillPath) => {
    void maybeNotifyOfUpdates();
    const result = await validateSkill(skillPath);
    console.log(result.message);
    Deno.exit(result.valid ? 0 : 1);
  })
  .command('add <github-url:string>')
  .alias('a')
  .description(
    'Add skill(s) from a GitHub tree URL — single skill or a whole skills directory',
  )
  .option(
    '--path <path:string>',
    'Destination directory for added skills (defaults to config source)',
  )
  .option(
    '-t, --track',
    'Record skill origin in the lockfile for later pulls',
    { default: false },
  )
  .option(
    '-p, --prefix [value:string]',
    'Prefix skill names with an org/user (no value = infer from URL)',
  )
  .example(
    'Add a single skill',
    'rei skills add https://github.com/user/repo/tree/main/skills/my-skill',
  )
  .example(
    'Track and prefix with inferred org',
    'rei skills add -tp https://github.com/readwiseio/readwise-skills/tree/main/skills',
  )
  .action(async (options, githubUrl) => {
    let prefix: string | undefined;
    if (options.prefix === true) prefix = '';
    else if (typeof options.prefix === 'string') prefix = options.prefix;

    const destPath = options.path ?? await getSourceDir();
    const success = await addSkill(githubUrl, destPath, {
      track: options.track,
      prefix,
    });
    Deno.exit(success ? 0 : 1);
  })
  .command('list')
  .alias('ls')
  .description('List skills')
  .option('-a, --all', 'Include deactivated skills', { default: false })
  .example('List active skills', 'rei skills list')
  .example('List all skills', 'rei skills list --all')
  .action(async (options) => {
    void maybeNotifyOfUpdates();
    const success = await listSkills(options.all);
    Deno.exit(success ? 0 : 1);
  })
  .command('activate <skill-name:string:deactivated-skill>')
  .alias('on')
  .description('Move a skill from deactivated to active')
  .example('Enable a skill', 'rei skills activate old-skill')
  .action(async (_options, skillName) => {
    const success = await activateSkill(skillName);
    Deno.exit(success ? 0 : 1);
  })
  .command('deactivate <skill-name:string:active-skill>')
  .alias('off')
  .description('Move a skill from active to deactivated')
  .example('Disable a skill', 'rei skills deactivate old-skill')
  .action(async (_options, skillName) => {
    const success = await deactivateSkill(skillName);
    Deno.exit(success ? 0 : 1);
  })
  .command('sync [skill-name:string:active-skill]')
  .description('Distribute skills from source to configured targets (local only)')
  .option('--targets <names:string>', 'Comma-separated target names to sync to')
  .option('--method <method:string>', 'Override sync method: copy or symlink')
  .option('--dry-run', 'Plan only — do not write')
  .option(
    '--prefix-change <mode:string>',
    'How to handle a changed prefix non-interactively: rename | parallel | abort',
  )
  .example('Sync all skills to all targets', 'rei skills sync')
  .example('Sync one skill', 'rei skills sync book-review')
  .action(async (options, skillName) => {
    const syncOpts = buildSyncOptions(options);
    if (syncOpts === null) Deno.exit(1);
    const results = skillName
      ? await syncSkill(skillName, syncOpts!)
      : await syncAll(syncOpts!);
    printSummary(results);
    Deno.exit(results.some((r) => r.action === 'failed') ? 1 : 0);
  })
  .command('pull [skill-name:string:active-skill]')
  .description('Fetch upstream for tracked skills, then auto-sync to targets')
  .option('--targets <names:string>', 'Comma-separated target names to sync to')
  .option('--method <method:string>', 'Override sync method: copy or symlink')
  .option('--dry-run', 'Preview upstream diff without writing (no sync either)')
  .option('--force', 'Overwrite local modifications without prompting')
  .option(
    '--prefix-change <mode:string>',
    'How to handle a changed prefix non-interactively: rename | parallel | abort',
  )
  .example('Pull all tracked skills', 'rei skills pull')
  .example('Pull one skill', 'rei skills pull book-review')
  .example('Preview upstream changes', 'rei skills pull --dry-run')
  .action(async (options, skillName) => {
    const pullOpts = buildSyncOptions(options) as PullOptions | null;
    if (pullOpts === null) Deno.exit(1);
    const results = skillName
      ? [await pullSkill(skillName, pullOpts!)]
      : await pullAll(pullOpts!);
    printPullSummary(results);
    const anyFail = results.some((r) =>
      r.fetch.aborted || r.sync.some((s) => s.action === 'failed')
    );
    Deno.exit(anyFail ? 1 : 0);
  })
  .command('status')
  .description('Report per skill × target freshness (local only, no network)')
  .example('Show sync state', 'rei skills status')
  .action(async () => {
    const statuses = await syncStatus();
    printStatus(statuses);
    Deno.exit(0);
  })
  .command('updates [skill-name:string:active-skill]')
  .description('Check tracked skills for upstream changes')
  .option('--pull', 'Also pull any skills with detected upstream changes')
  .example('Check all tracked skills', 'rei skills updates')
  .example('Check and pull', 'rei skills updates --pull')
  .action(async (options, skillName) => {
    const checks = await checkForUpdates(skillName);
    const updated = checks.filter((c) => c.hasUpdate).map((c) => c.skillName);
    const skipped = checks.filter((c) => c.skipped);

    if (updated.length === 0) {
      console.log(`${green('✨ Up to date')} ${dim(italic(`(${checks.length} checked)`))}`);
    } else {
      const noun = updated.length === 1 ? 'skill has' : 'skills have';
      console.log(
        `${green('✨')} ${updated.length} ${noun} upstream updates: ${
          updated.map((n) => magenta(n)).join(', ')
        }`,
      );
    }
    for (const s of skipped) {
      console.log(`  ${dim(italic(`skipped ${s.skillName}: ${s.reason}`))}`);
    }

    if (options.pull && updated.length > 0) {
      const pullResults: PullSkillResult[] = [];
      for (const name of updated) {
        pullResults.push(await pullSkill(name));
      }
      printPullSummary(pullResults);
    }

    Deno.exit(0);
  });

cli.command('skills', skillsCommand);

/**
 * Parse the shared sync/pull flag set (method/targets/dry-run/force/
 * prefix-change). Returns null after printing an error message when a flag
 * value is malformed. Callers pass the same options object they get from
 * Cliffy; unknown fields are ignored.
 */
function buildSyncOptions(options: {
  targets?: string;
  method?: string;
  dryRun?: boolean;
  force?: boolean;
  prefixChange?: string;
}): SyncOptions | null {
  let method: 'copy' | 'symlink' | undefined;
  if (options.method) {
    if (options.method === 'copy' || options.method === 'symlink') {
      method = options.method;
    } else {
      console.error(`${red('❌ Error:')} --method must be 'copy' or 'symlink'`);
      return null;
    }
  }
  let prefixChange: 'rename' | 'parallel' | 'abort' | undefined;
  if (options.prefixChange) {
    if (
      options.prefixChange === 'rename' ||
      options.prefixChange === 'parallel' ||
      options.prefixChange === 'abort'
    ) {
      prefixChange = options.prefixChange;
    } else {
      console.error(
        `${red('❌ Error:')} --prefix-change must be one of: rename, parallel, abort`,
      );
      return null;
    }
  }
  const targets = options.targets
    ? options.targets.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
    : undefined;
  return {
    targets,
    method,
    dryRun: options.dryRun,
    force: options.force,
    prefixChange,
  };
}

/** Compact summary for `rei skills pull` — fetch + sync per skill. */
function printPullSummary(results: PullSkillResult[]): void {
  if (results.length === 0) {
    console.log('No tracked skills to pull.');
    return;
  }
  for (const r of results) {
    if (r.fetch.aborted) {
      console.log(
        `  ${red('✗')} ${magenta(r.skillName)} ${dim(italic(`(${r.fetch.reason ?? 'aborted'})`))}`,
      );
      continue;
    }
    const label = r.fetch.changed ? green('🌐 pulled') : dim(italic('up-to-date'));
    const diff = r.fetch.changed ? ` ${dim(italic(`(${summarizeDiff(r.fetch.diff)})`))}` : '';
    console.log(`  ${label} ${magenta(r.skillName)}${diff}`);
  }
  const syncFlat = results.flatMap((r) => r.sync);
  if (syncFlat.length > 0) {
    printSummary(syncFlat);
  }
}

// Config command (with subcommands: init, show, path)
const configCommand = new Command()
  .description('Inspect and manage reishi config')
  .action(function () {
    this.showHelp();
  })
  .command('init')
  .description('Create the reishi config file and source directories')
  .example('Initialize config', 'rei config init')
  .action(async () => {
    const success = await configInit();
    Deno.exit(success ? 0 : 1);
  })
  .command('show')
  .description('Print the effective config (merged with defaults)')
  .example('Show current config', 'rei config show')
  .action(async () => {
    const success = await configShow();
    Deno.exit(success ? 0 : 1);
  })
  .command('path')
  .description('Print the config file path')
  .example('Pipe the path', 'cat $(rei config path)')
  .action(() => {
    const success = configPath();
    Deno.exit(success ? 0 : 1);
  });

cli.command('config', configCommand);

// Top-level sync — cross-domain convenience (skills + rules + docs).
// Local-only: no network, no upstream fetch. Use `rei skills pull` to fetch.
cli
  .command('sync')
  .description('Sync skills, rules, and docs from source to targets (local only)')
  .option('--targets <names:string>', 'Comma-separated target names to sync to')
  .option('--method <method:string>', 'Override sync method: copy or symlink')
  .option('--dry-run', 'Plan only — do not write')
  .option(
    '--prefix-change <mode:string>',
    'How to handle a changed prefix non-interactively: rename | parallel | abort',
  )
  .example('Sync everything', 'rei sync')
  .example('Sync to a subset of targets', 'rei sync --targets=claude,agents')
  .action(async (options) => {
    void maybeNotifyOfUpdates();
    const syncOpts = buildSyncOptions(options);
    if (syncOpts === null) Deno.exit(1);
    const targets = syncOpts!.targets;
    const method = syncOpts!.method;

    const skillResults = await syncAll(syncOpts!);
    const ruleResults = await syncRules({
      targets,
      method,
      dryRun: options.dryRun,
    });
    const config = await loadConfig();
    const docsProjects = config.docs.projects ?? {};
    const docsRuns = Object.keys(docsProjects).length > 0
      ? await syncDocs({ method, dryRun: options.dryRun })
      : [];

    const anyFail = skillResults.some((r) => r.action === 'failed') ||
      ruleResults.some((r) => r.action === 'failed') ||
      docsRuns.some((r) => r.result.action === 'failed');
    const participatingTypes = [
      skillResults.length > 0,
      ruleResults.length > 0,
      docsRuns.length > 0,
    ].filter(Boolean).length;

    if (participatingTypes > 1 && !anyFail) {
      const skillNames = new Set(skillResults.map((r) => r.skillName));
      const ruleNames = new Set(ruleResults.map((r) => r.ruleName));
      const docProjects = new Set(docsRuns.map((r) => r.project));
      const targetNames = new Set<string>([
        ...skillResults.map((r) => r.target),
        ...ruleResults.map((r) => r.target),
        ...docsRuns.map((r) => r.target),
      ]);
      const parts: string[] = [];
      if (skillNames.size > 0) {
        parts.push(`${skillNames.size} skill${skillNames.size === 1 ? '' : 's'}`);
      }
      if (ruleNames.size > 0) {
        parts.push(`${ruleNames.size} rule${ruleNames.size === 1 ? '' : 's'}`);
      }
      if (docProjects.size > 0) {
        parts.push(`${docProjects.size} doc project${docProjects.size === 1 ? '' : 's'}`);
      }
      const joined = parts.length === 1
        ? parts[0]
        : parts.length === 2
        ? parts.join(' and ')
        : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
      console.log(
        `${green('✨ Synced')} ${joined} across ${targetNames.size} target${
          targetNames.size === 1 ? '' : 's'
        }`,
      );
    } else {
      if (skillResults.length > 0) printSummary(skillResults);
      if (ruleResults.length > 0) printRulesSummary(ruleResults);
      for (const run of docsRuns) {
        console.log(
          formatCompileSummary(
            run.project,
            run.result,
            config.docs.index_filename,
            config.docs.default_target,
          ),
        );
      }
    }

    Deno.exit(anyFail ? 1 : 0);
  });

// Rules command (subcommands: list, sync).
// Users manage rule files directly with their editor/filesystem tools;
// reishi only lists what's there and distributes it.
const rulesCommand = new Command()
  .description('Manage always-on markdown rules distributed to agent rule paths')
  .action(function () {
    this.showHelp();
  })
  .command('list')
  .alias('ls')
  .description('List rules in rules.source')
  .example('List rules', 'rei rules list')
  .action(async () => {
    const rules = await listRules();
    if (rules.length === 0) {
      console.log('No rules found.');
      Deno.exit(0);
    }
    for (const rule of rules) {
      const kind = rule.kind === 'directory' ? dim(italic('(dir)')) : '';
      console.log(`  ${rule.name} ${kind}`);
    }
    console.log(`\n${rules.length} rule${rules.length === 1 ? '' : 's'}`);
    Deno.exit(0);
  })
  .command('sync')
  .description('Sync rules from source to configured targets')
  .option('--targets <names:string>', 'Comma-separated target names to sync to')
  .option('--method <method:string>', 'Override sync method: copy or symlink')
  .option('--dry-run', 'Plan only — do not write')
  .example('Sync all rules to all targets', 'rei rules sync')
  .example('Sync to one target', 'rei rules sync --targets=claude')
  .action(async (options) => {
    let method: 'copy' | 'symlink' | undefined;
    if (options.method) {
      if (options.method === 'copy' || options.method === 'symlink') {
        method = options.method;
      } else {
        console.error(`${red('❌ Error:')} --method must be 'copy' or 'symlink'`);
        Deno.exit(1);
      }
    }
    const targets = options.targets
      ? options.targets.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
      : undefined;
    const results = await syncRules({ targets, method, dryRun: options.dryRun });
    printRulesSummary(results);
    const failed = results.some((r) => r.action === 'failed');
    Deno.exit(failed ? 1 : 0);
  });

cli.command('rules', rulesCommand);

// Docs command (subcommands: list, add, remove, sync).
// Users manage fragment files directly. Reishi creates projects (dir + config
// entry), lists what's there, removes projects, and distributes the compiled
// index to project roots.
const docsCommand = new Command()
  .description('Manage project-scoped doc fragments compiled into a token-efficient index')
  .action(function () {
    this.showHelp();
  })
  .command('list [project:string:doc-project]')
  .alias('ls')
  .description('List doc projects, or fragments within a project')
  .example('List doc projects', 'rei docs list')
  .example('List fragments in a project', 'rei docs list myproject')
  .action(async (_options, project) => {
    if (project) {
      const fragments = await listFragments(project);
      if (fragments.length === 0) {
        console.log(`No fragments in ${magenta(project)}.`);
        Deno.exit(0);
      }
      for (const f of fragments) {
        console.log(`  ${f.name} ${dim(italic(`(${f.size} bytes)`))}`);
      }
      console.log(
        `\n${fragments.length} fragment${fragments.length === 1 ? '' : 's'} in ${magenta(project)}`,
      );
      Deno.exit(0);
    }
    const projects = await listDocProjects();
    if (projects.length === 0) {
      console.log('No doc projects found.');
      Deno.exit(0);
    }
    for (const name of projects) {
      const fragments = await listFragments(name);
      console.log(
        `  ${name} ${dim(italic(`(${fragments.length} fragment${fragments.length === 1 ? '' : 's'})`))}`,
      );
    }
    console.log(
      `\n${projects.length} doc project${projects.length === 1 ? '' : 's'}`,
    );
    Deno.exit(0);
  })
  .command('add <project:string>')
  .description('Create a doc project: makes the source dir and config entry')
  .option('--target <path:string>', 'Project root on disk for sync')
  .option('--force', 'Re-use an existing source dir instead of erroring')
  .example('Create a project', 'rei docs add myproject --target ~/code/myproject')
  .action(async (options, project) => {
    try {
      const result = await addDocProject(project, {
        target: options.target,
        force: options.force,
      });
      console.log(
        `${green('✅ Created docs project')} ${magenta(project)} ${
          dim(italic(`(source: ${result.sourceDir})`))
        }`,
      );
      if (!options.target) {
        console.log(
          `   ${dim(italic('Tip: set'))} [docs.projects.${project}].target ${
            dim(italic('in config.toml to enable sync'))
          }`,
        );
      }
      Deno.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${red('❌ Error:')} ${message}`);
      Deno.exit(1);
    }
  })
  .command('remove <project:string:doc-project>')
  .alias('rm')
  .description('Remove a doc project — two-step: config entry, then optionally source dir')
  .option('--force', 'Skip the config-entry confirmation prompt')
  .option('--delete-source', 'Also delete the source dir (default: keep it)')
  .example('Remove a project', 'rei docs remove myproject')
  .action(async (options, project) => {
    // Step 1: confirm config-entry removal.
    if (!options.force) {
      const ok = await promptYesNoCli(
        `Remove docs project '${project}' from config? (y/N)`,
      );
      if (!ok) {
        console.log(`${yellow('Aborted.')}`);
        Deno.exit(0);
      }
    }
    // Step 2: decide about the source dir.
    let deleteSourceDir = options.deleteSource === true;
    if (!deleteSourceDir && !options.force) {
      deleteSourceDir = await promptYesNoCli(
        `Also delete source directory for '${project}'? (y/N)`,
      );
    }
    try {
      const result = await removeDocProject(project, { deleteSourceDir });
      if (!result.removedFromConfig) {
        console.log(
          `${yellow('⚠ No config entry for')} ${magenta(project)} ${dim(italic('(nothing to remove)'))}`,
        );
      } else {
        console.log(`${green('✅ Removed config entry')} ${magenta(project)}`);
      }
      if (result.sourceDirRemoved) {
        console.log(`${green('🗑  Deleted source dir')} ${magenta(result.sourceDir)}`);
      } else if (deleteSourceDir) {
        console.log(
          `${dim(italic('Source dir not present:'))} ${magenta(result.sourceDir)}`,
        );
      }
      Deno.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${red('❌ Error:')} ${message}`);
      Deno.exit(1);
    }
  })
  .command('sync [project:string:doc-project]')
  .description('Compile and distribute docs for one or all configured projects')
  .option('--target <path:string>', 'Override the target project root (requires <project>)')
  .option('--method <method:string>', 'Override sync method: copy or symlink')
  .option('--dry-run', 'Plan only — do not write')
  .option('--stdout', 'Emit the compiled index to stdout (requires <project>)')
  .example('Sync all configured projects', 'rei docs sync')
  .example('Sync one configured project', 'rei docs sync myproject')
  .example('Preview the compiled index', 'rei docs sync myproject --stdout')
  .action(async (options, project) => {
    let method: 'copy' | 'symlink' | undefined;
    if (options.method) {
      if (options.method === 'copy' || options.method === 'symlink') {
        method = options.method;
      } else {
        console.error(`${red('❌ Error:')} --method must be 'copy' or 'symlink'`);
        Deno.exit(1);
      }
    }
    if (options.stdout) {
      if (!project) {
        console.error(
          `${red('❌ Error:')} --stdout requires a <project> argument`,
        );
        Deno.exit(1);
      }
      const runs = await syncDocs({
        project,
        targetOverride: options.target,
        method,
        dryRun: true,
        stdout: true,
      });
      const run = runs[0];
      if (!run) {
        console.error(`${red('❌ Error:')} docs project not found: ${project}`);
        Deno.exit(1);
      }
      console.log(run.result.index);
      Deno.exit(run.result.action === 'failed' ? 1 : 0);
    }
    try {
      const runs = await syncDocs({
        project,
        targetOverride: options.target,
        method,
        dryRun: options.dryRun,
      });
      if (runs.length === 0) {
        console.log(
          `${yellow('⚠ No doc projects configured')} ${
            dim(italic('— use `rei docs add <project> --target <path>`'))
          }`,
        );
        Deno.exit(0);
      }
      const config = await loadConfig();
      for (const run of runs) {
        console.log(
          formatCompileSummary(
            run.project,
            run.result,
            config.docs.index_filename,
            config.docs.default_target,
          ),
        );
      }
      const anyFail = runs.some((r) => r.result.action === 'failed');
      Deno.exit(anyFail ? 1 : 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${red('❌ Error:')} ${message}`);
      Deno.exit(1);
    }
  });

cli.command('docs', docsCommand);

// Completions command (auto-generates shell completions for bash, fish, zsh)
cli.command('completions', new CompletionsCommand());

// ============================================================================
// Entry Point
// ============================================================================

if (import.meta.main) {
  await cli.parse(Deno.args);
}
