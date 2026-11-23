#!/usr/bin/env python3
"""Future-enhancements register tool.

One small JSON file per item in items/<ID>.json, so two pull requests never touch
the same file. Aggregated views are generated, never committed.

  python3 generate.py new --slug my-topic --area admin --title ... --desc ... --src ... --trig ... [--prio ...] [--status ...]
  python3 generate.py            # build the aggregated views into _generated/ (gitignored)
  python3 generate.py --out DIR  # build them into another folder (e.g. the project register)
  python3 generate.py --check    # validate every item file (run by pnpm verify:static)
"""
import argparse, collections, datetime, html, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ITEMS = os.path.join(HERE, "items")
FIELDS = ("area", "title", "desc", "src", "date", "trig", "prio", "status")
STATUSES = {"موکول", "انجام\u200cشد", "منسوخ", "نیاز به بررسی"}
PRIOS = {"بالا", "متوسط", "پایین"}
ID_RE = re.compile(r"^(FE-\d{3}|FE-\d{8}-[a-z0-9]+(-[a-z0-9]+)*)$")


def load():
    areas = json.load(open(os.path.join(HERE, "areas.json"), encoding="utf-8"))
    rows, errors = [], []
    for name in sorted(os.listdir(ITEMS)):
        if not name.endswith(".json"):
            continue
        try:
            r = json.load(open(os.path.join(ITEMS, name), encoding="utf-8"))
        except ValueError as e:
            errors.append(f"{name}: invalid JSON ({e})"); continue
        rid = r.get("id", "")
        if name != rid + ".json": errors.append(f"{name}: file name must be <id>.json")
        if not ID_RE.match(rid): errors.append(f"{name}: id must be FE-NNN (legacy) or FE-YYYYMMDD-slug")
        missing = [k for k in FIELDS if not str(r.get(k, "")).strip()]
        if missing: errors.append(f"{name}: missing {', '.join(missing)}")
        extra = set(r) - set(FIELDS) - {"id"}
        if extra: errors.append(f"{name}: unknown keys {', '.join(sorted(extra))}")
        if r.get("area") not in areas: errors.append(f"{name}: unknown area {r.get('area')!r}")
        if r.get("status") not in STATUSES: errors.append(f"{name}: status must be one of {sorted(STATUSES)}")
        if r.get("prio") not in PRIOS: errors.append(f"{name}: prio must be one of {sorted(PRIOS)}")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(r.get("date", ""))): errors.append(f"{name}: date must be YYYY-MM-DD")
        rows.append(r)
    # legacy sequential ids first (by number), then dated ids (by date, then slug)
    rows.sort(key=lambda r: (0, r["id"]) if re.match(r"^FE-\d{3}$", r["id"]) else (1, r["id"]))
    return areas, rows, errors


def cmd_new(a):
    areas = json.load(open(os.path.join(HERE, "areas.json"), encoding="utf-8"))
    if a.area not in areas: sys.exit(f"unknown area {a.area}; one of {', '.join(areas)}")
    date = a.date or datetime.date.today().isoformat()
    rid = f"FE-{date.replace('-', '')}-{a.slug}"
    path = os.path.join(ITEMS, rid + ".json")
    if os.path.exists(path): sys.exit(f"{rid} already exists; pick another slug")
    r = {"id": rid, "area": a.area, "title": a.title, "desc": a.desc, "src": a.src, "date": date,
         "trig": a.trig, "prio": a.prio, "status": a.status}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(r, f, ensure_ascii=False, indent=2); f.write("\n")
    if not ID_RE.match(rid): os.remove(path); sys.exit("slug must be lowercase kebab-case ASCII")
    print("created", path)


H = "| شناسه | عنوان | توضیح | منبع | شرط یا زمان اجرا | اولویت | وضعیت | ثبت |\n|---|---|---|---|---|---|---|---|\n"
def tbl(rs):
    return H + "".join(f"| {r['id']} | {r['title']} | {r['desc']} | `{r['src']}` | {r['trig']} | {r['prio']} | {r['status']} | {r['date']} |\n" for r in rs)


