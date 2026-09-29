/**
 * Redaction: identifiers are removed before ANY AI call, the numbers an agent
 * must read out survive, and no raw identifier reaches the AI adapter.
 */
import { describe, expect, it } from "vitest";
import { redactPHI } from "../redact";
import { buildUserPrompt, createAiReviewer } from "../aiReviewer";
import { runRules } from "../rules";
import { medicareRubric } from "../rubrics";
import { runScoring } from "../engine";
import { tx, utt } from "./fixtures";

describe("redactPHI", () => {
  it("redacts identifiers but keeps 1-800-MEDICARE", () => {
    const out = redactPHI("My MBI is 1EG4-TE5-MK73, SSN 123-45-6789, call me at (555) 123-4567 or 1-800-MEDICARE, born 04/12/1951.");
    expect(out).toContain("[MBI]");
    expect(out).toContain("[SSN]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[DATE]");
    expect(out).toContain("1-800-MEDICARE");
    expect(out).not.toContain("6789");
    expect(out).not.toContain("1EG4");
  });

  it("keeps the numeric form of the Medicare number the agent must read", () => {
    expect(redactPHI("Call 1-800-633-4227 any time")).toContain("1-800-633-4227");
    expect(redactPHI("Call 1 800 MEDICARE any time")).toContain("1 800 MEDICARE");
  });

  it("redacts card numbers, emails, spelled dates and spelled-out digit runs", () => {
    const out = redactPHI(
      "Card 4111 1111 1111 1111, email jane.roe@example.com, born April 12th, 1951, phone five five five one two three four five six seven.",
    );
    expect(out).toContain("[CARD]");
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[DATE]");
    expect(out).toContain("[NUMBER]");
    expect(out).not.toMatch(/4111|jane\.roe|1951/);
  });

  it("leaves ordinary sentences alone", () => {
    const s = "We represent 7 organizations which offer 42 products in your area.";
    expect(redactPHI(s)).toBe(s);
  });
});

describe("nothing identifying reaches the AI adapter", () => {
  const RAW = [
    "My Medicare number is 1EG4-TE5-MK73.",
    "Social is 123-45-6789 and my cell is (555) 123-4567.",
    "You can email me at jane.roe@example.com, I was born 04/12/1951.",
    "Charge card 4111 1111 1111 1111 please.",
  ];
  const transcript = tx([
    utt(0, 1, "agent", "Please call 1-800-MEDICARE for all options."),
    ...RAW.map((t, i) => utt(i + 1, 10 + i * 5, "client", t)),
  ]);

  it("the prompt builder redacts every transcript line", () => {
    const prompt = buildUserPrompt({ rubric: medicareRubric, transcript, findings: runRules(medicareRubric, transcript) });
    for (const secret of ["1EG4-TE5-MK73", "123-45-6789", "555) 123-4567", "jane.roe@example.com", "04/12/1951", "4111 1111"]) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain("1-800-MEDICARE");
    expect(prompt).toContain("[MBI]");
  });

  it("the mock chat client never receives a raw identifier, in any message", async () => {
    const seen: string[] = [];
    const client = {
      chat: {
        completions: {
          create: async (args: { messages: Array<{ role: string; content: string }> }) => {
            for (const m of args.messages) seen.push(m.content);
            return { choices: [{ message: { content: JSON.stringify({ criteria: [] }) } }] };
          },
        },
      },
    };
    await runScoring({ rubric: medicareRubric, transcript, reviewer: createAiReviewer(client, "test-model") });
    expect(seen.length).toBeGreaterThan(0);
    const all = seen.join("\n");
    for (const secret of ["1EG4-TE5-MK73", "123-45-6789", "(555) 123-4567", "jane.roe@example.com", "04/12/1951", "4111 1111 1111 1111"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("the instructions forbid assessing the client's health, race or ethnicity", () => {
    const prompt = buildUserPrompt({ rubric: medicareRubric, transcript, findings: [] });
    expect(prompt).not.toMatch(/extract/i);
    const seenSystem: string[] = [];
    const client = {
      chat: {
        completions: {
          create: async (args: { messages: Array<{ role: string; content: string }> }) => {
            seenSystem.push(args.messages.find((m) => m.role === "system")!.content);
            return { choices: [{ message: { content: "{\"criteria\":[]}" } }] };
          },
        },
      },
    };
    return createAiReviewer(client, "m")
      .review({ rubric: medicareRubric, transcript, findings: [] })
      .then(() => expect(seenSystem[0]).toMatch(/health, race, ethnicity/));
  });
});
