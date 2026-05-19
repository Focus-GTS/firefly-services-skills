#!/usr/bin/env tsx
/**
 * Catalog generator.
 *
 * Walks every SKILL.md under plugins/firefly-services/skills/, parses its
 * frontmatter, extracts cross-references, and rewrites the
 * `firefly-skills-catalog` SKILL.md with a structured index.
 *
 * Designed to run idempotently — running twice produces the same output.
 * Designed to be invoked from a GitHub Actions cron daily (or locally via
 * `npm run catalog:build`).
 *
 * Exit codes:
 *   0  success (catalog written; may or may not differ from prior state)
 *   1  parse / IO error
 *   2  schema violation in planning-tracks.yml or a SKILL.md
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { glob } from "node:fs/promises";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SKILLS_DIR = path.join(REPO_ROOT, "plugins/firefly-services/skills");
const TRACKS_FILE = path.join(REPO_ROOT, "config/planning-tracks.yml");
const EXTERNAL_SOURCES_FILE = path.join(REPO_ROOT, "config/external-sources.yml");
const EXTERNAL_CACHE_ROOT = process.env.CATALOG_EXTERNAL_CACHE ?? path.join(os.tmpdir(), "firefly-skills-catalog-external");
const CATALOG_SKILL_DIR = path.join(SKILLS_DIR, "firefly-skills-catalog");
const CATALOG_SKILL_PATH = path.join(CATALOG_SKILL_DIR, "SKILL.md");
const CATALOG_VALIDATION_PATH = path.join(CATALOG_SKILL_DIR, "_validation.md");

interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  "allowed-tools"?: string;
  metadata?: {
    version?: string;
    category?: string;
    visibility?: string;
  };
}

interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  category: string;
  version: string;
  /** First line under the H1 — used as the short-purpose summary. */
  summary: string;
  /** Skill names referenced via inline-code in the body. */
  references: string[];
  /** Path to the file, relative to repo root. */
  relPath: string;
  /** Last-modified Unix timestamp (from git or filesystem fallback). */
  lastModified: number;
}

interface PlanningTrack {
  id: string;
  intent: string;
  when: string;
  audience: "fde" | "customer-engineering" | "ops" | "platform";
  tier: "foundation" | "scaling" | "specialized";
  skills: string[];
}

interface TracksFile {
  tracks: PlanningTrack[];
}

interface ExternalSource {
  id: string;
  publisher: string;
  repo: string;
  branch?: string;
  skill_globs: string[];
  license_note?: string;
  relevance_keywords: string[];
  notes?: string;
}

interface ExternalSourcesFile {
  sources: ExternalSource[];
}

interface ExternalSkill {
  sourceId: string;
  publisher: string;
  repoUrl: string;
  /** Browsable URL to the SKILL.md on github.com (best-effort) */
  htmlUrl: string;
  name: string;
  description: string;
  category: string;
  /** Path within the source repo */
  relPath: string;
  lastCommitTs: number;
  /** Whether the skill matched a relevance keyword */
  matched: boolean;
}

const SKILL_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * Frontmatter parser tailored to the actual format used in our SKILL.md files.
 *
 * Strict YAML chokes on description values that contain key:value-like fragments
 * (e.g. "...with `x-model-version: image3_custom`..."). We only need a handful
 * of fields and the format is consistent — hand-roll a tolerant parser.
 *
 * Recognised shape:
 *   ^(name|description|license|compatibility|allowed-tools):\s+VALUE$
 *   ^metadata:$
 *   ^  (version|category|visibility):\s+VALUE$
 *
 * Values are taken verbatim to end-of-line, with surrounding single/double
 * quotes stripped if present. Block scalars are not supported (we don't use
 * them in the existing skills).
 */
