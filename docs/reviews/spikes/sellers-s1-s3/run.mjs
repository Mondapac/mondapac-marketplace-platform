import { PrismaClient } from './gen/client.ts';
import { PrismaPg } from '/home/claude/mondapac-marketplace-platform/apps/api/node_modules/@prisma/adapter-pg/dist/index.mjs';
(async () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.MIGRATION_DATABASE_URL }) });
  const a = '00000000-0000-4000-8000-0000000000a1', b = '00000000-0000-4000-8000-0000000000b1', r = '00000000-0000-4000-8000-0000000000c1';
  await prisma.sellersSellerFile.create({ data: { sellerId: a, marketId: 'AU' } });
  await prisma.sellersSellerFile.create({ data: { sellerId: b, marketId: 'AU' } });
  await prisma.sellersRevision.create({ data: { id: r, marketId: 'AU', sellerId: a } });
  await prisma.sellersSellerFile.update({ where: { marketId_sellerId: { marketId: 'AU', sellerId: a } }, data: { approvedRevisionId: r } });
  console.log('own pointer ok');
  try {
    await prisma.sellersSellerFile.update({ where: { marketId_sellerId: { marketId: 'AU', sellerId: b } }, data: { approvedRevisionId: r } });
    console.log('FOREIGN POINTER ACCEPTED (bad)');
  } catch (e) { console.log('other seller pointer refused:', e.code, e.meta?.constraint ?? ''); }
  const got = await prisma.sellersSellerFile.findMany({ where: { marketId: 'AU', sellerId: { in: [a, b] } }, select: { sellerId: true, approvedRevision: { select: { id: true } } } });
  console.log(JSON.stringify(got));
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
