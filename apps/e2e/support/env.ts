import { e2ePort } from "../../backend/scripts/e2e-ports.mjs";

// Dedicated ports: the development stack uses 5380 (frontend) and 4380
// (backend), and `.env` can move them. The suite recreates its database and may
// reuse servers already listening, so a port that the development
// configuration uses is refused (see e2e-ports.mjs), never silently shared.
export const FRONTEND_PORT = e2ePort("E2E_FRONTEND_PORT", 5391);
export const BACKEND_PORT = e2ePort("E2E_BACKEND_PORT", 4391);
if (FRONTEND_PORT === BACKEND_PORT)
  throw new Error("E2E_FRONTEND_PORT and E2E_BACKEND_PORT must differ");
export const BASE_URL = `http://127.0.0.1:${FRONTEND_PORT}`;

/**
 * RUT bodies of the people the specs create (see `freshRut`): 8 digits from
 * 20,000,000 up (the seeded fixtures are 11-12 million), cut in blocks. A run
 * owns one block (`E2E_RUN_SLOT`, chosen once by the global setup from the
 * clock), each worker index a sub-block, so nothing repeats across workers or
 * across runs against a database that was not recreated.
 */
export const RUT_FIRST_BODY = 20_000_000;
export const RUT_WORKER_BLOCK = 1_000;
export const RUT_MAX_WORKER_INDEX = 40;
const RUT_RUN_BLOCK = RUT_WORKER_BLOCK * RUT_MAX_WORKER_INDEX;
export const RUT_RUN_SLOTS = Math.floor(
  (99_999_999 - RUT_FIRST_BODY) / RUT_RUN_BLOCK,
);
export const RUT_RUN_BLOCK_SIZE = RUT_RUN_BLOCK;
