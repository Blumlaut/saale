"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { fetchJson, deleteJson } from "@/lib/http";
import { setCurrentUserImage } from "@/hooks/use-current-user-image";
import { authClient } from "@/lib/auth-client";
import { isValidUsername, normalizeUsername, USERNAME_RULES } from "@/lib/auth/username";
import {
  AVATAR_MAX_UPLOAD_BYTES,
  AVATAR_MIME_TYPES,
  AVATAR_SIZE,
} from "@/lib/profile/avatar-config";
import { toast } from "sonner";
import { ImageUp, Loader2, LogOut, Trash2 } from "lucide-react";

export interface ProfileUser {
  name: string | null;
  username: string | null;
  email: string;
  image: string | null;
  /** ISO date the account was created. */
  createdAt: string;
}

/** First letters of the display name, for the fallback when there is no photo. */
function initials(name: string | null, email: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return email[0]?.toUpperCase() ?? "?";
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function ProfileSection({ user }: { user: ProfileUser }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [image, setImage] = useState(user.image);
  const [name, setName] = useState(user.name ?? "");
  const [username, setUsername] = useState(user.username ?? "");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanName = name.trim();
  const cleanUsername = normalizeUsername(username);
  const usernameProblem = isValidUsername(cleanUsername) ? null : USERNAME_RULES;
  const dirty = cleanName !== (user.name ?? "") || cleanUsername !== (user.username ?? "");

  const memberSince = new Date(user.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
  });

  const uploadPicture = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await fetchJson<{ image: string }>("/api/profile/avatar", {
        method: "POST",
        body: form,
      });
      setImage(data.image);
      setCurrentUserImage(data.image);
      router.refresh();
      toast.success("Photo updated");
    } catch (err) {
      console.error("Failed to upload the profile picture:", err);
      setError(err instanceof Error ? err.message : "Could not save that image");
    } finally {
      setUploading(false);
    }
  };

  const removePicture = async () => {
    setUploading(true);
    setError(null);
    try {
      await deleteJson("/api/profile/avatar");
      setImage(null);
      setCurrentUserImage(null);
      router.refresh();
      toast.success("Photo removed");
    } catch (err) {
      console.error("Failed to remove the profile picture:", err);
      setError(err instanceof Error ? err.message : "Could not remove the picture");
    } finally {
      setUploading(false);
    }
  };

  const saveDetails = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!cleanName || usernameProblem) return;

    setSaving(true);
    setError(null);
    const { error: updateError } = await authClient.updateUser({
      name: cleanName,
      username: cleanUsername,
    });
    setSaving(false);

    if (updateError) {
      setError(updateError.message ?? "Could not save your details");
      return;
    }

    router.refresh();
    toast.success("Profile saved");
  };

  return (
    <GlassPanel>
      <GlassPanelContent className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar className="size-20 shrink-0">
            {image ? <AvatarImage src={image} alt="" /> : null}
            <AvatarFallback className="text-xl">{initials(user.name, user.email)}</AvatarFallback>
          </Avatar>

          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ImageUp className="h-3.5 w-3.5" />
                )}
                {image ? "Change photo" : "Add photo"}
              </Button>
              {image ? (
                <Button variant="ghost" size="sm" disabled={uploading} onClick={removePicture}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              ) : null}
            </div>
            <p className="text-muted-foreground text-xs">
              Cropped to a square and stored at {AVATAR_SIZE}&times;{AVATAR_SIZE}. PNG, JPEG, WebP,
              GIF or AVIF up to {Math.round(AVATAR_MAX_UPLOAD_BYTES / (1024 * 1024))} MB.
            </p>
          </div>

          <input
            ref={fileInput}
            type="file"
            accept={AVATAR_MIME_TYPES.join(",")}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadPicture(file);
            }}
          />
        </div>

        <Separator />

        <form onSubmit={saveDetails} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="profile-name">Display name</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                autoComplete="name"
                placeholder="Your name"
              />
              <p className="text-muted-foreground text-xs">Shown in the app and on your commits.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="profile-username">Username</Label>
              <Input
                id="profile-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                spellCheck={false}
                aria-invalid={usernameProblem ? true : undefined}
                aria-describedby="profile-username-hint"
              />
              <p
                id="profile-username-hint"
                className={
                  usernameProblem ? "text-destructive text-xs" : "text-muted-foreground text-xs"
                }
              >
                {usernameProblem ?? "You sign in with this."}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-email">Email</Label>
            <Input id="profile-email" value={user.email} readOnly disabled />
            <p className="text-muted-foreground text-xs">Ask an admin to change this.</p>
          </div>

          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">Member since {memberSince}</p>
            <Button type="submit" disabled={saving || !dirty || !!usernameProblem || !cleanName}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save changes
            </Button>
          </div>
        </form>

        <Separator />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Sign out everywhere</p>
            <p className="text-muted-foreground text-xs">
              Ends every other session, including other devices.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const { error: signOutError } = await authClient.revokeOtherSessions();
              if (signOutError) {
                setError(signOutError.message ?? "Could not sign out the other sessions");
                return;
              }
              toast.success("Other sessions signed out");
            }}
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out others
          </Button>
        </div>
      </GlassPanelContent>
    </GlassPanel>
  );
}
