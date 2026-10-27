// Only `transfer` remains here: the first administrator is created with
// `pnpm recovery:bootstrap` (src/recovery-bootstrap.ts).
const USAGE =
  "Usage: bootstrap-platform-administrator transfer <userId> --confirm-transfer";

export type PlatformAdministratorCommand = {
  operation: "transfer";
  userId: string;
};

export function parsePlatformAdministratorCommand(
  arguments_: unknown,
): PlatformAdministratorCommand {
  if (!Array.isArray(arguments_)) {
    throw new Error(USAGE);
  }

  const [operation, userId, confirmation, ...extra] = arguments_;
  if (
    operation !== "transfer" ||
    !userId ||
    confirmation !== "--confirm-transfer" ||
    extra.length > 0
  ) {
    throw new Error(USAGE);
  }

  return { operation, userId };
}
