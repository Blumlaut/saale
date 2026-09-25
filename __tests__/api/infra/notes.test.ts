import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockRequireSession = vi.fn();
const mockInfraMachineFindFirst = vi.fn();
const mockInfraNoteFindMany = vi.fn();
const mockInfraNoteCreate = vi.fn();
const mockInfraNoteFindFirst = vi.fn();
const mockInfraNoteUpdate = vi.fn();
const mockInfraNoteDelete = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    infraMachine: {
      findFirst: (...args: unknown[]) => mockInfraMachineFindFirst(...args),
    },
    infraNote: {
      findMany: (...args: unknown[]) => mockInfraNoteFindMany(...args),
      create: (...args: unknown[]) => mockInfraNoteCreate(...args),
      findFirst: (...args: unknown[]) => mockInfraNoteFindFirst(...args),
      update: (...args: unknown[]) => mockInfraNoteUpdate(...args),
      delete: (...args: unknown[]) => mockInfraNoteDelete(...args),
    },
  },
}));

import { GET as listNotes, POST as createNote } from "@/app/api/infra/machines/[id]/notes/route";
import {
  PATCH as updateNote,
  DELETE as deleteNote,
} from "@/app/api/infra/machines/[id]/notes/[noteId]/route";

const USER_ID = "user-1";
const MACHINE_ID = "m-1";
const NOTE_ID = "n-1";

function auth() {
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
}

function listRequest(search = "") {
  return new NextRequest(`http://localhost/api/infra/machines/${MACHINE_ID}/notes${search}`);
}

function noteRequest(method: "PATCH" | "DELETE") {
  return new NextRequest(`http://localhost/api/infra/machines/${MACHINE_ID}/notes/${NOTE_ID}`, {
    method,
  });
}

function listParams() {
  return { params: Promise.resolve({ id: MACHINE_ID }) };
}

function noteParams() {
  return { params: Promise.resolve({ id: MACHINE_ID, noteId: NOTE_ID }) };
}

const NOTE_DATE = new Date("2025-01-02T03:04:05.000Z");

function dbNote(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE_ID,
    machineId: MACHINE_ID,
    title: "Nginx config",
    content: "/etc/nginx/nginx.conf",
    category: "paths",
    createdAt: NOTE_DATE,
    updatedAt: NOTE_DATE,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth();
});

// ─── GET /api/infra/machines/[id]/notes ───────────────────────────────

describe("GET notes", () => {
  it("returns the machine's notes with ISO dates", async () => {
    mockInfraMachineFindFirst.mockResolvedValue({ id: MACHINE_ID });
    mockInfraNoteFindMany.mockResolvedValue([dbNote()]);

    const res = await listNotes(listRequest(), listParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]).toMatchObject({
      id: NOTE_ID,
      title: "Nginx config",
      content: "/etc/nginx/nginx.conf",
      category: "paths",
    });
    expect(body.notes[0].updatedAt).toBe(NOTE_DATE.toISOString());

    // Notes are always scoped to the (already verified) machine, newest first
    expect(mockInfraNoteFindMany).toHaveBeenCalledWith({
      where: { machineId: MACHINE_ID },
      orderBy: { updatedAt: "desc" },
    });
  });

  it("passes the category filter through", async () => {
    mockInfraMachineFindFirst.mockResolvedValue({ id: MACHINE_ID });
    mockInfraNoteFindMany.mockResolvedValue([]);

    await listNotes(listRequest("?category=services"), listParams());

    expect(mockInfraNoteFindMany).toHaveBeenCalledWith({
      where: { machineId: MACHINE_ID, category: "services" },
      orderBy: { updatedAt: "desc" },
    });
  });

  it("returns 404 for a machine owned by another user", async () => {
    // Machine lookup is scoped to the authed user; another user's machine → null
    mockInfraMachineFindFirst.mockResolvedValue(null);

    const res = await listNotes(listRequest(), listParams());

    expect(res.status).toBe(404);
    expect(mockInfraNoteFindMany).not.toHaveBeenCalled();
  });

  it("verifies machine ownership with the authed userId", async () => {
    mockInfraMachineFindFirst.mockResolvedValue({ id: MACHINE_ID });
    mockInfraNoteFindMany.mockResolvedValue([]);

    await listNotes(listRequest(), listParams());

    expect(mockInfraMachineFindFirst).toHaveBeenCalledWith({
      where: { id: MACHINE_ID, userId: USER_ID },
      select: { id: true },
    });
  });
});

// ─── POST /api/infra/machines/[id]/notes ──────────────────────────────

