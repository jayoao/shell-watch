"""用「法條欄位」獨立驗證「違規描述」的危害分類。

    python -m tools.hazard_check

────────────────────────────────────────────────────────────────
為什麼需要這一支
────────────────────────────────────────────────────────────────
`pipeline/hazard.py` 說它歸類成功 93.9%。**涵蓋率不是正確率。**
一條抓錯東西的規則，涵蓋率一樣很漂亮。

這個專案已經有一條硬規則：每個訊號都要用一把**獨立的尺**去量 ——
不同的資料來源、不同的邏輯。這裡的獨立尺是 `law_article` 欄位：

    hazard.py 讀的是   violation    （違規事實的白話描述）
    這支讀的是         law_article  （裁處引用的法條）

兩個欄位由裁處機關分開填寫，一個是敘述、一個是法律依據。
法條寫「營造安全衛生設施標準第19條」，那條的內容就是護欄護蓋安全網，
**跟描述怎麼寫無關**。所以兩邊對得起來，才算這個分類器真的在work。

────────────────────────────────────────────────────────────────
法條 → 危害型態的對照從哪裡來
────────────────────────────────────────────────────────────────
⚠ **從法規本文來，不是從資料來。** 如果我看著資料歸納對照表，
   那就不是獨立的尺了 —— 那只是把同一件事量兩次。

以下每一條都在全國法規資料庫查證過（2026-09-03）：

  營造安全衛生設施標準（N0060014）
    §11-1  進入營繕工程工作場所應提供安全帽並使正確戴用      → 頭部防護
    §17    高度二公尺以上應訂定墜落災害防止計畫              → 墜落
    §19    屋頂、鋼梁、開口、階梯、樓梯、坡道…設護欄護蓋安全網 → 墜落
    §20    護欄規格                                        → 墜落
    §22    安全網規格                                      → 墜落
    §25    開口封閉                                        → 墜落
    §42/56/59  施工架組配、懸吊式施工架、鋼管施工架          → 墜落
    §131   模板支撐                                        → 倒塌崩塌

    ⚠ §19 的條文明白把「階梯、樓梯、坡道」列為**墜落**場所。
      這正是 hazard.py 讓「墜落」與「跌倒」互斥的法源 ——
      那不是我拍腦袋決定的順序。

  職業安全衛生設施規則（N0060009）
    §57    機械掃除、上油、檢查、修理應停止運轉及送料        → 機械設備防護
    §281   高度二公尺以上應使用安全帶、安全帽                → 墜落

  職業安全衛生法（N0060001）
    §6Ⅰ①  防止機械、設備或器具引起之危害                    → 機械設備防護
    §6Ⅰ②  防止爆炸性或發火性物質                            → 化學性危害
    §6Ⅰ③  防止電、熱或其他之能                              → 感電
    §6Ⅰ⑤  防止墜落、物體飛落或崩塌                          → 墜落／物體飛落／倒塌崩塌
    §6Ⅰ⑦  防止原料、氣體、粉塵、化學品、缺氧空氣            → 化學性危害／局限空間
    §6Ⅰ⑬  防止通道、地板或階梯等引起之危害                   → 跌倒・滑倒
    §16    危險性機械設備非經檢查合格不得使用                 → 機械設備防護
    §20-22 體格檢查、健康檢查、健康指導、臨場健康服務         → 健康管理
    §23    安全衛生組織人員、管理計畫、自動檢查               → 管理制度
    §24    危險性機械操作人員應僱用合格人員                   → 教育訓練
    §25-28 承攬、共同作業、共同承攬                          → 承攬管理
    §32    安全衛生教育訓練                                 → 教育訓練
    §37    職業災害急救搶救、八小時內通報                     → 職災通報

  ⚠ 沒有列的條號（§6Ⅰ④⑥⑧⑨⑩⑪⑫⑭、§18、§22-1 職場霸凌…）
    是**故意留白**：hazard.py 沒有對應的類別，硬編一個對照
    只會讓數字好看。沒有證據就不要加規則。
"""
from __future__ import annotations

