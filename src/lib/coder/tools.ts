/**
 * Agent tools for coder projects.
 *
 * An agent works in one checkout, and what every checkout inherits (its env
 * files and the script that installs dependencies) is set on the project. Without
 * these, changing it means asking the user to open the panel, so the work stops
 * mid-turn.
 *
 * The list and the dispatch are what make a project reachable from a chat that
 * is not in it: without them the agent has to be told a project id, and handing
 * work to a coding chat is a thing only the user can do.
 *
 * Every tool takes an optional `project`; without it they act on the project of
 * the chat the agent is running in, which is the one it is looking at.
 */

import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import {
  CoderProjectError,
  getProjectSettings,
  listProjects,
  updateProject,
  type ProjectSettings,
} from "./projects";

const envFileSchema = Type.Object({
  path: Type.String({ description: 'Relative to the checkout, e.g. ".env.local".' }),
  content: Type.String({ description: "The file's whole contents." }),
});

const projectSettingsSchema = Type.Object({
  project: Type.Object({
    id: Type.String(),
    name: Type.String(),
    slug: Type.String(),
    repoPath: Type.String(),
    defaultBranch: Type.String(),
  }),
  envFiles: Type.Array(envFileSchema),
  setupScript: Type.Union([Type.String(), Type.Null()]),
});

/** The settings as a tool returns them, with the project's names for context. */
function settingsValue(settings: ProjectSettings) {
  return {
    project: {
      id: settings.id,
      name: settings.name,
      slug: settings.slug,
      repoPath: settings.repoPath,
      defaultBranch: settings.defaultBranch,
    },
    envFiles: settings.envFiles,
    setupScript: settings.setupScript,
  };
}

const projectListSchema = Type.Object({
  count: Type.Integer(),
  // The project of the chat this runs in; null outside a coder chat.
  current: Type.Union([Type.String(), Type.Null()]),
  projects: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      slug: Type.String(),
      repoPath: Type.String(),
      defaultBranch: Type.String(),
      worktreeCount: Type.Integer(),
      chatCount: Type.Integer(),
      lastActivityAt: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});

const projectChatStartedSchema = Type.Object({
  started: Type.Boolean(),
  projectId: Type.String(),
  projectName: Type.String(),
  sessionId: Type.String(),
  title: Type.String(),
  reply: Type.String(),
});

/**
 * The project a call is about.
 *
 * An explicit `project` is matched against the id, the slug and the name, so the
 * model can pass whichever it read. Otherwise the chat's own project is used:
 * a coder chat always has one, and a tool call from another chat has to name one.
 */
async function resolveProject(
  userId: string,
  sessionId: string | undefined,
  requested: string | undefined,
): Promise<string> {
  const wanted = (requested ?? "").trim();
  if (wanted) {
    const project = await prisma.coderProject.findFirst({
      where: { userId, OR: [{ id: wanted }, { slug: wanted }, { name: wanted }] },
      select: { id: true, slug: true, name: true },
    });
    if (!project) {
      throw new Error(
        `No coder project matches "${wanted}". Pass the project's ID, its slug or its exact name, or give no project to use this chat's.`,
      );
    }
    return project.id;
  }

  if (!sessionId) throw new Error("Pass the coder project you mean.");

  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { projectId: true },
  });
  if (!chat?.projectId) {
    throw new Error("This chat is not in a coder project. Pass the project you mean.");
  }
  return chat.projectId;
}

/** The project of the chat the agent is running in, if it has one. */
async function chatProjectId(
  userId: string,
  sessionId: string | undefined,
): Promise<string | null> {
  if (!sessionId) return null;
  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { projectId: true },
  });
  return chat?.projectId ?? null;
}

/** A dispatch needs the project's name to report which one took the work. */
async function resolveProjectNamed(
  userId: string,
  sessionId: string | undefined,
  requested: string | undefined,
): Promise<{ id: string; name: string }> {
  const id = await resolveProject(userId, sessionId, requested);
  const project = await prisma.coderProject.findFirst({
    where: { id, userId },
    select: { id: true, name: true },
  });
  if (!project) throw new Error(`Project ${id} is not available to this user.`);
  return project;
}

/** Read a project's settings, then look up the project the call is about. */
async function loadSettings(
  userId: string,
  sessionId: string | undefined,
  requested: string | undefined,
): Promise<ProjectSettings> {
  const projectId = await resolveProject(userId, sessionId, requested);
  const settings = await getProjectSettings(userId, projectId);
  if (!settings) throw new Error(`Project ${projectId} is not available to this user.`);
  return settings;
}

/**
 * The projects themselves: what exists, and handing work to a coding chat.
 *
 * Separate from the settings tools so the two reach the model independently:
 * a chat that may look at projects need not be able to rewrite what every
 * future checkout inherits.
 */
