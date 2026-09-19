/** Local PlanTier mirror so the billing core compiles without the Prisma
 *  client generated (unit tests import plans without a DB). */
export type PlanTier = "FREE_TRIAL" | "STARTER" | "GROWTH" | "INSTITUTION";
