import * as fs from "node:fs";
import * as path from "node:path";

/** Agent Host kinds `install` knows how to write an overlay for. */
export type AgentHost = "cursor" | "generic";

export const AGENT_HOSTS: readonly AgentHost[] = ["cursor", "generic"];

export interface InstallOptions {
  /** Agent Host kind; must be one of AGENT_HOSTS. */
  host: string;
  /** Target skill directory (created if missing). */
  into: string;
  /** Agent name baked into the recommended launch command. */
  name: string;
  /** Recommended launch command, generated at install time. */
  launchCommand: string;
  /** Template root override; defaults to the in-repo skills/xfer-agent. */
  skillsRoot?: string;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

export interface InstallResult {
  files: string[];
  configPath: string;
}

/**
 * Install the xfer-agent skill into `into`: the generic SKILL.md, the
 * self-install install.md, a host overlay page, and `.xfer-agent.json` with the
 * host kind + defaults. The recommended launch command is baked into the docs
 * at install time, so an agent never constructs flags itself.
 */
export function installAgentSkill(options: InstallOptions): InstallResult {
  if (!AGENT_HOSTS.includes(options.host as AgentHost)) {
    throw new Error(`unknown host "${options.host}" — supported: ${AGENT_HOSTS.join(", ")}`);
  }
  const root = options.skillsRoot ?? findSkillsRoot();
  const into = options.into;
  fs.mkdirSync(into, { recursive: true });

  const render = (text: string): string =>
    text
      .replaceAll("{{LAUNCH_COMMAND}}", options.launchCommand)
      .replaceAll("{{NAME}}", options.name)
      .replaceAll("{{HOST}}", options.host);

  const files: string[] = [];
  const write = (target: string, content: string): void => {
    fs.writeFileSync(target, content, { encoding: "utf-8", mode: 0o644 });
    files.push(target);
  };

  write(path.join(into, "SKILL.md"), render(readTemplate(root, "SKILL.md")));
  write(path.join(into, "install.md"), render(readTemplate(root, "install.md")));
  write(path.join(into, `overlay-${options.host}.md`), render(readTemplate(root, path.join("hosts", `${options.host}.md`))));

  const configPath = path.join(into, ".xfer-agent.json");
  const config = {
    host: options.host,
    name: options.name,
    launchCommand: options.launchCommand,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  write(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return { files, configPath };
}

/** Resolve the in-repo skill template root from the bundle or the source tree. */
export function findSkillsRoot(baseDir: string = import.meta.dirname): string {
  const candidates = [
    path.join(baseDir, "skills", "xfer-agent"),
    path.join(baseDir, "..", "skills", "xfer-agent"),
    path.join(baseDir, "..", "..", "skills", "xfer-agent"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate;
  }
  throw new Error(`xfer-agent skill templates not found — looked in ${candidates.join(", ")}`);
}

function readTemplate(root: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(root, rel), "utf-8");
  } catch (err) {
    throw new Error(`missing skill template ${rel} under ${root} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
