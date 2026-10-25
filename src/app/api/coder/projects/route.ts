import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { CHAT_MODES } from "@/lib/coder/checkout";
import {
  CoderProjectError,
  createProject,
  listProjects,
  serializeCreatedProject,
  serializeProjectList,
} from "@/lib/coder/projects";

/**
 * The user's coder projects.
 *
 * `name` is what the user reads; the slug, the directory and the branch all
 * derive from it in the lib. A clone URL must not carry whitespace, since it
 * reaches a shell inside the container. `chatMode`, `defaultBranch` and
 * `setupScript` are what the setup flow asks before the first chat exists.
 */
const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  cloneUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => !/\s/.test(value), "A clone URL cannot contain whitespace")
    .optional(),
  chatMode: z.enum(CHAT_MODES).optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  setupScript: z.string().nullable().optional(),
});

/** GET /api/coder/projects: the user's projects, most recent first. */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  try {
    const projects = await listProjects(authResult.user.id);
    return NextResponse.json(serializeProjectList(projects));
  } catch (err) {
    console.error("Failed to list coder projects:", err);
    return NextResponse.json({ error: "Failed to list projects" }, { status: 500 });
  }
}

/** POST /api/coder/projects: `git init` or clone, then record the project. */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json().catch((err: unknown) => {
    console.error("Unreadable coder project request body:", err);
    return null;
  });
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { name, cloneUrl?, chatMode?, defaultBranch?, setupScript? }" },
      { status: 400 },
    );
  }

  try {
    const project = await createProject(authResult.user.id, parsed.data);
    return NextResponse.json(serializeCreatedProject(project), { status: 201 });
  } catch (err) {
    if (err instanceof CoderProjectError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("Failed to create a coder project:", err);
    return NextResponse.json({ error: "Failed to create the project" }, { status: 500 });
  }
}