export function createProjectTools(userId: string, sessionId?: string): ToolDefinition[] {
  return [
    defineStructuredTool({
      name: "project_list",
      label: "List Projects",
      description: [
        "List the user's coder projects: each project's id, name, slug, repo path,",
        "default branch, how many checkouts and chats it has, and when it was last",
        "used. `current` is the project of the chat this runs in.",
        "Read this before dispatching work, so the project is named rather than guessed.",
      ].join(" "),
      parameters: Type.Object({}),
      outputSchema: projectListSchema,
      execute: async () => {
        const [projects, current] = await Promise.all([
          listProjects(userId),
          chatProjectId(userId, sessionId),
        ]);

        return {
          value: {
            count: projects.length,
            current,
            projects: projects.map((project) => ({
              id: project.id,
              name: project.name,
              slug: project.slug,
              repoPath: project.repoPath,
              defaultBranch: project.defaultBranch,
              worktreeCount: project.worktreeCount,
              chatCount: project.chatCount,
              lastActivityAt: project.lastActivityAt?.toISOString() ?? null,
            })),
          },
          details: { count: projects.length },
        };
      },
    }),

    defineStructuredTool({
      name: "project_chat_start",
      label: "Start Coding Chat",
      description: [
        "Start a coding chat in a coder project and wait for its reply. The chat gets",
        "its own checkout, so the first message may spend a while installing dependencies.",
        "Use it to hand a task to a coder chat, or to keep working in a project this",
        "chat is not in. Find the project with project_list first.",
      ].join(" "),
      parameters: Type.Object({
        message: Type.String({ description: "The first message the coding chat works on." }),
        project: Type.Optional(
          Type.String({
            description: "Project id, slug or exact name. Defaults to this chat's project.",
          }),
        ),
        title: Type.Optional(Type.String({ description: "Optional short title for the chat." })),
      }),
      outputSchema: projectChatStartedSchema,
      execute: async (
        _toolCallId,
        params: { message: string; project?: string; title?: string },
        signal: AbortSignal | undefined,
      ) => {
        const project = await resolveProjectNamed(userId, sessionId, params.project);

        const [{ createChatSessionRow }, { respondInChat }] = await Promise.all([
          import("@/lib/chat/create-session"),
          import("@/lib/chat/respond-in-chat"),
        ]);

        const session = await createChatSessionRow(userId, {
          title: params.title,
          projectId: project.id,
        });
        const result = await respondInChat({
          userId,
          sessionId: session.id,
          callerSessionId: sessionId ?? null,
          message: params.message,
          signal,
        });

        return {
          value: {
            started: true,
            projectId: project.id,
            projectName: project.name,
            sessionId: result.sessionId,
            title: result.title,
            reply: result.reply,
          },
          details: { project: project.id, sessionId: result.sessionId },
        };
      },
    }),
  ];
}

export function createProjectSettingsTools(userId: string, sessionId?: string): ToolDefinition[] {
  return [
    defineStructuredTool({
      name: "project_settings_get",
      label: "Read Project Settings",
      description: [
        "Read a coder project's settings: its env files and the script that runs in",
        "each new checkout.",
        "Every chat in the project gets these, so this is what to read before telling",
        "the user an env var is missing. Without a project, it reads the project this",
        "chat is in.",
      ].join(" "),
      parameters: Type.Object({
        project: Type.Optional(
          Type.String({
            description: "Project id, slug or exact name. Defaults to this chat's project.",
          }),
        ),
      }),
      outputSchema: projectSettingsSchema,
      execute: async (_toolCallId, params) => {
        const value = settingsValue(await loadSettings(userId, sessionId, params.project));
        return {
          value,
          details: { project: value.project.id, envFiles: value.envFiles.length },
        };
      },
    }),

    defineStructuredTool({
      name: "project_settings_set",
      label: "Change Project Settings",
      description: [
        "Change a coder project's settings. Only the fields you pass are changed.",
        "`envFiles` replaces the whole list, so read with project_settings_get first",
        "and send every file back. The files are written into new checkouts before",
        "their first command; checkouts that already exist keep their version of a",
        "file they have.",
      ].join(" "),
      parameters: Type.Object({
        project: Type.Optional(
          Type.String({
            description: "Project id, slug or exact name. Defaults to this chat's project.",
          }),
        ),
        envFiles: Type.Optional(
          Type.Array(envFileSchema, {
            description:
              "The project's complete list of env files. Each path is relative to a checkout.",
          }),
        ),
        setupScript: Type.Optional(
          Type.Union([Type.String(), Type.Null()], {
            description:
              'Command run in each new checkout, e.g. "npm install". Null or "" clears it.',
          }),
        ),
        defaultBranch: Type.Optional(
          Type.String({ description: "The branch new chats branch from." }),
        ),
        name: Type.Optional(Type.String({ description: "The project's display name." })),
      }),
      outputSchema: projectSettingsSchema,
      execute: async (_toolCallId, params) => {
        if (
          params.envFiles === undefined &&
          params.setupScript === undefined &&
          params.defaultBranch === undefined &&
          params.name === undefined
        ) {
          throw new Error("Pass at least one of envFiles, setupScript, defaultBranch or name.");
        }

        try {
          const settings = await updateProject(
            userId,
            await resolveProject(userId, sessionId, params.project),
            {
              ...(params.envFiles !== undefined ? { envFiles: params.envFiles } : {}),
              ...(params.setupScript !== undefined ? { setupScript: params.setupScript } : {}),
              ...(params.defaultBranch !== undefined
                ? { defaultBranch: params.defaultBranch }
                : {}),
              ...(params.name !== undefined ? { name: params.name } : {}),
            },
          );

          const value = settingsValue(settings);
          return {
            value,
            details: { project: value.project.id, envFiles: value.envFiles.length },
          };
        } catch (err) {
          // A refused value is the model's to correct, so surface the reason.
          if (err instanceof CoderProjectError) throw new Error(err.message);
          throw err;
        }
      },
    }),
  ];
}