import csv
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                 # noqa: E402
from pipeline.hazard import HAZARDS, classify      # noqa: E402

RECORDS = Path("data/records.csv")
NAMES = {code: name for code, name, _p, _d in HAZARDS}

# 條號可能寫成「第19條」「第19條第1項」「第11-1條」「第6條第1項第5款」
# 也可能是國字「第三十七條第二項」。全部先正規化成半形阿拉伯數字。
_CJK_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
            "六": 6, "七": 7, "八": 8, "九": 9}


def _cjk_to_int(s: str) -> str:
    """三十七 → 37，十一 → 11，六 → 6。只處理 1–99，法條號夠用。"""
    if not s or any(c not in "一二三四五六七八九十" for c in s):
        return s
    if "十" not in s:
        return str(_CJK_NUM.get(s, s))
    a, _, b = s.partition("十")
    return str((_CJK_NUM.get(a, 1) if a else 1) * 10 + (_CJK_NUM.get(b, 0) if b else 0))


_ART = re.compile(r"第([0-9０-９一二三四五六七八九十]+(?:-[0-9]+)?)條")


def normalize(article: str) -> str:
    """把全形數字與國字條號換成半形阿拉伯數字，其餘原樣保留。"""
    t = (article or "").translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    return _ART.sub(lambda m: f"第{_cjk_to_int(m.group(1))}條", t)


# (比對法條欄位的規則, 期待的危害型態集合, 這條法規在講什麼)
# ⚠ 順序有意義：先比對「子法條號」再比對「母法條號」。
#    「營造安全衛生設施標準第19條暨職業安全衛生法第6條第1項」兩邊都有，
#    但子法講得比較具體，以子法為準。
ARTICLE_RULES: list[tuple[str, set[str], str]] = [
    (r"營造安全衛生設施標準第11-1條", {"helmet"}, "安全帽"),
    (r"營造安全衛生設施標準第(17|19|20|22|24|25|42|56|59)條", {"fall"},
     "墜落防止計畫／護欄護蓋安全網／施工架"),
    (r"營造安全衛生設施標準第131條", {"collapse"}, "模板支撐"),
    (r"職業安全衛生設施規則第57條", {"machine"}, "機械掃除上油應停機"),
    (r"職業安全衛生設施規則第281條", {"fall"}, "二公尺以上應使用安全帶"),
    (r"職業安全衛生法第16條", {"machine"}, "§16 危險性機械設備檢查合格"),
    (r"職業安全衛生法第2[012]條", {"health"}, "§20-22 體格／健康檢查"),
    (r"職業安全衛生法第23條", {"org"}, "§23 安全衛生管理"),
    (r"職業安全衛生法第(24|32)條", {"training"}, "§24/§32 教育訓練與合格人員"),
    (r"職業安全衛生法第2[5678]條", {"contract"}, "§25-28 承攬與共同作業"),
    (r"職業安全衛生法第37條", {"report"}, "§37 急救搶救與八小時通報"),
]
_RULES = [(re.compile(p), s, d) for p, s, d in ARTICLE_RULES]


# ── 職安法第 6 條第 1 項的「款」要真的解析出來，不能用正規表示式硬湊 ──
# ⚠ 這裡踩過一次坑：原本寫 r"第[^款]{0,8}3[^0-9款]{0,4}款" 想抓第3款，
#   結果「第13款」也被吃掉，害我以為分類器把「通道地板階梯」抓錯，
#   其實是**驗證工具自己**把第13款讀成第3款。
#   驗證工具出錯比被驗的東西出錯更危險，因為它會讓你去改本來對的程式。
_K_SECTION = re.compile(r"職業安全衛生法第6條第1項")
_K_ITEM = re.compile(r"第\s*([0-9]+(?:\s*[、,，及和]\s*(?:第\s*)?[0-9]+)*)\s*款")

