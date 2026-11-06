import { SQL } from "bun";

export const sql = new SQL({ max: 3, idleTimeout: 30 });
