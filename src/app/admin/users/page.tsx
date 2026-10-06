"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Page } from "@/components/layout/page";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { fetchJson, postJson } from "@/lib/http";
import { authClient } from "@/lib/auth-client";
import { USERNAME_RULES, isValidUsername, normalizeUsername } from "@/lib/auth/username";
import {
  Users,
  Loader2,
  Plus,
  CheckCircle,
  AlertCircle,
  Trash2,
  Pencil,
  UserCog,
} from "lucide-react";

interface AdminUser {
  id: string;
  name: string;
  username: string | null;
  email: string;
  role: string;
  banned: boolean | null;
  createdAt: string;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Create user dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createUsername, setCreateUsername] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState<"user" | "admin">("user");
  const [creating, setCreating] = useState(false);

  // Edit user dialog
  const [showEdit, setShowEdit] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editRole, setEditRole] = useState<"user" | "admin">("user");
  const [editing, setEditing] = useState(false);

  const createUsernameValid = isValidUsername(createUsername);
  const editUsernameValid = isValidUsername(editUsername);

  // Delete confirm
  const [showDelete, setShowDelete] = useState(false);
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Impersonate
  const [impersonating, setImpersonating] = useState<string | null>(null);

  // Load users
  const loadUsers = useCallback(async () => {
    try {
      const data = await fetchJson<{ users: AdminUser[] }>(
        `/api/auth/admin/list-users?limit=200${search ? `&searchValue=${encodeURIComponent(search)}&searchField=email` : ""}`,
      );
      setUsers(data.users ?? []);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  // Auto-clear save status
  useEffect(() => {
    if (saveStatus !== "idle") {
      const timer = setTimeout(() => setSaveStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  const handleCreate = async () => {
    if (!createUsernameValid || !createEmail || !createPassword) return;
    setCreating(true);
    try {
      await postJson("/api/auth/admin/create-user", {
        name: createUsername.trim(),
        email: createEmail,
        password: createPassword,
        role: createRole,
        data: { username: normalizeUsername(createUsername) },
      });
      setShowCreate(false);
      setCreateUsername("");
      setCreateEmail("");
      setCreatePassword("");
      setCreateRole("user");
      setSaveStatus("success");
      await loadUsers();
    } catch {
      setSaveStatus("error");
    }
    setCreating(false);
  };

  const openEdit = (user: AdminUser) => {
    setEditUser(user);
    setEditUsername(user.username ?? "");
    setEditRole((user.role ?? "user") as "user" | "admin");
    setShowEdit(true);
  };

  const handleEdit = async () => {
    if (!editUser || !editUsernameValid) return;
    setEditing(true);
    try {
      const username = normalizeUsername(editUsername);
      // The handle is sent only when it actually changed: the username plugin
      // rejects an unchanged handle on its own record as already taken.
      if (username !== editUser.username) {
        await postJson("/api/auth/admin/update-user", {
          userId: editUser.id,
          data: { username },
        });
      }
      // Set role
      await postJson("/api/auth/admin/set-role", {
        userId: editUser.id,
        role: editRole,
      });
      setShowEdit(false);
      setEditUser(null);
      setSaveStatus("success");
      await loadUsers();
    } catch {
      setSaveStatus("error");
    }
    setEditing(false);
  };

  const openDelete = (user: AdminUser) => {
    setDeleteUser(user);
    setShowDelete(true);
  };

  const handleImpersonate = async (user: AdminUser) => {
    setImpersonating(user.id);
    try {
      await authClient.admin.impersonateUser({ userId: user.id });
      // eslint-disable-next-line react-hooks/immutability, @next/next/no-location-assign-relative-destination -- full page redirect after impersonation (session cookies change, reload required)
      window.location.href = "/dashboard/chat";
    } catch (err) {
      console.error("Failed to impersonate user:", err);
      setImpersonating(null);
      setSaveStatus("error");
    }
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    setDeleting(true);
    try {
      await postJson("/api/auth/admin/remove-user", {
        userId: deleteUser.id,
      });
      setShowDelete(false);
      setDeleteUser(null);
      setSaveStatus("success");
      await loadUsers();
    } catch {
      setSaveStatus("error");
    }
    setDeleting(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <Page className="gap-0">
      {/* User list — fills height, owns its toolbar (search + add) */}
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        <div className="border-border/30 flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <Input
            placeholder="Search by email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 min-w-0 flex-1 md:max-w-sm"
          />
          {search && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => setSearch("")}
            >
              Clear
            </Button>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {saveStatus === "success" && (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <CheckCircle className="h-3.5 w-3.5" /> Saved
              </span>
            )}
            {saveStatus === "error" && (
              <span className="text-destructive flex items-center gap-1 text-xs">
                <AlertCircle className="h-3.5 w-3.5" /> Error
              </span>
            )}
            <Button
              variant="default"
              size="icon"
              className="h-8 w-8 md:w-auto md:px-3"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden md:inline">Add</span>
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {users.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
              <Users className="text-muted-foreground/50 mb-3 h-8 w-8" />
              <p className="text-sm font-medium">No users found</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {search ? "Try a different search term" : "Add a user to get started"}
              </p>
            </div>
          ) : (
            users.map((user, i) => (
              <div key={user.id}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="bg-muted/50 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold">
                    {(user.name ?? user.email)[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{user.name ?? "—"}</span>
                      {user.role === "admin" && (
                        <Badge variant="secondary" className="rounded-full px-1.5 text-[10px]">
                          admin
                        </Badge>
                      )}
                      {user.banned && (
                        <Badge variant="destructive" className="rounded-full px-1.5 text-[10px]">
                          banned
                        </Badge>
                      )}
                    </div>
                    <span className="text-muted-foreground truncate text-xs">
                      {user.username ? `@${user.username} · ${user.email}` : user.email}
                    </span>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleImpersonate(user)}
                      disabled={impersonating === user.id || user.role === "admin"}
                      title={
                        user.role === "admin"
                          ? "Cannot impersonate admins"
                          : "Impersonate this user"
                      }
                    >
                      {impersonating === user.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <UserCog className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEdit(user)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive h-8 w-8"
                      onClick={() => openDelete(user)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {i < users.length - 1 && <Separator className="px-4" />}
              </div>
            ))
          )}
        </div>
      </GlassPanel>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create user</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input
                value={createUsername}
                onChange={(e) => setCreateUsername(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="ada.lovelace"
                aria-invalid={Boolean(createUsername) && !createUsernameValid}
              />
              <p
                className={
                  createUsername && !createUsernameValid
                    ? "text-destructive text-xs"
                    : "text-muted-foreground text-xs"
                }
              >
                {USERNAME_RULES}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                type="email"
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                type="password"
                placeholder="Minimum 8 characters"
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <div className="flex gap-2">
                <Button
                  variant={createRole === "user" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setCreateRole("user")}
                  className="flex-1"
                >
                  User
                </Button>
                <Button
                  variant={createRole === "admin" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setCreateRole("admin")}
                  className="flex-1"
                >
                  Admin
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creating || !createUsernameValid || !createEmail || !createPassword}
            >
              {creating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input
                value={editUsername}
                onChange={(e) => setEditUsername(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="ada.lovelace"
                aria-invalid={Boolean(editUsername) && !editUsernameValid}
              />
              <p
                className={
                  editUsername && !editUsernameValid
                    ? "text-destructive text-xs"
                    : "text-muted-foreground text-xs"
                }
              >
                {USERNAME_RULES}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <div className="flex gap-2">
                <Button
                  variant={editRole === "user" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEditRole("user")}
                  className="flex-1"
                >
                  User
                </Button>
                <Button
                  variant={editRole === "admin" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEditRole("admin")}
                  className="flex-1"
                >
                  Admin
                </Button>
              </div>
            </div>
            {editUser && <div className="text-muted-foreground text-xs">{editUser.email}</div>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowEdit(false)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={editing || !editUsernameValid}>
              {editing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm">
              Are you sure you want to delete{" "}
              <span className="font-medium">{deleteUser?.email}</span>? This cannot be undone.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>
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
