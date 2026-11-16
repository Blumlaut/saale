// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SkillsPanel } from "@/components/skills/skills-panel";

const mockUseSkills = vi.fn();

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => mockUseSkills(),
}));

const SKILLS = [
  {
    name: "sofa",
    description: "Ask and answer on SOFA.",
    path: "/w/u/.agents/skills/sofa/SKILL.md",
  },
  {
    name: "release-notes",
    description: "Write a changelog entry.",
    path: "/w/u/.agents/skills/release-notes/SKILL.md",
  },
];

function renderPanel(overrides: Partial<ReturnType<typeof mockUseSkills>> = {}) {
  const removeSkill = vi.fn().mockResolvedValue(undefined);
  mockUseSkills.mockReturnValue({
    skills: SKILLS,
    loading: false,
    error: null,
    loadSkills: vi.fn(),
    installSkill: vi.fn(),
    removeSkill,
    ...overrides,
  });
  render(<SkillsPanel />);
  return { removeSkill };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SkillsPanel", () => {
  it("lists each skill with where it came from", () => {
    renderPanel();

    expect(screen.getByText("sofa")).toBeInTheDocument();
    expect(screen.getByText("Ask and answer on SOFA.")).toBeInTheDocument();
    expect(screen.getByText("release-notes")).toBeInTheDocument();
  });

  it("says what to do when nothing is installed", () => {
    renderPanel({ skills: [] });

    expect(screen.getByText(/no skills yet/i)).toBeInTheDocument();
  });

  it("asks before removing one, then removes it", async () => {
    const { removeSkill } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Actions for sofa" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /remove/i }));
    expect(await screen.findByText("Remove sofa?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    await waitFor(() => expect(removeSkill).toHaveBeenCalledWith("sofa"));
  });
});