describe("POST notes", () => {
  it("creates a note with the provided category", async () => {
    mockInfraMachineFindFirst.mockResolvedValue({ id: MACHINE_ID });
    mockInfraNoteCreate.mockResolvedValue(dbNote({ category: "quirks", title: "DNS quirk" }));

    const req = new NextRequest(`http://localhost/api/infra/machines/${MACHINE_ID}/notes`, {
      method: "POST",
      body: JSON.stringify({
        title: "DNS quirk",
        content: "resolv.conf is regenerated",
        category: "quirks",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createNote(req, listParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.note.title).toBe("DNS quirk");
    expect(body.note.category).toBe("quirks");
    expect(mockInfraNoteCreate).toHaveBeenCalledWith({
      data: {
        machineId: MACHINE_ID,
        title: "DNS quirk",
        content: "resolv.conf is regenerated",
        category: "quirks",
      },
    });
  });

  it("defaults the category to general when omitted", async () => {
    mockInfraMachineFindFirst.mockResolvedValue({ id: MACHINE_ID });
    mockInfraNoteCreate.mockResolvedValue(dbNote());

    const req = new NextRequest(`http://localhost/api/infra/machines/${MACHINE_ID}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "T1", content: "C1" }),
      headers: { "Content-Type": "application/json" },
    });

    await createNote(req, listParams());

    expect(mockInfraNoteCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ category: "general" }) }),
    );
  });

  it("returns 400 when content is missing", async () => {
    mockInfraMachineFindFirst.mockResolvedValue({ id: MACHINE_ID });

    const req = new NextRequest(`http://localhost/api/infra/machines/${MACHINE_ID}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "Only a title" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createNote(req, listParams());

    expect(res.status).toBe(400);
    expect(mockInfraNoteCreate).not.toHaveBeenCalled();
  });

  it("returns 404 for a machine owned by another user", async () => {
    mockInfraMachineFindFirst.mockResolvedValue(null);

    const req = new NextRequest(`http://localhost/api/infra/machines/${MACHINE_ID}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "T", content: "C" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createNote(req, listParams());

    expect(res.status).toBe(404);
    expect(mockInfraNoteCreate).not.toHaveBeenCalled();
  });
});

// ─── PATCH /api/infra/machines/[id]/notes/[noteId] ────────────────────

describe("PATCH note", () => {
  it("updates only the provided fields", async () => {
    mockInfraNoteFindFirst.mockResolvedValue(dbNote({ machine: { userId: USER_ID } }));
    mockInfraNoteUpdate.mockResolvedValue(dbNote({ title: "New title", updatedAt: NOTE_DATE }));

    const req = new NextRequest(
      `http://localhost/api/infra/machines/${MACHINE_ID}/notes/${NOTE_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "New title" }),
        headers: { "Content-Type": "application/json" },
      },
    );

    const res = await updateNote(req, noteParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.note.title).toBe("New title");
    expect(mockInfraNoteUpdate).toHaveBeenCalledWith({
      where: { id: NOTE_ID },
      data: { title: "New title" },
    });
  });

  it("returns 404 for a note owned by another user", async () => {
    mockInfraNoteFindFirst.mockResolvedValue(dbNote({ machine: { userId: "someone-else" } }));

    const req = new NextRequest(
      `http://localhost/api/infra/machines/${MACHINE_ID}/notes/${NOTE_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "Hijacked" }),
        headers: { "Content-Type": "application/json" },
      },
    );

    const res = await updateNote(req, noteParams());

    expect(res.status).toBe(404);
    expect(mockInfraNoteUpdate).not.toHaveBeenCalled();
  });
});

// ─── DELETE /api/infra/machines/[id]/notes/[noteId] ───────────────────

describe("DELETE note", () => {
  it("deletes the note", async () => {
    mockInfraNoteFindFirst.mockResolvedValue(dbNote({ machine: { userId: USER_ID } }));
    mockInfraNoteDelete.mockResolvedValue({ id: NOTE_ID });

    const res = await deleteNote(noteRequest("DELETE"), noteParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ deleted: true, id: NOTE_ID });
    expect(mockInfraNoteDelete).toHaveBeenCalledWith({ where: { id: NOTE_ID } });
  });

  it("returns 404 for a note owned by another user", async () => {
    mockInfraNoteFindFirst.mockResolvedValue(dbNote({ machine: { userId: "someone-else" } }));

    const res = await deleteNote(noteRequest("DELETE"), noteParams());

    expect(res.status).toBe(404);
    expect(mockInfraNoteDelete).not.toHaveBeenCalled();
  });

  it("returns 404 when the note does not exist", async () => {
    mockInfraNoteFindFirst.mockResolvedValue(null);

    const res = await deleteNote(noteRequest("DELETE"), noteParams());

    expect(res.status).toBe(404);
    expect(mockInfraNoteDelete).not.toHaveBeenCalled();
  });
});