function parseFrontmatterTolerant(yaml: string): SkillFrontmatter {
  const fm: SkillFrontmatter = { name: "", description: "" };
  const lines = yaml.split("\n");
  let inMetadata = false;
  for (const raw of lines) {
    const topMatch = raw.match(/^([a-z][a-z_-]*):\s*(.*)$/);
    const subMatch = raw.match(/^ {2}([a-z][a-z_-]*):\s*(.*)$/);
    if (topMatch) {
      const [, key, value] = topMatch;
      if (key === "metadata") {
        inMetadata = true;
        fm.metadata = {};
        continue;
      }
      inMetadata = false;
      const v = stripQuotes(value!);
      switch (key) {
        case "name":
          fm.name = v;
          break;
        case "description":
          fm.description = v;
          break;
        case "license":
          fm.license = v;
          break;
        case "compatibility":
          fm.compatibility = v;
          break;
        case "allowed-tools":
          fm["allowed-tools"] = v;
          break;
        default:
          /* ignore unknown top-level keys */
      }
    } else if (subMatch && inMetadata) {
      const [, key, value] = subMatch;
      const v = stripQuotes(value!);
      fm.metadata = fm.metadata ?? {};
      if (key === "version") fm.metadata.version = v;
      else if (key === "category") fm.metadata.category = v;
      else if (key === "visibility") fm.metadata.visibility = v;
    }
  }
  return fm;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

async function readFrontmatter(filePath: string): Promise<{ fm: SkillFrontmatter; body: string }> {
  const content = await fs.readFile(filePath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`SKILL.md without YAML frontmatter: ${filePath}`);
  const fm = parseFrontmatterTolerant(match[1]!);
  if (!fm.name || !fm.description) {
    throw new Error(`SKILL.md missing required name/description: ${filePath}`);
  }
  if (!SKILL_NAME_RE.test(fm.name)) {
    throw new Error(`SKILL.md name violates kebab-case: ${fm.name} (${filePath})`);
  }
  return { fm, body: match[2]! };
}

/** Extract the first paragraph under the H1 — our short-purpose summary. */
function extractSummary(body: string): string {
  const lines = body.split("\n");
  let pastH1 = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (/^#\s+/.test(line)) {
      if (pastH1) break;
      pastH1 = true;
      continue;
    }
    if (!pastH1) continue;
    if (line.trim() === "") {
      if (collected.length > 0) break;
      continue;
    }
    if (/^#{2,}\s+/.test(line)) break;
    collected.push(line.trim());
  }
  return collected.join(" ").replace(/\s+/g, " ").trim();
}

/** Find references to other skills via inline-code in the body. */
function extractReferences(body: string, allSkillNames: Set<string>): string[] {
  const found = new Set<string>();
  const codeRe = /`([a-z][a-z0-9-]*[a-z0-9])`/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(body)) !== null) {
    const token = m[1]!;
    if (allSkillNames.has(token)) found.add(token);
  }
  return [...found].sort();
}

