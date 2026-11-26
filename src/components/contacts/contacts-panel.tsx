"use client";

import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { fetchJson, deleteJson } from "@/lib/http";
import { toast } from "sonner";
import { useLinkedRow } from "@/hooks/use-linked-row";
import { ContactList } from "@/components/contacts/contact-list";
import { ContactSheet } from "@/components/contacts/contact-sheet";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import type { Contact } from "@/types/shared";

/**
 * Contact book: list, create/edit sheet and delete confirmation.
 * Rendered inside a tab on the mail page; manages its own data.
 */
export function ContactsPanel() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState<Contact | null>(null);
  // A ⌘K row for one contact opens the page with that contact's sheet up.
  const linkedContactId = useSearchParams().get("id");

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ contacts: Contact[] }>("/api/contacts?limit=500");
      setContacts(data.contacts);
    } catch (err) {
      console.error("Failed to load contacts:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = useCallback(() => {
    setEditing(null);
    setSheetOpen(true);
  }, []);

  const handleEdit = useCallback((contact: Contact) => {
    setEditing(contact);
    setSheetOpen(true);
  }, []);

  const matchesContact = useCallback((contact: Contact, id: string) => contact.id === id, []);

  useLinkedRow(linkedContactId, contacts, matchesContact, handleEdit);

  const handleSaved = useCallback((saved: Contact) => {
    setContacts((prev) => {
      const exists = prev.some((c) => c.id === saved.id);
      return exists ? prev.map((c) => (c.id === saved.id ? saved : c)) : [...prev, saved];
    });
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    try {
      await deleteJson(`/api/contacts/${deleting.id}`);
      setContacts((prev) => prev.filter((c) => c.id !== deleting.id));
      toast.success("Contact deleted");
    } catch (err) {
      console.error("Failed to delete contact:", err);
      throw err;
    }
  }, [deleting]);

  return (
    <>
      <div className="min-h-0 flex-1">
        <ContactList
          contacts={contacts}
          loading={loading}
          onAdd={handleAdd}
          onEdit={handleEdit}
          onDelete={setDeleting}
        />
      </div>

      <ContactSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        contact={editing}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? "this contact"}?`}
        description={`${deleting?.email ?? ""} will be permanently removed from your contact book.`}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}
