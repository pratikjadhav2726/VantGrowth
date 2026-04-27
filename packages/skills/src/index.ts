import { readFile } from "node:fs/promises";
import { z } from "zod";

export const skillFrontmatterSchema = z.object({
  skill_id: z.string().min(1),
  version: z.number().int().positive(),
  compatible_agents: z.array(z.string().min(1)),
  required_memory: z.array(z.string().min(1)),
  output_schemas: z.array(z.string().min(1))
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

const FRONTMATTER_SEPARATOR = "---";

export const parseSkillMarkdown = (content: string): ParsedSkill => {
  const chunks = content.split(FRONTMATTER_SEPARATOR);
  if (chunks.length < 3) {
    throw new Error("Skill file missing frontmatter block.");
  }

  const rawYaml = chunks[1]?.trim() ?? "";
  const body = chunks.slice(2).join(FRONTMATTER_SEPARATOR).trim();
  const lines = rawYaml.split("\n").map((line) => line.trim());

  // Lightweight parser for strict key:value + list syntax to keep package dependency-light.
  const parsed: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("- ") && currentListKey) {
      const previous = (parsed[currentListKey] as string[]) ?? [];
      previous.push(line.slice(2).trim());
      parsed[currentListKey] = previous;
      continue;
    }
    const [key, value] = line.split(":").map((part) => part.trim());
    if (!key || value === undefined) continue;
    if (value === "") {
      parsed[key] = [];
      currentListKey = key;
      continue;
    }
    currentListKey = null;
    parsed[key] = key === "version" ? Number(value) : value;
  }

  return {
    frontmatter: skillFrontmatterSchema.parse(parsed),
    body
  };
};

export const loadSkillFromFile = async (path: string): Promise<ParsedSkill> => {
  const content = await readFile(path, "utf8");
  return parseSkillMarkdown(content);
};
