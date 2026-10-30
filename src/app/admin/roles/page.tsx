"use client";

import { useCallback, useEffect, useState } from "react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Page, PageAction, PageActions, PageStatus } from "@/components/layout/page";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { fetchJson, postJson, patchJson, deleteJson } from "@/lib/http";
import { useSessionPermissions } from "@/hooks/use-session-permissions";
import { ADMIN_ACTIONS } from "@/lib/permissions/statements";
import {
  ADMIN_SECTION_DEFINITIONS,
  BUILTIN_ROLES,
  ROLE_NAME_PATTERN,
  SESSION_ACTION_DEFINITIONS,
  SESSION_ACTIONS,
  USER_ACTION_DEFINITIONS,
  USER_ACTIONS,
  hasGrant,
  isRoleEditable,
  normalizeRolePermissions,
  type RoleDefinition,
  type RolePermissions,
} from "@/lib/permissions/roles";
import { KeyRound, Loader2, Plus, Pencil, Trash2 } from "lucide-react";

interface AdminRole extends RoleDefinition {
  userCount: number;
}

type PermissionResource = keyof RolePermissions;

const PERMISSION_GROUPS: ReadonlyArray<{
  resource: PermissionResource;
  title: string;
  description: string;
  actions: readonly string[];
  labels: Record<string, { label: string; description: string }>;
}> = [
  {
    resource: "admin",
    title: "Admin panel",
    description: "Sections this role may open.",
    actions: ADMIN_ACTIONS,
    labels: ADMIN_SECTION_DEFINITIONS,
  },
  {
    resource: "user",
    title: "Accounts",
    description: "What it may do to other accounts.",
    actions: USER_ACTIONS,
    labels: USER_ACTION_DEFINITIONS,
  },
  {
    resource: "session",
    title: "Sessions",
    description: "What it may see or end in a signed-in session.",
    actions: SESSION_ACTIONS,
    labels: SESSION_ACTION_DEFINITIONS,
  },
];

function emptyPermissions(): RolePermissions {
  return { admin: [], user: [], session: [] };
}

