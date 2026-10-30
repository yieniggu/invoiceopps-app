import {
  createContext,
  Fragment,
  useContext,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Profile = {
  id: string;
  memberships: Array<{ organization: { id: string; name: string } }>;
};
type Group = {
  id: string;
  name: string;
  organization: { id: string; name: string };
};
export type OwnerContext = {
  organizationId: string;
  organizationName: string;
  ownerType: "user" | "group";
  ownerId: string;
  ownerName: string;
};

export function contextValue(context: OwnerContext) {
  return `${context.organizationId}:${context.ownerType}:${context.ownerId}`;
}

function authorizedContexts(profile: Profile, groups: Group[]): OwnerContext[] {
  const memberships = new Set(
    profile.memberships.map(({ organization }) => organization.id),
  );
  return [
    ...profile.memberships.map(({ organization }) => ({
      organizationId: organization.id,
      organizationName: organization.name,
      ownerType: "user" as const,
      ownerId: profile.id,
      ownerName: "Trabajo individual",
    })),
    ...groups
      .filter((group) => memberships.has(group.organization.id))
      .map((group) => ({
        organizationId: group.organization.id,
        organizationName: group.organization.name,
        ownerType: "group" as const,
        ownerId: group.id,
        ownerName: group.name,
      })),
  ];
}

function useSelection(profile: Profile, groups: Group[] | undefined) {
  const selector = useRef<HTMLSelectElement | null>(null);
  const restoreFocus = useRef(false);
  const ownerSelectorRef = useCallback((node: HTMLSelectElement | null) => {
    selector.current = node;
    if (node && restoreFocus.current) {
      node.focus();
      restoreFocus.current = false;
    }
  }, []);
  const contexts = authorizedContexts(profile, groups ?? []);
  const isConfirmed = groups !== undefined;
  const [selection, setSelection] = useState(() =>
    contexts[0] ? contextValue(contexts[0]) : "",
  );
  useLayoutEffect(() => {
    // A standalone selector may stay mounted; do not retain a future focus request.
    restoreFocus.current = false;
  }, [selection]);
  // A revoked selection never falls back to a different owner implicitly.
  const selectedContext = isConfirmed
    ? contexts.find((context) => contextValue(context) === selection)
    : undefined;
  // Pending/failed revalidation suspends access, not the intended selection.
  if (isConfirmed && selection && !selectedContext) setSelection("");
  return {
    contexts: isConfirmed ? contexts : [],
    selectedValue: selectedContext ? selection : "",
    selectedContext,
    setSelectedValue: (value: string) => {
      if (value === selection) return;
      restoreFocus.current = document.activeElement === selector.current;
      setSelection(value);
    },
    ownerSelectorRef,
  };
}

const Workspace = createContext<ReturnType<typeof useSelection> | null>(null);

export function WorkspaceProvider({
  profile,
  groups,
  children,
}: {
  profile: Profile;
  groups: Group[] | undefined;
  children: ReactNode;
}) {
  const workspace = useSelection(profile, groups);
  return <Workspace.Provider value={workspace}>{children}</Workspace.Provider>;
}

export function useSharedWorkspace() {
  const workspace = useContext(Workspace);
  if (!workspace) throw new Error("WorkspaceProvider is required");
  return workspace;
}

export function WorkspaceBoundary({ children }: { children: ReactNode }) {
  const workspace = useContext(Workspace);
  return <Fragment key={workspace?.selectedValue ?? ""}>{children}</Fragment>;
}
