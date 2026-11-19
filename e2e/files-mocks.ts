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

/** The terminal the files page's console talks to, without a shell behind it. */
export async function mockTerminal(page: Page): Promise<void> {
  await page.route(/\/api\/terminal(\?|\/|$)/, (route) => {
    const request = route.request();
    const url = request.url();

    if (url.includes("/stream")) {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'event: output\ndata: {"type":"output","text":"$ "}\n\n',
      });
    }
    if (url.includes("/input")) return route.fulfill({ json: { written: 1 } });
    if (url.includes("/resize")) return route.fulfill({ json: { cols: 80, rows: 24 } });
    if (request.method() === "GET")
      return route.fulfill({ json: { available: true, reason: null } });
    if (request.method() === "DELETE") return route.fulfill({ json: { closed: true } });
    return route.fulfill({
      json: { shell: { target: "user", status: "open", error: null, cols: 80, rows: 24 } },
    });
  });
}

/** One registered machine, for the files page's Connect menu. */
export const FILES_MACHINE = {
  id: "m-e2e",
  name: "e2e-server",
  host: "10.0.0.5",
  port: 22,
  username: "deploy",
  authMethod: "key",
  noteCount: 0,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

export async function mockFiles(page: Page): Promise<void> {
  // The page asks whether it can offer a console as soon as it loads.
  await mockTerminal(page);
  await page.route(/\/api\/infra\/machines$/, (route) =>
    route.fulfill({ json: { machines: [FILES_MACHINE] } }),
  );
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
