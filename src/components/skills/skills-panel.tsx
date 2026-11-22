"use client";

import { useState } from "react";
import { BookOpen, MoreVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Spinner } from "@/components/ui/spinner";
import { useSkills } from "@/hooks/use-skills";
import type { SkillView } from "@/lib/skills/shared";
import { SkillAddDialog } from "@/components/skills/skill-add-dialog";

/**
 * Settings → Skills. A skill installed here is read by every chat of this
 * account, whichever project it works in.
 */
export function SkillsPanel() {
  const { skills, loading, installSkill, removeSkill } = useSkills();
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SkillView | null>(null);

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await removeSkill(pendingDelete.name);
    } catch (err) {
      console.error("Failed to remove a skill:", err);
      throw err;
    }
  };

  return (
    <>
      <GlassPanel>
        <GlassPanelContent className="p-0">
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-5 pb-4 md:px-6">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-lg font-medium">
                <BookOpen className="h-5 w-5" />
                Skills
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Instructions the assistant loads when a task matches. An installed skill is offered
                in every chat, and in the projects you work in.
              </p>
            </div>
            <Button size="sm" aria-label="Add skill" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 md:mr-2" />
              <span className="hidden md:inline">Add skill</span>
            </Button>
          </div>

          <Separator />

          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Spinner className="text-muted-foreground h-5 w-5" />
            </div>
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-10 text-center md:px-6">
              <BookOpen className="text-muted-foreground/50 h-8 w-8" />
              <p className="text-muted-foreground mt-3 text-sm">
                No skills yet. Add one from a SKILL.md file or an address that serves one.
              </p>
            </div>
          ) : (
            <div>
              {skills.map((skill, index) => (
                <div key={skill.name}>
                  {index > 0 && <Separator />}
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3 md:px-6">
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-sm font-medium">{skill.name}</span>
                      <p className="text-muted-foreground mt-1 text-xs">{skill.description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={(triggerProps) => (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0"
                              aria-label={`Actions for ${skill.name}`}
                              {...triggerProps}
                            >
                              <MoreVertical />
                            </Button>
                          )}
                        />
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setPendingDelete(skill)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      <SkillAddDialog open={addOpen} onOpenChange={setAddOpen} onInstall={installSkill} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Remove ${pendingDelete?.name ?? "this skill"}?`}
        description="The assistant stops offering this skill in your chats. Its files leave your workspace."
        confirmLabel="Remove"
        busyLabel="Removing…"
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}
