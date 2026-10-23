/**
 * Agent tools for a coder project's settings.
 *
 * An agent works in one checkout, and what every checkout inherits (its env
 * files and the script that installs dependencies) is set on the project. Without
 * these, changing it means asking the user to open the panel, so the work stops
 * mid-turn.
 *
 * Both tools take an optional `project`; without it they act on the project of
 * the chat the agent is running in, which is the one it is looking at.
 */

import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import {
  CoderProjectError,
  getProjectSettings,
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

  if (!sessionId) throw new Error("Pass the coder project whose settings you want.");

  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { projectId: true },
  });
  if (!chat?.projectId) {
    throw new Error(
      "This chat is not in a coder project. Pass the project whose settings you want.",
    );
  }
  return chat.projectId;
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
