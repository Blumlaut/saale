import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import {
  createContact,
  deleteContact,
  listContacts,
  updateContact,
  upsertContact,
  contactCreateSchema,
  contactUpdateSchema,
  type ContactDto,
} from "@/lib/contacts/contacts";

const CONTACT_SCHEMA = Type.Object({
  id: Type.String(),
  name: Type.String(),
  email: Type.String(),
  company: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  lastSentAt: Type.Union([Type.String(), Type.Null()]),
});

const CONTACT_LIST_SCHEMA = Type.Object({
  count: Type.Integer(),
  contacts: Type.Array(CONTACT_SCHEMA),
});

const CONTACT_SEARCH_SCHEMA = Type.Object({
  query: Type.String(),
  count: Type.Integer(),
  contacts: Type.Array(CONTACT_SCHEMA),
});

const CONTACT_CREATE_SCHEMA = Type.Object({
  contact: CONTACT_SCHEMA,
  /** "created" for a new row, "updated" when the email already existed. */
  created: Type.Boolean(),
});

const CONTACT_UPDATE_SCHEMA = Type.Object({
  contact: CONTACT_SCHEMA,
});

const CONTACT_DELETE_SCHEMA = Type.Object({
  deleted: Type.Boolean(),
});

function toToolContact(dto: ContactDto) {
  return {
    id: dto.id,
    name: dto.name,
    email: dto.email,
    company: dto.company,
    notes: dto.notes,
    lastSentAt: dto.lastSentAt,
  };
}

/**
 * Create contact-book tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user.
 */
export function createContactTools(userId: string): ToolDefinition[] {
  return [
    // ─── contacts_list ──────────────────────────────────────────────────────

    defineStructuredTool({
      name: "contacts_list",
      label: "List Contacts",
      description:
        "List the user's contact book — names, email addresses, company, notes, and when mail was last sent to each. Use it before sending mail when the user refers to someone by name.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum number of contacts to return. Default: 50.",
            default: 50,
          }),
        ),
      }),
      outputSchema: CONTACT_LIST_SCHEMA,
      execute: async (_toolCallId, params) => {
        const contacts = await listContacts(userId, { limit: params.limit ?? 50 });
        return {
          value: { count: contacts.length, contacts: contacts.map(toToolContact) },
          details: { count: contacts.length },
        };
      },
    }),

    // ─── contacts_search ────────────────────────────────────────────────────

    defineStructuredTool({
      name: "contacts_search",
      label: "Search Contacts",
      description:
        "Search the user's contact book by name, email, or company. Use it to resolve a person the user mentions into an email address before sending mail.",
      parameters: Type.Object({
        query: Type.String({
          description: "Search term, matched against name, email, and company.",
        }),
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum number of results. Default: 20.",
            default: 20,
          }),
        ),
      }),
      outputSchema: CONTACT_SEARCH_SCHEMA,
      execute: async (_toolCallId, params) => {
        const contacts = await listContacts(userId, {
          search: params.query,
          limit: params.limit ?? 20,
        });
        return {
          value: {
            query: params.query,
            count: contacts.length,
            contacts: contacts.map(toToolContact),
          },
          details: { count: contacts.length },
        };
      },
    }),

    // ─── contacts_create ────────────────────────────────────────────────────

    defineStructuredTool({
      name: "contacts_create",
      label: "Create Contact",
      description:
        "Add a contact to the user's contact book, or update the existing one when the email is already stored (the name is refreshed, company and notes are filled in when empty).",
      parameters: Type.Object({
        name: Type.String({ description: "Display name." }),
        email: Type.String({ description: "Email address." }),
        company: Type.Optional(Type.String({ description: "Optional company." })),
        notes: Type.Optional(Type.String({ description: "Optional notes." })),
      }),
      outputSchema: CONTACT_CREATE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const parsed = contactCreateSchema.parse({
          name: params.name,
          email: params.email,
          ...(params.company ? { company: params.company } : {}),
          ...(params.notes ? { notes: params.notes } : {}),
        });
        const fresh = await createContact(userId, parsed);
        if (fresh) {
          return {
            value: { contact: toToolContact(fresh), created: true },
            details: { email: fresh.email },
          };
        }
        const updated = await upsertContact(userId, parsed);
        return {
          value: { contact: toToolContact(updated), created: false },
          details: { email: updated.email },
        };
      },
    }),

    // ─── contacts_update ────────────────────────────────────────────────────

    defineStructuredTool({
      name: "contacts_update",
      label: "Update Contact",
      description: "Update one or more fields of a contact in the user's contact book.",
      parameters: Type.Object({
        id: Type.String({ description: "Contact ID." }),
        name: Type.Optional(Type.String({ description: "New display name." })),
        email: Type.Optional(Type.String({ description: "New email address." })),
        company: Type.Optional(
          Type.Union([Type.String(), Type.Null()], {
            description: "New company, or null to clear it.",
          }),
        ),
        notes: Type.Optional(
          Type.Union([Type.String(), Type.Null()], {
            description: "New notes, or null to clear them.",
          }),
        ),
      }),
      outputSchema: CONTACT_UPDATE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const parsed = contactUpdateSchema.parse({
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.email !== undefined ? { email: params.email } : {}),
          ...(params.company !== undefined ? { company: params.company } : {}),
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
        });
        const contact = await updateContact(userId, params.id, parsed);
        return {
          value: { contact: toToolContact(contact) },
          details: { id: contact.id },
        };
      },
    }),

    // ─── contacts_delete ────────────────────────────────────────────────────

    defineStructuredTool({
      name: "contacts_delete",
      label: "Delete Contact",
      description: "Permanently delete a contact from the user's contact book.",
      parameters: Type.Object({
        id: Type.String({ description: "Contact ID." }),
      }),
      outputSchema: CONTACT_DELETE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const deleted = await deleteContact(userId, params.id);
        if (!deleted) {
          throw new Error(`Contact ${params.id} not found`);
        }
        return {
          value: { deleted: true },
          details: { id: params.id },
        };
      },
    }),
  ];
}
