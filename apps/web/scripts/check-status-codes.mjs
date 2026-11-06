// Checks the HTTP status of the product and store routes against a running buyer site, with a
// normal browser user agent and with Googlebot's (SEO package 5, gap G9): a missing or removed
// product and an unknown store must answer 404 itself, not a 200 page that says "not found".
//   node apps/web/scripts/check-status-codes.mjs http://127.0.0.1:3003
// The paths below are the sample data's (the site with no API configured). Pass more as
// `status:/path` arguments, e.g. `301:/p/lamb-<uuid>`; redirects are not followed.
// A 404 must also carry its body in the server's HTML (what a browser with JavaScript off, a
// link preview and a failed script bundle see), so each 404 case names the words it must show.
const base = process.argv[2];
if (base === undefined) {
  console.error('usage: node check-status-codes.mjs <base url> [status:/path ...]');
  process.exit(2);
}
const AGENTS = {
  browser:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};
const CASES = [
  [404, '/p/no-such-product', 'We cannot find that page'], // unknown product
  [404, '/p/no-such-product-3f2b8c1e-9a4d-4e6b-8f10-2d7c5a9b0e11', 'We cannot find that page'], // an id nobody has
  // removed product: its own page stays in the 404 (heading, seller link, similar products)
  [404, '/p/lamb-leg-roast', 'no longer available', 'Similar products', 'Visit Kedron'],
  [404, '/s/no-such-store', 'We cannot find that page'], // unknown store
  // the internal route is never reachable with a 200, whatever the spelling
  [404, '/missing/p/lamb-shoulder', 'We cannot find that page'],
  [404, '/missing/p/lamb-leg-roast', 'We cannot find that page'],
  [404, '/missing/s/kedron', 'We cannot find that page'],
  [404, '/%6dissing/p/lamb-shoulder'],
  [200, '/p/lamb-shoulder'], // a product
  [200, '/s/kedron'], // a store
  [200, '/s/west-end-grocer'], // a store not taking orders keeps its page
  ...process.argv
    .slice(3)
    .map((arg) => [Number(arg.split(':')[0]), arg.slice(arg.indexOf(':') + 1)]),
];
let failed = 0;
/** The page's text as the server sent it: no scripts, no tags (the flight data is a script). */
const textOf = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ');
for (const [agent, ua] of Object.entries(AGENTS)) {
  for (const [want, path, ...words] of CASES) {
    const res = await fetch(new URL(path, base), {
      headers: { 'user-agent': ua },
      redirect: 'manual',
    });
    const text = textOf(await res.text());
    const missing = words.filter((word) => !text.includes(word));
    const ok = res.status === want && missing.length === 0;
    if (!ok) failed += 1;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${agent.padEnd(9)} ${String(res.status)} (want ${String(want)}) ${path}` +
        (missing.length === 0 ? '' : `  body lacks: ${missing.join(' | ')}`),
    );
  }
}
process.exit(failed === 0 ? 0 : 1);
