"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteJson, fetchJson, postJson } from "@/lib/http";
import type { SkillView } from "@/lib/skills/shared";

/** What the install sheet sends: the skill's text, or an address to read it from. */
export interface InstallSkillInput {
  markdown?: string;
  url?: string;
}

/**
 * The skills the user installed for all of their chats.
 *
 * Installing or removing one evicts their pooled chats on the server, so the
 * next message of a running conversation sees the new list.
 */
export function useSkills() {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      const data = await fetchJson<{ skills: SkillView[] }>("/api/skills");
      setSkills(data.skills);
      setError(null);
    } catch (err) {
      console.error("Failed to load skills:", err);
      setError((err as Error).message || "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const installSkill = useCallback(
    async (input: InstallSkillInput): Promise<SkillView> => {
      const data = await postJson<{ skill: SkillView }>("/api/skills", input);
      await loadSkills();
      return data.skill;
    },
    [loadSkills],
  );

  const removeSkill = useCallback(
    async (name: string): Promise<void> => {
      await deleteJson(`/api/skills/${encodeURIComponent(name)}`);
      await loadSkills();
    },
    [loadSkills],
  );

  return { skills, loading, error, loadSkills, installSkill, removeSkill };
}