def build(out):
    areas, rows, errors = load()
    if errors: sys.exit("\n".join(errors))
    os.makedirs(out, exist_ok=True)
    by = collections.defaultdict(list)
    for r in rows: by[r["area"]].append(r)
    RULE = "قاعدهٔ افزودن: برای هر مورد جدید یک فایل جدا در `docs/future-enhancements/items/` بساز (`python3 docs/future-enhancements/generate.py new --slug ... --area ...`)؛ فایل‌های دیگر و این نماها را دست نزن. هیچ فایل مشترکی ویرایش نمی‌شود، پس بین PRها تداخل پیش نمی‌آید."
    o = ["# فهرست متمرکز توسعه‌های آینده\n",
         "هر قابلیت یا ارتقایی که به آینده موکول می‌شود اینجا و هم‌زمان در مستندات بخش مربوط ثبت می‌شود. این فایل از `items/` تولید می‌شود و در git نیست.\n",
         RULE + "\n", "## خلاصه\n", "| بخش | تعداد | فایل بخش |\n|---|---|---|\n"]
    for k, n in areas.items(): o.append(f"| {n} | {len(by[k])} | `{k}.md` |\n")
    o.append(f"| جمع | {len(rows)} | |\n")
    for k, n in areas.items():
        o.append(f"\n## {n}\n\n" + (tbl(by[k]) if by[k] else "موردی ثبت نشده است.\n"))
        with open(os.path.join(out, k + ".md"), "w", encoding="utf-8") as f:
            f.write(f"# توسعه‌های آینده: {n}\n\nنمای همین بخش از فهرست متمرکز؛ از `items/` تولید می‌شود.\n\n" + (tbl(by[k]) if by[k] else "موردی ثبت نشده است.\n"))
    open(os.path.join(out, "README.md"), "w", encoding="utf-8").write("".join(o))
    esc = html.escape
    sec = ""
    for k, n in areas.items():
        cards = "".join(f"<tr><td>{r['id']}</td><td><b>{esc(r['title'])}</b><br><span class=d>{esc(r['desc'])}</span></td><td><span class=src>{esc(r['src'])}</span></td><td>{esc(r['trig'])}</td><td>{r['prio']}</td><td>{r['status']}</td></tr>" for r in by[k])
        sec += f"<section data-area='{k}'><h2>{n} <small>({len(by[k])})</small></h2><div class=w><table><tr><th>شناسه</th><th>مورد</th><th>منبع</th><th>شرط یا زمان</th><th>اولویت</th><th>وضعیت</th></tr>{cards or '<tr><td colspan=6>موردی ثبت نشده</td></tr>'}</table></div></section>"
    chips = "<button class=on data-f=all>همه</button>" + "".join(f"<button data-f={k}>{n}</button>" for k, n in areas.items())
    page = f"""<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>توسعه‌های آینده</title>
<style>:root{{--bg:#fff;--fg:#1c1b1f;--mu:#5f5d66;--bd:#dcdae2;--ac:#2b59c3;--cd:#f6f5f9}}@media(prefers-color-scheme:dark){{:root{{--bg:#16151a;--fg:#ececf1;--mu:#a3a1ab;--bd:#34323c;--ac:#8fb0ff;--cd:#201f26}}}}
body{{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.8 Vazirmatn,Tahoma,sans-serif;max-width:1100px;margin-inline:auto}}h1{{font-size:22px}}h2{{font-size:18px;margin:28px 0 8px}}small{{color:var(--mu)}}
.f{{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}}button{{border:1px solid var(--bd);background:var(--cd);color:var(--fg);padding:5px 12px;border-radius:16px;font:inherit;cursor:pointer}}button.on{{background:var(--ac);color:var(--bg);border-color:var(--ac)}}
.w{{overflow-x:auto}}table{{border-collapse:collapse;width:100%;min-width:640px}}th,td{{border:1px solid var(--bd);padding:6px 10px;text-align:start;vertical-align:top}}th{{background:var(--cd)}}.d{{color:var(--mu);font-size:13px}}.src{{direction:ltr;unicode-bidi:isolate;font-size:12px;color:var(--mu)}}p{{color:var(--mu)}}</style></head><body>
<h1>فهرست متمرکز توسعه‌های آینده</h1><p>{len(rows)} مورد در {len(areas)} بخش.</p><div class=f>{chips}</div>{sec}
<script>document.querySelectorAll('.f button').forEach(b=>b.onclick=()=>{{document.querySelectorAll('.f button').forEach(x=>x.classList.toggle('on',x===b));document.querySelectorAll('section').forEach(s=>s.hidden=b.dataset.f!=='all'&&s.dataset.area!==b.dataset.f)}})</script></body></html>"""
    open(os.path.join(out, "report-fa.html"), "w", encoding="utf-8").write(page)
    print(len(rows), "items ->", out)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", nargs="?", choices=["new"])
    p.add_argument("--check", action="store_true")
    p.add_argument("--out", default=os.path.join(HERE, "_generated"))
    for k in ("slug", "area", "title", "desc", "src", "trig", "date"): p.add_argument("--" + k)
    p.add_argument("--prio", default="پایین"); p.add_argument("--status", default="موکول")
    a = p.parse_args()
    if a.cmd == "new":
        for k in ("slug", "area", "title", "desc", "src", "trig"):
            if not getattr(a, k): sys.exit(f"--{k} is required")
        return cmd_new(a)
    if a.check:
        _, rows, errors = load()
        if errors: sys.exit("future-enhancements register invalid:\n" + "\n".join(errors))
        print(f"future-enhancements register ok: {len(rows)} items"); return
    build(a.out)

main()
