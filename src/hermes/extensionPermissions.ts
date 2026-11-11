// The permissions an extension's manifest can ask for (ADR 0126, section 3). The table is the whole list: a name that
// isn't a key here is refused when the manifest is parsed.
export type PermissionSpec = {
  /** `call`: usable only while a call the owner started is open. `always`: usable at any time. */
  during: "call" | "always";
  /** Withdrawing the permission deletes the extension's storage, because what it read may be stored there. */
  wipesStorage: boolean;
};

export const PERMISSIONS = {
  "chat.read": { during: "call", wipesStorage: true },
  "chat.draft": { during: "call", wipesStorage: false },
  "project.read": { during: "call", wipesStorage: true },
  storage: { during: "always", wipesStorage: false },
} as const satisfies Record<string, PermissionSpec>;

export type Permission = keyof typeof PERMISSIONS;

export const isPermission = (v: string): v is Permission => Object.hasOwn(PERMISSIONS, v);
