export type PlatformAdministratorCommand = {
  operation: "bootstrap" | "transfer";
  userId: string;
};

export function parsePlatformAdministratorCommand(
  arguments_: unknown,
): PlatformAdministratorCommand {
  if (!Array.isArray(arguments_)) {
    throw new Error(
      "Usage: bootstrap-platform-administrator <bootstrap|transfer> <userId> --confirm-<operation>",
    );
  }

  const [operation, userId, confirmation, ...extra] = arguments_;
  if (
    (operation !== "bootstrap" && operation !== "transfer") ||
    !userId ||
    confirmation !== `--confirm-${operation}` ||
    extra.length > 0
  ) {
    throw new Error(
      "Usage: bootstrap-platform-administrator <bootstrap|transfer> <userId> --confirm-<operation>",
    );
  }

  return { operation, userId };
}
