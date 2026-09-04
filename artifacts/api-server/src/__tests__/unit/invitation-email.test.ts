/**
 * The invitation email is the one message this product sends to someone who is
 * not yet a customer and has no way to judge whether it is honest. The agency
 * name and the inviter's name are free text the customer controls, so both are
 * an injection vector into that message specifically.
 */
import { describe, it, expect } from "vitest";
import { invitationEmailHtml } from "../../lib/email";

describe("invitationEmailHtml", () => {
  it("escapes a hostile agency name instead of rendering it as markup", () => {
    const html = invitationEmailHtml({
      agencyName: `</p><a href="https://evil.example">Click here to verify</a><p>`,
      inviterName: "Ada Admin",
      roleLabel: "Agent",
      acceptUrl: "https://app.example/accept-invite?token=abc",
      expiresInDays: 7,
    });

    // The hostile URL may still appear as inert escaped text — that is fine
    // and unavoidable. What must not exist is a live anchor pointing at it,
    // or a closed-out paragraph letting the injected markup reach the reader
    // as markup.
    expect(html).not.toContain('<a href="https://evil.example"');
    expect(html).toContain("&lt;a href=&quot;https://evil.example&quot;");

    // Exactly one anchor in the message, and it is ours.
    const anchors = html.match(/<a\s/g) ?? [];
    expect(anchors).toHaveLength(1);
    expect(html).toContain('href="https://app.example/accept-invite?token=abc"');
  });

  it("escapes a hostile inviter name", () => {
    const html = invitationEmailHtml({
      agencyName: "Alpha Agency",
      inviterName: "<script>alert(1)</script>",
      roleLabel: "Agent",
      acceptUrl: "https://app.example/accept-invite?token=abc",
      expiresInDays: 7,
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not let the accept URL break out of its attribute", () => {
    const html = invitationEmailHtml({
      agencyName: "Alpha Agency",
      inviterName: "Ada Admin",
      roleLabel: "Agent",
      acceptUrl: `https://app.example/x" onmouseover="steal()`,
      expiresInDays: 7,
    });

    expect(html).not.toContain('onmouseover="steal()"');
    expect(html).toContain("&quot; onmouseover=&quot;");
  });

  it("still renders the legitimate content", () => {
    const html = invitationEmailHtml({
      agencyName: "Alpha Agency",
      inviterName: "Ada Admin",
      roleLabel: "Compliance Manager",
      acceptUrl: "https://app.example/accept-invite?token=abc",
      expiresInDays: 7,
    });

    expect(html).toContain("Alpha Agency");
    expect(html).toContain("Ada Admin");
    expect(html).toContain("Compliance Manager");
    expect(html).toContain('href="https://app.example/accept-invite?token=abc"');
    expect(html).toContain("expires in 7 days");
  });
});
