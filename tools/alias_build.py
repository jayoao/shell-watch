"""常見簡稱／品牌／英文名對照表 → web/src/data/alias.json。

    python -m tools.alias_build

tools/alias_seed.tsv 是 AI 輔助整理的初稿。這支程式**逐筆核對商工登記**：
法定名稱在商工登記查不到的一律丟掉並列出來 —— AI 編出來的名字過不了這一關。
⚠ 核對只證明「這家公司存在」，不證明「這個品牌是它經營的」。後者要人工抽查。
⚠ 鍵的正規化跟前端 web/src/lib/lookup.ts 的 aliasKey() 一模一樣：
  轉半形、轉小寫、拿掉空白與 - _ . ' ’ °，臺→台。
"""
from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.join import norm_name                                   # noqa: E402

SEED = Path("tools/alias_seed.tsv")
DB = Path("data/gcis.duckdb")
OUT = Path("web/src/data/alias.json")


def alias_key(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).lower().replace("臺", "台")
    return "".join(ch for ch in s if ch not in " \t-_.'’°")


def in_records(nn: str) -> bool:
    from pipeline.publish import SHARDS, fnv1a
    p = Path(f"web/public/data/c/{fnv1a(nn) % SHARDS}.json")
    return p.exists() and nn in json.loads(p.read_text(encoding="utf-8")).get("e", {})


def main() -> int:
    use_utf8_stdout()
    import duckdb
    con = duckdb.connect(str(DB), read_only=True)
    out: dict[str, list[str]] = {}
    bad: list[str] = []
    ok = 0
    for line in SEED.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        aliases, names = line.split("\t")
        keep = []
        for n in names.split("|"):
            nn = norm_name(n)
            hit = con.execute(
                "SELECT count(*) FROM entity WHERE name_norm = ? "
                "AND status IN ('核准設立','核准登記','核准報備')", [nn]).fetchone()[0]
            # ⚠ 商工登記快照（g0v 鏡像）缺了一些大公司：家福、統一星巴克、來來超商都不在裡面，
            #   但它們在勞動部公告裡有紀錄。所以「有裁處紀錄」也算存在。
            if not hit and in_records(nn):
                hit = 1
            if hit:
                keep.append(nn)
            else:
                bad.append(f"{aliases.split('|')[0]} → {n}")
        if not keep:
            continue
        ok += 1
        for a in aliases.split("|"):
            k = alias_key(a)
            if k:
                out.setdefault(k, [])
                out[k] += [x for x in keep if x not in out[k]]
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
                   encoding="utf-8")
    print(f"核對通過 {ok} 組，{len(out)} 個別名 → {OUT}")
    if bad:
        print(f"⚠ 商工登記查不到（或不是營業中）而丟掉的 {len(bad)} 筆：")
        for b in bad:
            print("   ", b)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
