const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  await db.ledgerEntry.deleteMany({});
  await db.agentEvent.deleteMany({});
  await db.endpointCall.deleteMany({});
  await db.machineEndpoint.deleteMany({});
  await db.creditPassport.deleteMany({});
  await db.subscription.deleteMany({});
  await db.invoice.deleteMany({});
  await db.merchant.deleteMany({});
  console.log("ALL DEMO DATA CLEARED — db is empty, real-mode ready");
  await db.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
