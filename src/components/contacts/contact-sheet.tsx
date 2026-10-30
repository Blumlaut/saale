"use client";

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { postJson, patchJson } from "@/lib/http";
import type { Contact } from "@/types/shared";

interface ContactSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the sheet edits this contact; otherwise it creates one. */
  contact: Contact | null;
  onSaved: (contact: Contact) => void;
}

const INPUT_CLASS = "liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none";

export function ContactSheet({ open, onOpenChange, contact, onSaved }: ContactSheetProps) {
  const isEdit = contact !== null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // The sheet is conditionally mounted, so the form state seeds from props.
  const seed = contact
    ? {
        name: contact.name,
        email: contact.email,
        company: contact.company ?? "",
        notes: contact.notes ?? "",
      }
    : { name: "", email: "", company: "", notes: "" };

  const [form, setForm] = useState(seed);
  const [key, setKey] = useState(contact?.id ?? "new");

  // Re-seed when a different contact is opened (the sheet stays mounted).
  const nextKey = contact?.id ?? "new";
  if (nextKey !== key) {
    setKey(nextKey);
    setForm(seed);
    setError("");
  }

  const update = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || saving) return;

    setSaving(true);
    setError("");
    const payload = {
      name: form.name.trim(),
      email: form.email.trim(),
      ...(form.company.trim() ? { company: form.company.trim() } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    };

    try {
      const data = isEdit
        ? await patchJson<{ contact: Contact }>(`/api/contacts/${contact!.id}`, {
            ...payload,
            company: form.company.trim() || null,
            notes: form.notes.trim() || null,
          })
        : await postJson<{ contact: Contact }>("/api/contacts", payload);
      toast.success(isEdit ? "Contact updated" : "Contact saved");
      onSaved(data.contact);
      onOpenChange(false);
    } catch (err) {
      // http helpers throw Error with the API's message on non-2xx.
      const message = err instanceof Error && err.message ? err.message : "Failed to save contact";
      console.error("Failed to save contact:", err);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full max-w-[440px] flex-col overflow-hidden p-0">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
            <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
              {isEdit ? "Edit Contact" : "New Contact"}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground text-xs">
              {isEdit ? "Update this contact's details." : "Add someone to your contact book."}
            </SheetDescription>
          </SheetHeader>

          <form
            id="contact-sheet-form"
            onSubmit={handleSubmit}
            className="flex-1 overflow-y-auto px-6 py-5"
          >
            <div className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="contact-name" className="text-xs">
                  Name *
                </Label>
                <Input
                  id="contact-name"
                  value={form.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder="Jane Doe"
                  autoComplete="off"
                  className={INPUT_CLASS}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contact-email" className="text-xs">
                  Email *
                </Label>
                <Input
                  id="contact-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => update({ email: e.target.value })}
                  placeholder="jane@example.com"
                  autoComplete="off"
                  spellCheck={false}
                  className={INPUT_CLASS}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contact-company" className="text-xs">
                  Company
                </Label>
                <Input
                  id="contact-company"
                  value={form.company}
                  onChange={(e) => update({ company: e.target.value })}
                  placeholder="Acme Corp"
                  autoComplete="off"
                  className={INPUT_CLASS}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contact-notes" className="text-xs">
                  Notes
                </Label>
                <Textarea
                  id="contact-notes"
                  value={form.notes}
                  onChange={(e) => update({ notes: e.target.value })}
                  placeholder="How you met, context, preferences…"
                  rows={4}
                  className="liquid-glass-inner min-h-24 rounded-xl border-0 bg-transparent shadow-none"
                />
              </div>

              {error && (
                <div className="text-destructive bg-destructive/10 rounded-xl px-4 py-2.5 text-sm">
                  {error}
                </div>
              )}
            </div>
          </form>

          <div className="border-border/30 border-t px-6 py-4">
            <Button
              form="contact-sheet-form"
              type="submit"
              disabled={saving || !form.name.trim() || !form.email.trim()}
              className="h-9 w-full text-xs font-medium"
            >
              {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Contact"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
