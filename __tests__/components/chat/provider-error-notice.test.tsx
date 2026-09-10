// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { ProviderErrorNotice } from "@/components/chat/provider-error-notice";

describe("ProviderErrorNotice", () => {
  it("shows the provider's message with its HTTP status", () => {
    render(
      <ProviderErrorNotice error={'400: {"message":"Invalid max_tokens value","type":"x"}'} />,
    );

    expect(screen.getByText("Provider error")).toBeInTheDocument();
    expect(screen.getByText("Invalid max_tokens value")).toBeInTheDocument();
    expect(screen.getByText("400")).toBeInTheDocument();
  });

  it("keeps the raw error visible when the message was extracted from it", () => {
    const raw = '401: {"error":{"message":"Invalid API key"}}';
    render(<ProviderErrorNotice error={raw} />);

    expect(screen.getByText("Invalid API key")).toBeInTheDocument();
    // Nothing is hidden: the original text stays readable.
    expect(screen.getByText(raw)).toBeInTheDocument();
  });

  it("renders a plain network failure verbatim", () => {
    render(<ProviderErrorNotice error="fetch failed" />);

    expect(screen.getByText("fetch failed")).toBeInTheDocument();
    expect(screen.queryByText("Provider error")).toBeInTheDocument();
  });

  it("does not duplicate the text when it cannot be shortened", () => {
    const raw = '500: {"code":"internal"}';
    const { container } = render(<ProviderErrorNotice error={raw} />);

    // The body is the message and no separate raw line is rendered.
    expect(screen.getByText(raw.replace("500: ", ""))).toBeInTheDocument();
    expect(container.textContent?.match(/internal/g)).toHaveLength(1);
  });
});
