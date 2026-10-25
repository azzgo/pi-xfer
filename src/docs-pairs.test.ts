/**
 * docs-pairs.test.ts — every human-facing document ships an English original and
 * a Chinese mirror, and the two stay structurally in step.
 *
 * The rule lives in `docs/i18n.md`: the Chinese counterpart is the same path
 * with `.zh.md` instead of `.md`, code fences and shared assets are never
 * translated, and links between documents point at the counterpart. A pair that
 * drifts is a review failure; this test catches the half that can be checked
 * mechanically.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = path.join(import.meta.dirname, "..");
const skippedDirectories = new Set(["node_modules", ".git", ".agents", ".pi", ".pig", "skills", "dist"]);
const provenance = "英文原文";

function markdownFiles(directory = root, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skippedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      markdownFiles(absolute, found);
      continue;
    }
    if (entry.name.endsWith(".md")) found.push(path.relative(root, absolute));
  }
  return found.sort();
}

const chineseOf = (file: string): string => file.replace(/\.md$/, ".zh.md");
const englishOf = (file: string): string => file.replace(/\.zh\.md$/, ".md");

const englishFiles = markdownFiles().filter((file) => !file.endsWith(".zh.md"));
const chineseFiles = markdownFiles().filter((file) => file.endsWith(".zh.md"));

const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf-8");

function codeFences(source: string): string[] {
  return [...source.matchAll(/^```([^\n]*)\n([\s\S]*?)^```$/gm)].map((match) => match[2]!.trim());
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function stripCode(source: string): string {
  return source
    .replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

function relativeDocLinks(source: string): string[] {
  const body = stripCode(source).split("\n");
  const withoutProvenance = body.filter((line) => !line.startsWith("> 中文版")).join("\n");
  return [...withoutProvenance.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^(?:[a-z]+:|\/|#)/i.test(target))
    .map((target) => target.split("#")[0]!)
    .filter((target) => target.endsWith(".md"));
}

describe("bilingual documentation pairs", () => {
  it("every English document has a Chinese counterpart", () => {
    const missing = englishFiles.filter((file) => !fs.existsSync(path.join(root, chineseOf(file))));
    assert.deepEqual(missing, [], `missing Chinese counterparts — add <file>.zh.md for: ${missing.join(", ")}`);
  });

  it("every Chinese file has an English original", () => {
    const orphans = chineseFiles.filter((file) => !fs.existsSync(path.join(root, englishOf(file))));
    assert.deepEqual(orphans, [], `orphan Chinese files with no English original: ${orphans.join(", ")}`);
  });

  it("each Chinese file keeps the English structure: headings, fences, images", () => {
    const drifted: string[] = [];
    for (const file of englishFiles) {
      const chinese = chineseOf(file);
      if (!fs.existsSync(path.join(root, chinese))) continue;
      const original = read(file);
      const mirror = read(chinese);
      const shape = (source: string) => ({
        headings: count(source, /^#{1,6}\s/gm),
        fences: count(source, /^```/gm),
        images: count(source, /!\[[^\]]*\]\([^)]*\)/g),
      });
      const a = shape(original);
      const b = shape(mirror);
      if (a.headings !== b.headings || a.fences !== b.fences || a.images !== b.images) {
        drifted.push(`${chinese}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
      }
    }
    assert.deepEqual(drifted, [], `structural drift between an English document and its mirror:\n${drifted.join("\n")}`);
  });

  it("each Chinese file keeps the English code blocks verbatim", () => {
    const drifted: string[] = [];
    for (const file of englishFiles) {
      const chinese = chineseOf(file);
      if (!fs.existsSync(path.join(root, chinese))) continue;
      const original = codeFences(read(file));
      const mirror = codeFences(read(chinese));
      if (original.length !== mirror.length) {
        drifted.push(`${chinese}: ${mirror.length} code blocks, English has ${original.length}`);
        continue;
      }
      for (let index = 0; index < original.length; index += 1) {
        if (original[index] !== mirror[index]) {
          drifted.push(`${chinese}: code block #${index + 1} differs from the English original`);
        }
      }
    }
    assert.deepEqual(drifted, [], `code must not be translated:\n${drifted.join("\n")}`);
  });

  it("Chinese links point at Chinese counterparts, and link the same documents", () => {
    const problems: string[] = [];
    for (const file of englishFiles) {
      const chinese = chineseOf(file);
      if (!fs.existsSync(path.join(root, chinese))) continue;
      const englishTargets = relativeDocLinks(read(file)).map((target) => path.posix.basename(target));
      const chineseTargets = relativeDocLinks(read(chinese)).map((target) => path.posix.basename(target));
      const expected = englishTargets.map((target) => target.replace(/\.md$/, ".zh.md")).sort();
      const actual = chineseTargets.sort();
      if (expected.join(",") !== actual.join(",")) {
        problems.push(`${chinese}: links ${actual.join(", ") || "(none)"} — expected ${expected.join(", ") || "(none)"}`);
      }
    }
    assert.deepEqual(problems, [], `relative document links:\n${problems.join("\n")}`);
  });

  it("each Chinese file names its English original", () => {
    const missing = chineseFiles.filter((file) => !read(file).slice(0, 400).includes(provenance));
    assert.deepEqual(missing, [], `missing a provenance line ("${provenance}") near the top: ${missing.join(", ")}`);
  });

  it("shared assets are referenced, never copied", () => {
    const copies = fs
      .readdirSync(path.join(root, "docs", "guides", "assets"))
      .filter((name) => /\.(?:zh|cn)\./.test(name));
    assert.deepEqual(copies, [], `translated asset copies are not allowed — reference the shared file: ${copies.join(", ")}`);
  });
});
