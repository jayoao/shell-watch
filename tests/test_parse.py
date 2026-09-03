"""跑真實資料的邊角。

    python tests/test_parse.py            # 看結果
    python tests/test_parse.py --failed   # 只看拆不開的

────────────────────────────────────────────────────────────────
⚠ 這裡的公司名與人名都是**合成的**，不是真實的
────────────────────────────────────────────────────────────────
原始樣本是 2026-09-02 從勞動部 66 萬筆裁處公告裡撈出來的真實資料，
但這個 repo 是公開的，把幾百個真人姓名連同「違反勞動法令」一起推上去，
跟政府依法公告是兩回事 —— 而且 git 歷史事後刪不乾淨。

所以做了假名化：**逐字元替換，保留所有結構特徵** ——
字數、括號位置、全形半形、「即」字、巢狀括號、合夥負責人寫法、
罕用字（含 Unicode 增補平面）、原住民姓名的分隔點、日籍姓名、
外文姓名、去識別化的 OO、機構字尾。

這些 fixture 測的是**解析器怎麼處理各種形狀**，不是特定的某個人，
所以假名化之後測試價值完全不變。替換前後的分類分布也比對過，一致。

`tests/fixtures/hard_employers.txt` 同樣是假名化過的。
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                # noqa: E402
from pipeline.parse import parse_employer         # noqa: E402

# (原始欄位, 期望的事業單位, 期望的負責人)
CANON = [
    ("台灣勇華昇甄明和股份有限公司(郗德耿)", "台灣勇華昇甄明和股份有限公司", "郗德耿"),
    ("信平營造股份有限公司 (闞康杭)", "信平營造股份有限公司", "闞康杭"),
    ("昇恆昌泰科技股份有限公司（解耀商）", "昇恆昌泰科技股份有限公司", "解耀商"),
    ("曾岳旺即德安企業社", "德安企業社", "曾岳旺"),
    ("衛利薊", None, "衛利薊"),
    ("毅智游勞順紀有限公司", "毅智游勞順紀有限公司", None),
    ("台灣電力股份有限公司(順倪區義興智)(陶晁堵)", "台灣電力股份有限公司", "陶晁堵"),
    ("景廣宏(自然人)(景廣宏)", None, "景廣宏"),
    ("扈順毅明盛和昇(合夥負責人蕭利隆)", "扈順毅明盛和昇", "蕭利隆"),
    ("毛豐土木包工業合夥負責人夏順信", "毛豐土木包工業", "夏順信"),
    ("自然人卜義仁", None, "卜義仁"),
    ("自營作業者司司宏", None, "司司宏"),
    ("狐德平(利禮企業社)", "利禮企業社", "狐德平"),
    ("文遠興(富逄76號漁船)", "富逄76號漁船", "文遠興"),
    ("王義貴〈即勇順工程行〉", "勇順工程行", "王義貴"),
    ("康順貴 即扈康明寧", "扈康明寧", "康順貴"),
    ("蒲曾(台灣)股份有限公司(荊和禮)", "蒲曾(台灣)股份有限公司", "荊和禮"),
    ("榮(杭隆)營造股份有限公司", "榮(杭隆)營造股份有限公司", None),
    ("晉昇有限公司(汲耀𥡩)", "晉昇有限公司", "汲耀𥡩"),
    ("隆順和．仇逯即廣寧工程行(隆順和．仇逯)", "廣寧工程行", "隆順和．仇逯"),
    ("昝毅科技股份有限公司(暨耀 商宮)", "昝毅科技股份有限公司", "暨耀商宮"),
    ("昇暴順紀股份有限公司(德暴投資控股股份有限公司(法定代理人:鄂利))", "昇暴順紀股份有限公司", "鄂利"),
    ("信安股份有限公司(財團法人路勇順順晏德志基金會)", "信安股份有限公司", None),
    ("祥皮山86號", "祥皮山86號", None),
    ("倪寧縣水里鄉公所", "倪寧縣水里鄉公所", None),
    ("泰和牛肉麵(路喬晉)", "泰和牛肉麵", "路喬晉"),
    ("仁祥鍋物(解志謝)", "仁祥鍋物", "解志謝"),
    ("興和飯糰(闞安)", "興和飯糰", "闞安"),
    ("康明書院(康耀義)", "康明書院", "康耀義"),
    ("總舖師", "總舖師", None),
    ("安恆咖啡屋", "安恆咖啡屋", None),
    ("豐安縣私立利昌禮人長期照顧中心(養護型)", "豐安縣私立利昌禮人長期照顧中心", None),
    ("東京都保全股份有限公司(貴暨旺)", "東京都保全股份有限公司", "貴暨旺"),
    ("平昇國際晏興銀行股份有限公司(宏應利)", "平昇國際晏興銀行股份有限公司", "宏應利"),
    ("祥興企業股份有限公司(齊華安)", "祥興企業股份有限公司", "齊華安"),
]

# 這些一定要拆不開 —— 硬拆開反而危險（多名共同雇主、括號沒配對、法條跑錯欄）
MUST_FAIL = [
    "狐訾甄及陶順蒲等2人",
    "路孫華等5人",
    "職業安全衛生法第27條第1項",
    "豐熊安宏智富毅遠股份有限公司(武勇康",
    "仁訾營造股份有限公司(夏和旺))",
    "",
]


def main() -> int:
    use_utf8_stdout()
    only_failed = "--failed" in sys.argv
    bad = 0

    print("── 指定答案的樣本 ──")
    for raw, want_c, want_p in CANON:
        got = parse_employer(raw)
        ok = got.company == want_c and got.principal == want_p
        bad += not ok
        if not ok:
            print(f"  ✗ {raw}")
            print(f"      期望 {want_c} | {want_p}")
            print(f"      實得 {got.company} | {got.principal}  ({got.kind})")
    print(f"  {len(CANON) - bad}/{len(CANON)} 正確")

    print("\n── 一定要拆不開的（拆開反而危險）──")
    for raw in MUST_FAIL:
        got = parse_employer(raw)
        if got.ok:
            bad += 1
            print(f"  ✗ {raw!r} 不該被拆開，卻拆成 {got.company} | {got.principal}")
    print(f"  {len(MUST_FAIL)} 筆檢查完畢")

    path = Path(__file__).parent / "fixtures" / "hard_employers.txt"
    rows = [l.rstrip("\n") for l in path.read_text(encoding="utf-8").splitlines()
            if l.strip()]
    kinds: Counter[str] = Counter()
    fails = []
    for raw in rows:
        p = parse_employer(raw)
        kinds[p.kind] += 1
        if not p.ok:
            fails.append(p)

    print(f"\n── 邊角樣本 {len(rows)} 種 ──")
    for k, n in kinds.most_common():
        print(f"  {k:<24} {n:>4}   {100 * n / len(rows):5.1f}%")
    ok_n = len(rows) - len(fails)
    print(f"  拆得開 {ok_n}/{len(rows)}（{100 * ok_n / len(rows):.1f}%）")

    if fails:
        print("\n  拆不開的（這些會進 unparsed.csv 給人工看）：")
        for p in fails:
            print(f"    {p.raw:<44} {p.reason}")

    if not only_failed:
        print("\n  抽樣看拆解結果：")
        for raw in [r for r in rows if parse_employer(r).ok][:12]:
            p = parse_employer(raw)
            note = f"  ⚑{p.note}" if p.note else ""
            print(f"    [{p.kind:<22}] {p.raw:<40} → "
                  f"{p.company or '—'} ｜ {p.principal or '—'}{note}")

    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
