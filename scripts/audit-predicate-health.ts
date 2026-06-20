import "dotenv/config";

import { auditRelationshipPredicateHealth } from "../src/lib/claims/predicate-shape-audit";
import { z } from "zod";
import { useDatabase } from "../src/utils/db";

const argsSchema = z.object({
  userId: z.string().min(1),
  exampleLimit: z.coerce.number().int().positive().max(200).default(20),
});

async function main(): Promise<void> {
  const [userId, exampleLimit] = process.argv.slice(2).filter((arg) => arg !== "--");
  const args = argsSchema.parse({
    userId,
    exampleLimit,
  });

  const db = await useDatabase();
  const report = await auditRelationshipPredicateHealth(db, args.userId, {
    exampleLimit: args.exampleLimit,
  });

  console.log(JSON.stringify(report, null, 2));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
