// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { SkillAddDialog } from "@/components/skills/skill-add-dialog";

type Props = Parameters<typeof SkillAddDialog>[0];

function renderDialog(overrides: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    onOpenChange: vi.fn(),
    onInstall: vi.fn().mockResolvedValue({
      name: "pdf-tools",
      description: "Extract text from PDFs",
      path: "/w/user-1/.agents/skills/pdf-tools/SKILL.md",
    }),
    ...overrides,
  };
  render(<SkillAddDialog {...props} />);
  return {
    onInstall: props.onInstall as unknown as ReturnType<typeof vi.fn>,
    onOpenChange: props.onOpenChange as unknown as ReturnType<typeof vi.fn>,
    url: () => screen.getByLabelText("Address of a SKILL.md") as HTMLInputElement,
    markdown: () => screen.getByLabelText("Or its contents") as HTMLTextAreaElement,
    install: () => screen.getByRole("button", { name: /^install$/i }),
  };
}

describe("SkillAddDialog", () => {
  it("keeps installing disabled until there is something to install", () => {
    const { install } = renderDialog();

    expect(install()).toBeDisabled();
  });

  it("reads the skill from the address when one is given", async () => {
    const { url, install, onInstall, onOpenChange } = renderDialog();

    fireEvent.change(url(), { target: { value: " https://agents.stackoverflow.com/skill.md " } });
    fireEvent.click(install());

    await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1));
    expect(onInstall.mock.calls[0]![0]).toEqual({
      url: "https://agents.stackoverflow.com/skill.md",
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("sends the pasted file when there is no address", async () => {
    const { markdown, install, onInstall } = renderDialog();

    fireEvent.change(markdown(), { target: { value: "---\nname: pdf-tools\n---\n\nSteps." } });
    fireEvent.click(install());

    await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1));
    expect(onInstall.mock.calls[0]![0]).toEqual({
      markdown: "---\nname: pdf-tools\n---\n\nSteps.",
    });
  });

  it("shows why a skill was refused and stays open", async () => {
    const onInstall = vi.fn().mockRejectedValue(new Error("The frontmatter needs a name."));
    const { markdown, install, onOpenChange } = renderDialog({ onInstall });

    fireEvent.change(markdown(), { target: { value: "no frontmatter here" } });
    fireEvent.click(install());

    await waitFor(() =>
      expect(screen.getByText("The frontmatter needs a name.")).toBeInTheDocument(),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
