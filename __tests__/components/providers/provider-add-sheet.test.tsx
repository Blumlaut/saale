// @vitest-environment jsdom
import { describe, it, expect, vi, type Mock } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import {
  EMPTY_ENDPOINT_DEFAULTS,
  ProviderAddSheet,
  type ProviderAddSheetProps,
} from "@/components/providers/provider-add-sheet";
import type { ProviderCatalogView } from "@/lib/providers/catalog";

/**
 * The picker is the only way to reach a provider that is not linked, so it has
 * to list them all, filter honestly, and offer every method each one defines.
 */

function provider(
  id: string,
  name: string,
  overrides: Partial<ProviderCatalogView> = {},
): ProviderCatalogView {
  return {
    id,
    name,
    baseUrl: `https://api.${id}.test/v1`,
    methods: [{ type: "api_key", label: `${name} API key`, subscription: false }],
    modelCount: 3,
    modelsConfigurable: false,
    custom: false,
    configured: false,
    source: null,
    isGlobal: false,
    ...overrides,
  };
}

const CATALOG: ProviderCatalogView[] = [
  provider("anthropic", "Anthropic", {
    modelCount: 17,
    configured: true,
    source: "stored",
    methods: [
      { type: "api_key", label: "Anthropic API key", subscription: false },
      { type: "oauth", label: "Claude Pro/Max", subscription: true },
    ],
  }),
  provider("cerebras", "Cerebras", { baseUrl: "https://api.cerebras.ai/v1" }),
  provider("ant-ling", "Ant Ling", { modelCount: 1 }),
  provider("opencode", "OpenCode Zen", {
    methods: [{ type: "oauth", label: "Sign in with OpenCode", subscription: true }],
  }),
  provider("two-ways", "Two Ways", {
    methods: [
      { type: "api_key", label: "Two Ways API key", subscription: false },
      { type: "oauth", label: "Two Ways subscription", subscription: true },
    ],
  }),
  provider("custom", "OpenAI-compatible", { custom: true, modelsConfigurable: true }),
];

function renderSheet(overrides: Partial<ProviderAddSheetProps> = {}) {
  const props: ProviderAddSheetProps = {
    open: true,
    onOpenChange: vi.fn(),
    providers: CATALOG,
    loading: false,
    mode: "browse",
    endpoint: EMPTY_ENDPOINT_DEFAULTS,
    saving: false,
    onConnect: vi.fn(),
    onSaveEndpoint: vi.fn(),
    onSaveLimits: vi.fn(),
    scope: "user",
    onDisconnect: vi.fn(),
    ...overrides,
  };
  render(<ProviderAddSheet {...props} />);
  return props;
}

function search(value: string) {
  fireEvent.change(screen.getByLabelText("Search providers"), { target: { value } });
}

describe("ProviderAddSheet", () => {
  it("lists linked providers above the rest", () => {
    renderSheet();

    const linked = screen.getByText("Anthropic");
    const available = screen.getByText("Cerebras");
    expect(
      linked.compareDocumentPosition(available) & Node.DOCUMENT_POSITION_FOLLOWING,
      "a linked provider must come before an unlinked one",
    ).toBeTruthy();
    expect(screen.getByText("Linked. 1")).toBeInTheDocument();
  });

  it("leaves linked providers without a connect action, and says they are linked", () => {
    renderSheet();

    const badge = screen.getByText("linked");
    const row = badge.parentElement!.parentElement!;
    expect(within(row).queryByRole("button", { name: /API key|Sign in|Connect/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "Actions for Anthropic" })).toBeInTheDocument();
  });

  it("unlinks a linked provider from its row menu", () => {
    const props = renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Anthropic" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Unlink/ }));
    expect(props.onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ id: "anthropic" }));
  });

  it("withholds the row menu from a provider inherited from the global scope", () => {
    renderSheet({
      providers: [provider("anthropic", "Anthropic", { configured: true, isGlobal: true })],
    });

    expect(screen.getByText("linked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("offers endpoint settings from a linked custom provider's row menu", () => {
    renderSheet({
      providers: [
        provider("custom", "OpenAI-compatible", {
          custom: true,
          modelsConfigurable: true,
          configured: true,
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Actions for OpenAI-compatible" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Endpoint settings/ }));
    expect(screen.getByPlaceholderText("http://localhost:11434/v1")).toBeInTheDocument();
  });

  it("filters on the provider name and on its id", () => {
    renderSheet();
    search("cereb");
    expect(screen.getByText("Cerebras")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode Zen")).toBeNull();
    expect(screen.queryByText("Ant Ling")).toBeNull();

    search("ant-ling");
    expect(screen.getByText("Ant Ling")).toBeInTheDocument();
    expect(screen.queryByText("Cerebras")).toBeNull();
  });

  it("matches regardless of case and surrounding spaces", () => {
    renderSheet();
    search("  OPENCODE  ");
    expect(screen.getByText("OpenCode Zen")).toBeInTheDocument();
    expect(screen.queryByText("Cerebras")).toBeNull();
  });

  it("says so when nothing matches", () => {
    renderSheet();
    search("zzz");
    expect(screen.getByText("No provider matches.")).toBeInTheDocument();
  });

  it("offers one button per auth method and reports the one that was picked", () => {
    const onConnect = renderSheet().onConnect as unknown as Mock;
    search("two ways");

    fireEvent.click(screen.getByRole("button", { name: /API key/ }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "two-ways" }), "api_key");

    onConnect.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "two-ways" }), "oauth");
  });

  it("reads a lone method as Connect or Sign in", () => {
    const onConnect = renderSheet().onConnect as unknown as Mock;

    search("ant-ling");
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "ant-ling" }), "api_key");

    search("opencode");
    fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "opencode" }), "oauth");
  });

  it("swaps to the endpoint form for the OpenAI-compatible entry", () => {
    renderSheet();
    search("openai");
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));

    expect(screen.getByPlaceholderText("http://localhost:11434/v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("prefills the endpoint form from an existing endpoint", () => {
    renderSheet({
      mode: "endpoint",
      endpoint: {
        exists: true,
        apiKey: "",
        label: "llama.cpp",
        baseUrl: "http://localhost:8080/v1",
        contextWindow: "32768",
        maxOutputTokens: "4096",
      },
    });

    expect(screen.getByDisplayValue("http://localhost:8080/v1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("32768")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Limits only" })).toBeInTheDocument();
  });
});