# 條文原文（N0060001 §6Ⅰ）逐款對照。沒有對應類別的款**故意留白**。
KUAN_HAZARD: dict[int, set[str]] = {
    1: {"machine"},                            # 機械、設備或器具
    2: {"chemical"},                           # 爆炸性或發火性物質
    3: {"electric"},                           # 電、熱或其他之能
    4: {"object"},                             # 採石採掘裝卸搬運堆積採伐
    5: {"fall", "object", "collapse", "helmet"},  # 墜落、物體飛落、崩塌
    7: {"chemical", "confined"},               # 原料氣體粉塵化學品缺氧空氣
    10: {"chemical"},                          # 廢氣廢液殘渣
    13: {"trip"},                              # 通道、地板或階梯
}


def kuan_expected(article: str) -> tuple[set[str], str] | None:
    """回傳第 6 條第 1 項單一款的期待類別。

    ⚠ **只有引用「單獨一款」時才拿來當尺。**
      公告常寫「第1、3、5款」，那等於把三種危害全都圈進來，
      對得上是理所當然的 —— 拿這種列舉去算命中率是在自己給自己送分。
    """
    t = normalize(article)
    m = _K_SECTION.search(t)
    if not m:
        return None
    nums: set[int] = set()
    for g in _K_ITEM.findall(t[m.end():]):
        nums |= {int(x) for x in re.findall(r"[0-9]+", g)}
    known = {n for n in nums if n in KUAN_HAZARD}
    if len(nums) != 1 or len(known) != 1:
        return None
    n = known.pop()
    return KUAN_HAZARD[n], f"§6Ⅰ第{n}款"


def expected_of(article: str) -> tuple[set[str], str] | None:
    """子法條號優先（講得比較具體），再退回母法第 6 條的款。"""
    t = normalize(article)
    for rx, want, desc in _RULES:
        if rx.search(t):
            return want, desc
    return kuan_expected(article)



def _single_kuan(article: str) -> int | None:
    """只引用一款時回傳那個款號，否則 None。上面 kuan_expected 的裸版本。"""
    t = normalize(article)
    m = _K_SECTION.search(t)
    if not m:
        return None
    nums: set[int] = set()
    for g in _K_ITEM.findall(t[m.end():]):
        nums |= {int(x) for x in re.findall(r"[0-9]+", g)}
    return nums.pop() if len(nums) == 1 else None


def cite_consistency(rows: list[dict]) -> None:
    """同一句違規描述，被引到第 6 條第 1 項的哪幾款。

    ⚠ 這一段在回答一個很重要的問題：上面那張表對不起來的時候，
      到底是**我們的分類器錯**，還是**法條欄位本身就不一致**？

      如果同一句話（一字不差）在不同縣市被引到第 13 款、第 5 款、
      第 7 款、第 1 款，那法條欄位就不是一把穩定的尺 ——
      不一致是它造成的，不是我們造成的。

      這不是在替自己脫罪。這是資料品質的發現，
      而且它反過來說明了為什麼要讀**描述**而不是只信法條欄位。
    """
    by_text: dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        k = _single_kuan(r.get("law_article", ""))
        if k is None:
            continue
        t = (r.get("violation") or "").strip()
        if t:
            by_text[t][k] += 1

    multi = {t: c for t, c in by_text.items() if len(c) >= 2 and sum(c.values()) >= 30}
    n_all = sum(sum(c.values()) for c in by_text.values())
    n_multi = sum(sum(c.values()) for c in by_text.values() if len(c) >= 2)
    print(f"\n  法條欄位自己一致嗎？只引一款的 {n_all:,} 筆裡，"
          f"有 {n_multi:,} 筆（{100 * n_multi / n_all:.1f}%）")
    print("  的違規描述**一字不差**，卻在不同筆被引到不同款：")
    for t, c in sorted(multi.items(), key=lambda kv: -sum(kv[1].values()))[:4]:
        spread = "　".join(f"第{k}款 {v:,}" for k, v in c.most_common())
        print(f"      {t[:44]}")
        print(f"        {spread}")


