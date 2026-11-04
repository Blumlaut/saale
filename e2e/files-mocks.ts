import type { Page } from "@playwright/test";

/**
 * The user's files page answered from a fixed workspace.
 *
 * The file API is stubbed because what these specs check is the page: two
 * panels, a row menu, and the sheets a folder action opens.
 */

export const FILES_ROOT = "/workspaces/user-e2e";

/** The file the specs open, and the row the sheets act on. */
export const FILES_NOTES = "notes.md";

export const FILES_LISTING = {
  target: {
    id: "user",
    label: "files",
    root: FILES_ROOT,
    capabilities: {
      upload: true,
      createFile: true,
      createDirectory: true,
      rename: true,
      remove: true,
    },
  },
  path: FILES_ROOT,
  truncated: false,
  entries: [
    {
      name: "src",
      path: `${FILES_ROOT}/src`,
      kind: "directory",
      size: 4096,
      modified: 1_791_904_714_445,
      writable: true,
    },
    {
      name: FILES_NOTES,
      path: `${FILES_ROOT}/${FILES_NOTES}`,
      kind: "file",
      size: 128,
      modified: 1_791_904_714_445,
      writable: true,
    },
    {
      name: ".gitconfig",
      path: `${FILES_ROOT}/.gitconfig`,
      kind: "file",
      size: 64,
      modified: 1_791_904_714_445,
      writable: true,
    },
    {
      name: "misnamed.md",
      path: `${FILES_ROOT}/misnamed.md`,
      kind: "file",
      size: 64,
      modified: 1_791_904_714_445,
      writable: true,
    },
  ],
};

export async function mockFiles(page: Page): Promise<void> {
  await page.route(/\/api\/files\/list/, (route) => route.fulfill({ json: FILES_LISTING }));
  await page.route(/\/api\/files\/raw/, (route) =>
    route.request().url().includes("misnamed.md")
      ? // A `.md` whose bytes are not text: the name alone does not decide.
        route.fulfill({ body: "\u0000\u0001\u0002 binary\n", contentType: "text/markdown" })
      : route.fulfill({ body: "# e2e notes\n", contentType: "text/markdown; charset=utf-8" }),
  );
  await page.route(/\/api\/files\/write/, (route) => route.fulfill({ json: { modified: 1 } }));
  await page.route(/\/api\/files\/zip/, (route) =>
    route.fulfill({ status: 200, contentType: "application/zip", body: "" }),
  );
  await page.route(/\/api\/files\/delete/, (route) => route.fulfill({ json: { deleted: 1 } }));
}
