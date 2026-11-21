#!/usr/bin/env python3
"""از items.py فهرست اصلی، فایل هر بخش و گزارش HTML را می‌سازد. اجرا: python3 generate.py"""
import os, html, importlib.util, collections
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("items", os.path.join(here, "items.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ROOT = os.path.abspath(os.path.join(here, "..", ".."))
rows = [dict(id=f"FE-{i+1:03d}", area=a, title=t, desc=d, src=s, date=dt, trig=tr, prio=p, status=st)
        for i, (a, t, d, s, dt, tr, p, st) in enumerate(m.I)]
by = collections.defaultdict(list)
for r in rows: by[r["area"]].append(r)
H = "| شناسه | عنوان | توضیح | منبع | شرط یا زمان اجرا | اولویت | وضعیت | ثبت |\n|---|---|---|---|---|---|---|---|\n"
def tbl(rs):
    return H + "".join(f"| {r['id']} | {r['title']} | {r['desc']} | `{r['src']}` | {r['trig']} | {r['prio']} | {r['status']} | {r['date']} |\n" for r in rs)
RULE = "قاعدهٔ افزودن: فقط `docs/future-enhancements/items.py` را ویرایش کن (یک ردیف فقط در انتهای فهرست؛ ترتیب شناسه‌ها را بههم نزن)، سپس `python3 docs/future-enhancements/generate.py` را اجرا کن. این کار فهرست اصلی و فایل همهٔ بخش‌ها را هم‌زمان به‌روز می‌کند."
out = ["# فهرست متمرکز توسعه‌های آینده\n",
 "هر قابلیت یا ارتقایی که به آینده موکول می‌شود اینجا و هم‌زمان در مستندات بخش مربوط ثبت می‌شود. این فایل خودکار تولید می‌شود؛ دستی ویرایش نکنید.\n",
 RULE + "\n", "## خلاصه\n", "| بخش | تعداد | فایل بخش |\n|---|---|---|\n"]
for k, n in m.AREAS.items():
    out.append(f"| {n} | {len(by[k])} | `docs/future-enhancements/{k}/README.md` |\n")
out.append(f"| جمع | {len(rows)} | |\n")
for k, n in m.AREAS.items():
    out.append(f"\n## {n}\n\n" + (tbl(by[k]) if by[k] else "موردی ثبت نشده است.\n"))
    d = os.path.join(ROOT, "docs", "future-enhancements", k); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "README.md"), "w") as f:
        f.write(f"# توسعه‌های آینده: {n}\n\nنمای همین بخش از فهرست متمرکز (`docs/future-enhancements/README.md`). خودکار تولید می‌شود؛ مورد جدید را در `items.py` ثبت کنید.\n\n" + (tbl(by[k]) if by[k] else "موردی ثبت نشده است.\n"))
open(os.path.join(ROOT, "docs", "future-enhancements", "README.md"), "w").write("".join(out))
# HTML گزارش
def esc(x): return html.escape(x)
sec = ""
for k, n in m.AREAS.items():
    cards = "".join(f"<tr><td>{r['id']}</td><td><b>{esc(r['title'])}</b><br><span class=d>{esc(r['desc'])}</span></td><td><span class=src>{esc(r['src'])}</span></td><td>{esc(r['trig'])}</td><td>{r['prio']}</td><td>{r['status']}</td></tr>" for r in by[k])
    sec += f"<section data-area='{k}'><h2>{n} <small>({len(by[k])})</small></h2><div class=w><table><tr><th>شناسه</th><th>مورد</th><th>منبع</th><th>شرط یا زمان</th><th>اولویت</th><th>وضعیت</th></tr>{cards or '<tr><td colspan=6>موردی ثبت نشده</td></tr>'}</table></div></section>"
chips = "<button class=on data-f=all>همه</button>" + "".join(f"<button data-f={k}>{n}</button>" for k, n in m.AREAS.items())
page = f"""<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>توسعه‌های آینده</title>
<style>:root{{--bg:#fff;--fg:#1c1b1f;--mu:#5f5d66;--bd:#dcdae2;--ac:#2b59c3;--cd:#f6f5f9}}@media(prefers-color-scheme:dark){{:root{{--bg:#16151a;--fg:#ececf1;--mu:#a3a1ab;--bd:#34323c;--ac:#8fb0ff;--cd:#201f26}}}}
body{{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.8 Vazirmatn,Tahoma,sans-serif;max-width:1100px;margin-inline:auto}}h1{{font-size:22px}}h2{{font-size:18px;margin:28px 0 8px}}small{{color:var(--mu)}}
.f{{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}}button{{border:1px solid var(--bd);background:var(--cd);color:var(--fg);padding:5px 12px;border-radius:16px;font:inherit;cursor:pointer}}button.on{{background:var(--ac);color:var(--bg);border-color:var(--ac)}}
.w{{overflow-x:auto}}table{{border-collapse:collapse;width:100%;min-width:640px}}th,td{{border:1px solid var(--bd);padding:6px 10px;text-align:start;vertical-align:top}}th{{background:var(--cd)}}.d{{color:var(--mu);font-size:13px}}.src{{direction:ltr;unicode-bidi:isolate;font-size:12px;color:var(--mu)}}p{{color:var(--mu)}}</style></head><body>
<h1>فهرست متمرکز توسعه‌های آینده</h1><p>{len(rows)} مورد در {len(m.AREAS)} بخش. منبع: <span class=src>handoffs/future-enhancements-fa.md</span></p><div class=f>{chips}</div>{sec}
<script>document.querySelectorAll('.f button').forEach(b=>b.onclick=()=>{{document.querySelectorAll('.f button').forEach(x=>x.classList.toggle('on',x===b));document.querySelectorAll('section').forEach(s=>s.hidden=b.dataset.f!=='all'&&s.dataset.area!==b.dataset.f)}})</script></body></html>"""
open("/tmp/report-fa.html", "w").write(page)
print(len(rows), "items")
