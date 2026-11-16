import { SQL } from "bun";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
export const db = new SQL({url:process.env.DATABASE_URL, max:10, idleTimeout:30, connectionTimeout:10});
export const audit = async (action:string,targetId:string|null,data:object={}) => {
  await db`INSERT INTO audit_events(action,target_id,data) VALUES(${action},${targetId},${JSON.stringify(data)}::jsonb)`;
};
export const hashSecret = (s:string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