async function gitLastModified(filePath: string): Promise<number> {
  try {
    const out = execSync(`git log -1 --format=%ct -- "${filePath}"`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ts = Number(out);
    if (Number.isFinite(ts) && ts > 0) return ts * 1000;
  } catch {
    /* fall through */
  }
  const stat = await fs.stat(filePath);
  return stat.mtime.getTime();
}

async function discoverSkills(): Promise<SkillInfo[]> {
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  const passOne: Array<{ slug: string; fm: SkillFrontmatter; body: string; full: string }> = [];
  for (const slug of skillDirs) {
    const full = path.join(SKILLS_DIR, slug, "SKILL.md");
    try {
      await fs.access(full);
    } catch {
      continue; // dir without SKILL.md — skip silently
    }
    const { fm, body } = await readFrontmatter(full);
    passOne.push({ slug, fm, body, full });
  }

  const allNames = new Set(passOne.map((p) => p.fm.name));

  const skills: SkillInfo[] = [];
  for (const { slug, fm, body, full } of passOne) {
    const summary = extractSummary(body) || fm.description.split(/[.!]/)[0]!.slice(0, 200);
    skills.push({
      slug,
      name: fm.name,
      description: fm.description,
      category: fm.metadata?.category ?? "uncategorized",
      version: fm.metadata?.version ?? "—",
      summary,
      references: extractReferences(body, allNames),
      relPath: path.relative(REPO_ROOT, full),
      lastModified: await gitLastModified(full),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function readTracks(): Promise<PlanningTrack[]> {
  const raw = await fs.readFile(TRACKS_FILE, "utf8");
  const parsed = YAML.parse(raw) as TracksFile;
  if (!parsed?.tracks || !Array.isArray(parsed.tracks)) {
    throw new Error(`planning-tracks.yml must have a top-level "tracks" array`);
  }
  return parsed.tracks;
}

async function readExternalSources(): Promise<ExternalSource[]> {
  try {
    const raw = await fs.readFile(EXTERNAL_SOURCES_FILE, "utf8");
    const parsed = YAML.parse(raw) as ExternalSourcesFile;
    return parsed?.sources ?? [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function repoToCacheName(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\//g, "__");
}

function repoToHtmlBase(repoUrl: string, branch = "main"): string {
  const stripped = repoUrl.replace(/\.git$/, "");
  return `${stripped}/blob/${branch}`;
}

/** Clone if missing, fetch+reset if present. Returns the cache path. */
async function ensureExternalSource(source: ExternalSource): Promise<string> {
  await fs.mkdir(EXTERNAL_CACHE_ROOT, { recursive: true });
  const dir = path.join(EXTERNAL_CACHE_ROOT, repoToCacheName(source.repo));
  const branch = source.branch ?? "main";
  try {
    await fs.access(path.join(dir, ".git"));
    // Already cloned — fetch + reset to be idempotent.
    execSync(`git fetch --depth 1 origin ${branch}`, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    execSync(`git reset --hard origin/${branch}`, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // Not cloned yet — shallow-clone.
    execSync(`git clone --depth 1 --branch ${branch} ${source.repo} "${dir}"`, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return dir;
}

function isRelevant(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

async function scanExternalSource(source: ExternalSource): Promise<ExternalSkill[]> {
  const root = await ensureExternalSource(source);
  const matched: ExternalSkill[] = [];

  for (const pattern of source.skill_globs) {
    for await (const filePath of glob(pattern, { cwd: root })) {
      const full = path.join(root, filePath);
      let parsed: { fm: SkillFrontmatter; body: string };
      try {
        parsed = await readFrontmatter(full);
      } catch {
        continue; // malformed external SKILL.md — skip silently
      }
      const haystack = `${parsed.fm.name} ${parsed.fm.description} ${filePath}`;
      const matchedRelevance = isRelevant(haystack, source.relevance_keywords);
      if (!matchedRelevance) continue;

      // Best-effort last-commit timestamp from the external repo's history.
      let lastCommitTs = 0;
      try {
        const out = execSync(`git log -1 --format=%ct -- "${filePath}"`, {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const ts = Number(out);
        if (Number.isFinite(ts) && ts > 0) lastCommitTs = ts * 1000;
      } catch {
        const stat = await fs.stat(full);
        lastCommitTs = stat.mtime.getTime();
      }

      matched.push({
        sourceId: source.id,
        publisher: source.publisher,
        repoUrl: source.repo.replace(/\.git$/, ""),
        htmlUrl: `${repoToHtmlBase(source.repo, source.branch ?? "main")}/${filePath}`,
        name: parsed.fm.name,
        description: parsed.fm.description,
        category: parsed.fm.metadata?.category ?? "uncategorized",
        relPath: filePath,
        lastCommitTs,
        matched: true,
      });
    }
  }
  return matched;
}

async function discoverExternalSkills(): Promise<{ source: ExternalSource; skills: ExternalSkill[]; error?: string }[]> {
  const sources = await readExternalSources();
  const results: { source: ExternalSource; skills: ExternalSkill[]; error?: string }[] = [];
  for (const source of sources) {
    try {
      const skills = await scanExternalSource(source);
      results.push({ source, skills });
    } catch (err) {
      results.push({ source, skills: [], error: (err as Error).message });
    }
  }
  return results;
}

function validateTracksAgainstSkills(tracks: PlanningTrack[], skills: SkillInfo[]): void {
  const names = new Set(skills.map((s) => s.name));
  const errors: string[] = [];
  for (const t of tracks) {
    if (!t.id || !t.intent || !t.skills?.length) {
      errors.push(`Track has missing required fields: ${JSON.stringify(t).slice(0, 120)}`);
      continue;
    }
    for (const ref of t.skills) {
      if (!names.has(ref)) errors.push(`Track "${t.id}" references unknown skill: ${ref}`);
    }
  }
  if (errors.length) {
    console.error("planning-tracks.yml validation errors:");
    for (const e of errors) console.error("  - " + e);
    process.exit(2);
  }
}

/** ── Rendering ────────────────────────────────────────────────────────── */

const CATALOG_NAME = "firefly-skills-catalog";

function categoryGroup(skills: SkillInfo[]): Map<string, SkillInfo[]> {
  const m = new Map<string, SkillInfo[]>();
  for (const s of skills) {
    if (s.name === CATALOG_NAME) continue; // self-reference excluded from category index
    const k = s.category;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(s);
  }
  return m;
}

function renderIndexTable(skills: SkillInfo[]): string {
  const rows = skills
    .filter((s) => s.name !== CATALOG_NAME)
    .map((s) => {
      const link = `[\`${s.name}\`](../${s.slug}/SKILL.md)`;
      const summary = s.summary.length > 140 ? s.summary.slice(0, 137) + "..." : s.summary;
      return `| ${link} | ${s.category} | ${escapeMd(summary)} |`;
    });
  return ["| Skill | Category | Purpose |", "|---|---|---|", ...rows].join("\n");
}

function renderTrack(track: PlanningTrack, skillsByName: Map<string, SkillInfo>): string {
  const lines: string[] = [];
  lines.push(`### ${track.intent}`);
  lines.push("");
  lines.push(`**When:** ${track.when}`);
  lines.push("");
  lines.push(`**Audience:** ${track.audience}    **Tier:** ${track.tier}`);
  lines.push("");
  lines.push("**Read in this order:**");
  lines.push("");
  let i = 1;
  for (const ref of track.skills) {
    const s = skillsByName.get(ref);
    if (!s) continue;
    const summary = s.summary.length > 110 ? s.summary.slice(0, 107) + "..." : s.summary;
    lines.push(`${i}. [\`${s.name}\`](../${s.slug}/SKILL.md) — ${escapeMd(summary)}`);
    i++;
  }
  return lines.join("\n");
}

function renderRecentlyUpdated(skills: SkillInfo[], days = 30): string {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = skills
    .filter((s) => s.lastModified >= cutoff && s.name !== CATALOG_NAME)
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 15);
  if (recent.length === 0) {
    return "_No skills have been updated in the last 30 days._";
  }
  const rows = recent.map((s) => {
    const when = new Date(s.lastModified).toISOString().slice(0, 10);
    return `| ${when} | [\`${s.name}\`](../${s.slug}/SKILL.md) | ${s.category} |`;
  });
  return ["| Last updated | Skill | Category |", "|---|---|---|", ...rows].join("\n");
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderExternalSection(
  results: { source: ExternalSource; skills: ExternalSkill[]; error?: string }[],
): string {
  const lines: string[] = [];

  lines.push("## External skills (auto-discovered)");
  lines.push("");
  lines.push(
    "> **Indexed for discoverability only, not endorsed by FocusGTS.** External skills are published and maintained by their respective authors. Each skill's quality, correctness, and currency are the responsibility of the publisher listed below. FocusGTS does not redistribute, modify, or warrant any external skill. Listed here so users navigating this catalog can find every known Firefly-related skill, not just ours.",
  );
  lines.push("");

  for (const { source, skills, error } of results) {
    lines.push(`### ${source.publisher} — \`${source.repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "")}\``);
    lines.push("");
    if (source.notes) {
      lines.push(source.notes.trim());
      lines.push("");
    }
    if (error) {
      lines.push(`_Scan failed for this source on the most recent generator run: ${escapeMd(error)}_`);
      lines.push("");
      continue;
    }
    if (skills.length === 0) {
      lines.push("_No relevant skills found in this source on the most recent scan. The relevance filter requires the skill's frontmatter or path to match one of: " +
        source.relevance_keywords.map((k) => `\`${k}\``).join(", ") + "._");
      lines.push("");
      continue;
    }

    lines.push("| Skill | Category | Last commit | Source |");
    lines.push("|---|---|---|---|");
    for (const s of skills.sort((a, b) => a.name.localeCompare(b.name))) {
      const when = s.lastCommitTs ? new Date(s.lastCommitTs).toISOString().slice(0, 10) : "—";
      const stale = s.lastCommitTs > 0 && Date.now() - s.lastCommitTs > 365 * 24 * 60 * 60 * 1000;
      const staleTag = stale ? " _(stale)_" : "";
      lines.push(`| [\`${s.name}\`](${s.htmlUrl}) | ${s.category} | ${when}${staleTag} | [${escapeMd(s.relPath)}](${s.htmlUrl}) |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderCatalog(skills: SkillInfo[], tracks: PlanningTrack[], external: { source: ExternalSource; skills: ExternalSkill[]; error?: string }[]): string {
  const skillsByName = new Map(skills.map((s) => [s.name, s]));
  const byCategory = categoryGroup(skills);
  const nonCatalogCount = skills.filter((s) => s.name !== CATALOG_NAME).length;
  const generatedAt = new Date().toISOString();

  const categorySections: string[] = [];
  for (const [cat, list] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sub: string[] = [];
    sub.push(`### ${cat}`);
    sub.push("");
    sub.push("| Skill | Purpose |");
    sub.push("|---|---|");
    for (const s of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const summary = s.summary.length > 140 ? s.summary.slice(0, 137) + "..." : s.summary;
      sub.push(`| [\`${s.name}\`](../${s.slug}/SKILL.md) | ${escapeMd(summary)} |`);
    }
    categorySections.push(sub.join("\n"));
  }

  const trackSections = tracks.map((t) => renderTrack(t, skillsByName)).join("\n\n");

  const frontmatter = `---
name: firefly-skills-catalog
description: Auto-generated catalog of every Claude Code skill in the @focusgts/firefly-services-skills plugin. Use this skill when you need to discover which Firefly Services skills exist, scope a new Firefly Services project, decide which skills are relevant to a given workflow, or get a planning-mode walkthrough that points to the right reading order. Trigger phrases include "what Firefly skills exist", "plan a Firefly project", "scope a Firefly engagement", "which Firefly skill should I use", "Firefly skills overview", "Firefly skills catalog", "find a Firefly skill". The catalog is regenerated by a GitHub Actions cron job daily; do not edit this file by hand — edit the source skills or config/planning-tracks.yml instead.
license: Apache-2.0
compatibility: Auto-generated. Do not edit by hand. Regenerated by scripts/catalog/build-catalog.ts on every push and by the daily GitHub Actions cron job.
metadata:
  version: "1.0.0"
  category: meta
  visibility: public
---`;

  const body = `# Firefly Skills Catalog

A self-updating index of every skill in this plugin. ${nonCatalogCount} skills are catalogued. This skill is regenerated automatically — \`scripts/catalog/build-catalog.ts\` runs on every push and on a daily cron, so it stays in sync with the rest of the repo without manual maintenance.

## When to use this skill

Use this skill when:
- You're scoping a new Firefly Services project and want to know which skills are relevant before reading anything
- You're navigating the catalog and want a structured overview without reading every SKILL.md
- You need to find a specific capability (custom models, video, batch processing, brand guardrails, etc.) but don't remember the skill name
- You're onboarding a new FocusGTS consultant and want a guided reading order
- You're auditing what coverage the catalog has across the Firefly Services surface area

Do **NOT** use this skill when:
- You already know the specific skill you need — invoke it directly
- You want detailed instructions for a single workflow — read that skill's SKILL.md directly
- You're contributing a new skill — read \`scripts/catalog/build-catalog.ts\` instead and verify your skill is well-formed

## Planning-mode tracks

Each track maps a real user intent to an ordered reading list. Pick the one closest to what you're trying to do, then read the listed skills in order.

${trackSections}

## Full index — grouped by category

${categorySections.join("\n\n")}

## Full index — alphabetical

${renderIndexTable(skills)}

## Recently updated

The 15 most recently updated skills (by git history) in the last 30 days:

${renderRecentlyUpdated(skills)}

${renderExternalSection(external)}

## How this skill is maintained

This SKILL.md is regenerated by \`scripts/catalog/build-catalog.ts\`:

- **Trigger**: every push to \`main\`, plus a daily GitHub Actions cron at 14:00 UTC.
- **Source**: the YAML frontmatter of every SKILL.md under \`plugins/firefly-services/skills/\`, the planning-track definitions in \`config/planning-tracks.yml\`, and the external sources listed in \`config/external-sources.yml\`.
- **External scan**: each external source listed in \`config/external-sources.yml\` is shallow-cloned (or fetched), filtered by relevance keywords, and surfaced in the catalog with a clear "indexed not endorsed" disclaimer.
- **Validation**: the generator fails CI if any SKILL.md is malformed or if a planning track references an unknown skill.

To add a new track, edit \`config/planning-tracks.yml\` and push. To add a new skill, drop a new SKILL.md into a new directory under \`plugins/firefly-services/skills/\`; the catalog will pick it up automatically.

## Provenance

- Catalog generated: \`${generatedAt}\`
- Total skills indexed: ${nonCatalogCount} (plus this meta-skill)
- Source: \`scripts/catalog/build-catalog.ts\`
- Planning tracks source: \`config/planning-tracks.yml\`
`;

  return frontmatter + "\n\n" + body;
}

function renderValidation(
  skills: SkillInfo[],
  tracks: PlanningTrack[],
  external: { source: ExternalSource; skills: ExternalSkill[]; error?: string }[],
): string {
  const generatedAt = new Date().toISOString();
  const nonCatalogCount = skills.filter((s) => s.name !== CATALOG_NAME).length;
  const externalCount = external.reduce((acc, e) => acc + e.skills.length, 0);
  const externalRows = external
    .map((e) => `| \`${e.source.id}\` | ${e.skills.length} | ${e.error ? "errored: " + escapeMd(e.error) : "ok"} |`)
    .join("\n");
  return `# Catalog validation log

Last run: \`${generatedAt}\`

| Metric | Value |
|---|---|
| Internal skills indexed | ${nonCatalogCount} (excluding the catalog skill itself) |
| External skills indexed | ${externalCount} (from ${external.length} source(s)) |
| Planning tracks | ${tracks.length} |
| Categories | ${new Set(skills.map((s) => s.category)).size} |
| Cross-references (internal) | ${skills.reduce((acc, s) => acc + s.references.length, 0)} |

## External source scan results

| Source | Matched skills | Status |
|---|---|---|
${externalRows || "_no external sources configured_"}

This file is regenerated by \`scripts/catalog/build-catalog.ts\` on every catalog build.
`;
}

/** ── Main ─────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const skills = await discoverSkills();
  const tracks = await readTracks();
  validateTracksAgainstSkills(tracks, skills);

  // External sources — best-effort. If git clone fails (no network in CI
  // sandbox, etc.), we surface the error in the catalog instead of failing
  // the whole build. Our own skills always render.
  const external = await discoverExternalSkills();

  // The catalog skill must already exist as a directory before we write to it.
  await fs.mkdir(CATALOG_SKILL_DIR, { recursive: true });

  const rendered = renderCatalog(skills, tracks, external);
  const validationLog = renderValidation(skills, tracks, external);

  await fs.writeFile(CATALOG_SKILL_PATH, rendered, "utf8");
  await fs.writeFile(CATALOG_VALIDATION_PATH, validationLog, "utf8");

  const nonCatalogCount = skills.filter((s) => s.name !== CATALOG_NAME).length;
  const externalCount = external.reduce((acc, e) => acc + e.skills.length, 0);
  console.log(`Catalog written: ${CATALOG_SKILL_PATH}`);
  console.log(`  ${nonCatalogCount} internal skills indexed`);
  console.log(`  ${externalCount} external skills indexed (from ${external.length} source(s))`);
  console.log(`  ${tracks.length} planning tracks`);
  console.log(`  ${new Set(skills.map((s) => s.category)).size} categories`);
  for (const e of external) {
    if (e.error) console.log(`  WARN: external source ${e.source.id} failed: ${e.error}`);
  }
}

main().catch((err) => {
  console.error("Catalog generator failed:");
  console.error(err);
  process.exit(1);
});