def se(p: float, n: int) -> float:
    """一個比例的標準誤。這個專案的規矩：比較兩個比例一律看 2 SE。"""
    return math.sqrt(p * (1 - p) / n) if n else 0.0


def main() -> int:
    use_utf8_stdout()
    if not RECORDS.exists():
        print(f"找不到 {RECORDS}", file=sys.stderr)
        return 1
    rows = [r for r in csv.DictReader(RECORDS.open(encoding="utf-8-sig"))
            if r.get("law") == "職業安全衛生法"]

    stat: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0])   # 命中/漏抓/不同類
    wrong: dict[str, Counter] = defaultdict(Counter)
    miss: dict[str, Counter] = defaultdict(Counter)
    checked = 0

    for r in rows:
        exp = expected_of(r.get("law_article", ""))
        if exp is None:
            continue
        want, desc = exp
        checked += 1
        got = set(classify(r.get("violation", "")))
        # 收容類別不算「講了別的東西」——它本來就是「沒說是哪一種」
        got_real = got - {"general"}
        if got_real & want:
            stat[desc][0] += 1
        elif not got_real:
            stat[desc][1] += 1
            miss[desc][(r.get("violation") or "")[:52]] += 1
        else:
            stat[desc][2] += 1
            wrong[desc][" + ".join(sorted(NAMES[g] for g in got_real))] += 1

    print(f"職安法 {len(rows):,} 筆，其中 {checked:,} 筆的法條欄位"
          f"對得到明確的危害型態（{100 * checked / len(rows):.1f}%）")
    print("剩下的多半是「職業安全衛生法第6條第1項」這種沒寫到款的，"
          "法條本身就沒說是哪一種危害。\n")

    print(f"  {'法條說的是':<28}{'筆數':>8}{'描述也這樣說':>12}{'±2SE':>8}"
          f"{'描述沒說':>9}{'描述說別的':>10}")
    print("  " + "─" * 76)
    tot = [0, 0, 0]
    for desc, (ok, none, other) in sorted(stat.items(),
                                          key=lambda kv: -sum(kv[1])):
        n = ok + none + other
        p = ok / n
        tot = [tot[i] + v for i, v in enumerate((ok, none, other))]
        print(f"  {desc:<28}{n:>8,}{100 * p:>11.1f}%{2 * 100 * se(p, n):>7.1f}%"
              f"{100 * none / n:>8.1f}%{100 * other / n:>9.1f}%")
    n = sum(tot)
    p = tot[0] / n
    print("  " + "─" * 76)
    print(f"  {'合計':<28}{n:>8,}{100 * p:>11.1f}%{2 * 100 * se(p, n):>7.1f}%"
          f"{100 * tot[1] / n:>8.1f}%{100 * tot[2] / n:>9.1f}%")

    print("\n  ⚠ 「描述說別的」不必然是錯的 —— 一筆裁處常常同時違反好幾條，")
    print("     法條欄位只寫了其中一條。但比例太高的那幾列要進去看。\n")
    for desc, c in sorted(wrong.items(), key=lambda kv: -sum(kv[1].values()))[:4]:
        print(f"  【{desc}】法條這樣說，描述卻被歸成：")
        for k, v in c.most_common(3):
            print(f"      {v:>5,}  {k}")
    print()
    for desc, c in sorted(miss.items(), key=lambda kv: -sum(kv[1].values()))[:3]:
        print(f"  【{desc}】法條這樣說，描述卻一類都沒中：")
        for k, v in c.most_common(3):
            print(f"      {v:>5,}  {k}")

    cite_consistency(rows)

    print("""
⚠ 這把尺量的是「兩個獨立欄位講的是不是同一件事」，不是「分類正確率」。
   法條欄位本身也會填錯、也會只填一條。它能證明的是：
   分類器不是在亂抓 —— 抓到的東西跟裁處機關引用的法條對得起來。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