export default function AdminRolesPage() {
  const access = useSessionPermissions();
  const can = (resource: PermissionResource, action: string) =>
    access !== null && hasGrant(access.permissions, resource, action);
  const canManage = can("admin", "roles");

  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Create / edit dialog
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AdminRole | null>(null);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<RolePermissions>(emptyPermissions);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<AdminRole | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadRoles = useCallback(async () => {
    try {
      const data = await fetchJson<{ roles: AdminRole[] }>("/api/admin/roles");
      setRoles(data.roles ?? []);
      setLoadError(false);
    } catch (err) {
      console.error("Failed to load roles:", err);
      setRoles([...BUILTIN_ROLES].map((role) => ({ ...role, userCount: 0 })));
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  useEffect(() => {
    if (saveStatus === "idle") return;
    const timer = setTimeout(() => setSaveStatus("idle"), 3000);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  const openCreate = () => {
    setEditing(null);
    setName("");
    setLabel("");
    setDescription("");
    setPermissions(emptyPermissions());
    setFormError(null);
    setShowForm(true);
  };

  const openEdit = (role: AdminRole) => {
    setEditing(role);
    setName(role.name);
    setLabel(role.label);
    setDescription(role.description);
    setPermissions(normalizeRolePermissions(role.permissions));
    setFormError(null);
    setShowForm(true);
  };

  const toggle = (resource: PermissionResource, action: string, checked: boolean) => {
    setPermissions((prev) => {
      const next = { ...prev, [resource]: [...prev[resource]] };
      next[resource] = checked
        ? [...new Set([...next[resource], action])]
        : next[resource].filter((entry) => entry !== action);
      return normalizeRolePermissions(next);
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await patchJson(`/api/admin/roles/${editing.name}`, {
          label,
          description,
          permissions,
        });
      } else {
        await postJson("/api/admin/roles", { name, label, description, permissions });
      }
      setShowForm(false);
      setSaveStatus("success");
      await loadRoles();
    } catch (err) {
      console.error("Failed to save role:", err);
      setFormError(err instanceof Error ? err.message : "Could not save the role");
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteJson(`/api/admin/roles/${deleteTarget.name}`);
      setDeleteTarget(null);
      setSaveStatus("success");
      await loadRoles();
    } catch (err) {
      console.error("Failed to delete role:", err);
      setDeleteError(err instanceof Error ? err.message : "Could not delete the role");
      setSaveStatus("error");
    } finally {
      setDeleting(false);
    }
  };

  const nameValid = ROLE_NAME_PATTERN.test(name);
  const canSave = label.trim().length > 0 && (editing !== null || nameValid);

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1">
        <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
          <PageActions>
            <PageStatus status={saveStatus} failedLabel="Something went wrong" />
            <PageAction
              icon={Plus}
              label="New role"
              onClick={openCreate}
              disabled={!canManage}
              title={canManage ? "Create a role" : "Your role cannot manage roles"}
            />
          </PageActions>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : (
              roles.map((role, i) => (
                <div key={role.name}>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <div className="bg-muted/50 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
                      <KeyRound className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{role.label}</span>
                        <Badge variant="outline" className="rounded-full px-1.5 text-[10px]">
                          {role.name}
                        </Badge>
                        {role.builtin && (
                          <Badge variant="secondary" className="rounded-full px-1.5 text-[10px]">
                            built-in
                          </Badge>
                        )}
                      </div>
                      {role.description && (
                        <p className="text-muted-foreground text-xs">{role.description}</p>
                      )}
                      <p className="text-muted-foreground mt-1 text-[11px]">
                        {role.userCount} {role.userCount === 1 ? "account" : "accounts"} ·{" "}
                        {role.permissions.admin.length === 0
                          ? "no admin access"
                          : role.permissions.admin
                              .map((action) => ADMIN_SECTION_DEFINITIONS[action]?.label ?? action)
                              .join(", ")}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEdit(role)}
                        disabled={!canManage || !isRoleEditable(role.name)}
                        title={
                          isRoleEditable(role.name)
                            ? "Edit this role"
                            : "This anchor role cannot be edited"
                        }
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive h-8 w-8"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget(role);
                        }}
                        disabled={!canManage || role.builtin}
                        title={
                          role.builtin ? "Built-in roles cannot be deleted" : "Delete this role"
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {i < roles.length - 1 && <Separator className="px-4" />}
                </div>
              ))
            )}
            {loadError && (
              <p className="text-destructive px-4 py-3 text-xs">
                Could not load roles. showing the built-in set.
              </p>
            )}
          </div>
        </GlassPanel>
      </div>

      {/* Create / edit dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.label}` : "New role"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="role-name">Role id</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={editing !== null}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="helpdesk"
                aria-invalid={!editing && name.length > 0 && !nameValid}
              />
              <p className="text-muted-foreground text-xs">
                Stored on each account, so it never changes. Lowercase letters, digits and dashes.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="role-label">Label</Label>
              <Input
                id="role-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Helpdesk"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role-description">Description</Label>
              <Input
                id="role-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this role is for"
              />
            </div>

            {PERMISSION_GROUPS.map((group) => (
              <div key={group.resource} className="space-y-1">
                <Label>{group.title}</Label>
                <p className="text-muted-foreground text-[11px]">{group.description}</p>
                <div className="space-y-1 rounded border p-2">
                  {group.actions.map((action) => {
                    const definition = group.labels[action];
                    const checked = permissions[group.resource].includes(action);
                    // A delegated role manager cannot hand out what it lacks.
                    const allowed = can(group.resource, action);
                    return (
                      <label
                        key={action}
                        className="flex cursor-pointer items-start gap-2 py-1 text-xs"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          disabled={!allowed}
                          onCheckedChange={(value) => toggle(group.resource, action, value)}
                        />
                        <span className="min-w-0">
                          <span className="font-medium">{definition?.label ?? action}</span>
                          {definition?.description && (
                            <span className="text-muted-foreground block text-[11px] leading-tight">
                              {definition.description}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}

            {formError && <p className="text-destructive text-xs">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !canSave}>
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete role</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">
            Delete <span className="text-foreground font-medium">{deleteTarget?.label}</span>? Roles
            still assigned to an account cannot be deleted.
          </p>
          {deleteError && <p className="text-destructive text-xs">{deleteError}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
