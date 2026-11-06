import { SQL } from "bun";

export const sql = new SQL({ max: 2, idleTimeout: 30 });
