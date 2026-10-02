import { describe, it, expect } from "vitest";
import { DriveStatementSource } from "../../lib/statementIngest/driveSource";

type Req = { url: string; params?: Record<string, string> };

/** A scripted Drive: folder id -> pages of children. */
function fakeClient(tree: Record<string, Array<Array<Record<string, unknown>>>>, requests: Req[] = []) {
  const cursor = new Map<string, number>();
  return {
    request: async (opts: Req & { responseType?: string }) => {
      requests.push(opts);
      if (opts.params?.alt === "media") return { data: new TextEncoder().encode("hello").buffer };
      const q = opts.params!.q;
      const folder = /'([^']+)' in parents/.exec(q)![1];
      const pages = tree[folder] ?? [[]];
      const i = opts.params!.pageToken ? Number(opts.params!.pageToken) : 0;
      cursor.set(folder, i);
      return { data: { files: pages[i], nextPageToken: i + 1 < pages.length ? String(i + 1) : undefined } };
    },
  };
}

const csv = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, mimeType: "text/csv", md5Checksum: `md5-${id}`, modifiedTime: "2026-10-02T12:00:00Z", size: "10", ...extra,
});
const folder = (id: string, name: string) => ({ id, name, mimeType: "application/vnd.google-apps.folder" });

describe("DriveStatementSource", () => {
  it("walks subfolders, records the parent folder name, and follows pagination", async () => {
    const src = new DriveStatementSource("root", async () =>
      fakeClient({
        root: [[folder("f-hum", "Humana"), csv("r1", "root.csv")], [csv("r2", "root2.csv")]],
        "f-hum": [[csv("h1", "Humana_2026-09.csv")]],
      }) as never,
    );
    const files = await src.list();
    expect(files.map((f) => [f.name, f.folderName]).sort()).toEqual([
      ["Humana_2026-09.csv", "Humana"],
      ["root.csv", null],
      ["root2.csv", null],
    ]);
    expect(files.find((f) => f.externalId === "h1")).toMatchObject({ checksum: "md5-h1", sizeBytes: 10, downloadable: true });
  });

  it("stops descending after two levels", async () => {
    const src = new DriveStatementSource("root", async () =>
      fakeClient({
        root: [[folder("a", "A")]],
        a: [[folder("b", "B")]],
        b: [[csv("deep", "deep.csv")]],
      }) as never,
    );
    expect(await src.list()).toHaveLength(0);
  });

  it("marks native Google files not downloadable with a checksum that survives edits", async () => {
    const sheet = (modifiedTime: string) => ({
      id: "s1", name: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime,
    });
    const first = await new DriveStatementSource("root", async () => fakeClient({ root: [[sheet("2026-10-01T00:00:00Z")]] }) as never).list();
    const edited = await new DriveStatementSource("root", async () => fakeClient({ root: [[sheet("2026-10-02T09:30:00Z")]] }) as never).list();
    expect(first[0].downloadable).toBe(false);
    // An edit must not mint a new (file, checksum) key, or the ledger grows with every save.
    expect(edited[0].checksum).toBe(first[0].checksum);
  });

  it("escapes the folder id in the query and downloads bytes", async () => {
    const requests: Req[] = [];
    const src = new DriveStatementSource("a'b", async () => fakeClient({}, requests) as never);
    await src.list();
    expect(requests[0].params!.q).toContain("a\\'b");

    const buf = await src.download({
      externalId: "x y", name: "n", folderName: null, checksum: "c", modifiedTime: null, sizeBytes: null, downloadable: true,
    });
    expect(buf.toString()).toBe("hello");
    expect(requests.at(-1)!.url).toContain("x%20y");
    expect(requests.at(-1)!.params).toMatchObject({ alt: "media" });
  });
});
