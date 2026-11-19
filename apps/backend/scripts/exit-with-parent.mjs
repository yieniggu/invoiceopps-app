// Preload (`node --import ./scripts/exit-with-parent.mjs ...`) for children of
// scripts/e2e-backend.mjs, spawned with an IPC channel. When the launcher dies
// for any reason, including SIGKILL (which no handler can catch), the OS closes
// the channel and this process exits instead of living on holding the port and
// its database connections (CR-427). Without an IPC channel it does nothing.
// It does not cover grandchildren (the prisma CLI is a separate detached group:
// it is short and killed by the launcher on normal exits).

import { exitWithParent } from "./exit-with-parent-lib.mjs";

exitWithParent();
