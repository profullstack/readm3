export interface CloudUser {
  id: string;
  username: string;
  displayName: string;
  admin: number;
}
export interface CloudDocument {
  id: string;
  ownerId: string;
  ownerUsername?: string;
  ownerDisplayName?: string;
  orgId: string;
  teamId: string | null;
  access: string;
  title: string;
  currentVersion: string;
  canEdit: boolean;
  canManage: boolean;
  updatedAt: string;
  pinned?: boolean;
  version: {
    id: string;
    source: string;
    title: string;
    checksum: string;
    author: string;
    createdAt: string;
  };
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.error || `Request failed (${response.status})`,
      response.status,
    );
  return data as T;
}
export const action = <T = unknown>(
  operation: string,
  args: Record<string, unknown> = {},
) => request<T>("actions", "POST", { operation, args });
export function modal(title: string): {
  dialog: HTMLDialogElement;
  body: HTMLDivElement;
  close: () => void;
} {
  const dialog = document.createElement("dialog");
  dialog.className = "cloud-dialog";
  dialog.setAttribute("aria-label", title);
  const header = document.createElement("div");
  header.className = "dialog-header";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close dialog");
  close.onclick = () => dialog.close();
  header.append(heading, close);
  const body = document.createElement("div");
  dialog.append(header, body);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  return { dialog, body, close: () => dialog.close() };
}
export function showError(target: HTMLElement, error: unknown) {
  target.textContent =
    error instanceof Error
      ? error.message
      : "The request could not be completed.";
  target.setAttribute("role", "alert");
}
export function outputLink(
  target: HTMLElement,
  value: string,
  label = "Copy link",
) {
  const box = document.createElement("div");
  box.className = "copy-value";
  const input = document.createElement("input");
  input.readOnly = true;
  input.value = value;
  input.setAttribute("aria-label", label);
  input.onclick = () => input.select();
  const button = document.createElement("button");
  button.textContent = label;
  button.type = "button";
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied";
    } catch {
      input.select();
      button.textContent = "Select and copy";
    }
  };
  box.append(input, button);
  target.append(box);
}
