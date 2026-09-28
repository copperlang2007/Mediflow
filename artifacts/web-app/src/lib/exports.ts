import { customFetch } from "@workspace/api-client-react";

/**
 * Download a server CSV export (the `/api/reports/*\/export` routes).
 *
 * Sends the `X-Confirm-Export` header the server's step-up gate requires and
 * returns a plain-language error message instead of throwing, so the caller
 * can show it in a toast.
 */
export async function downloadExport(url: string, filename: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const blob = await customFetch<Blob>(url, {
      headers: { "X-Confirm-Export": "true" },
      responseType: "blob",
    });
    saveBlob(blob, filename);
    return { ok: true };
  } catch (err) {
    const e = err as { status?: number; data?: { code?: string; error?: string } };
    if (e.data?.code === "STEP_UP_REQUIRED") {
      return { ok: false, message: "For security, please sign in again before exporting, then try once more." };
    }
    if (e.status === 403) {
      return { ok: false, message: "Your role isn't allowed to export this data." };
    }
    return { ok: false, message: e.data?.error ?? "The export didn't finish. Please try again." };
  }
}

/** Build a CSV file in the browser (used for blank import templates). */
export function downloadCsvText(rows: string[][], filename: string): void {
  const csv = rows
    .map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","))
    .join("\n");
  saveBlob(new Blob([csv], { type: "text/csv" }), filename);
}

function saveBlob(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  const href = URL.createObjectURL(blob);
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
