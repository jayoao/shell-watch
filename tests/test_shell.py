"""換殼／集團分類規則的測試。

    python tests/test_shell.py

這些規則會決定一家公司出不出現在「換殼候選」名單上，
誤判的代價是實質的名譽損害，所以每改一條規則都要跑這個。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                  # noqa: E402
from pipeline.shell import classify, form_of, name_similarity       # noqa: E402

# (公司名清單, 期間是否依序, 期望分類)
CASES = [
    # 真實集團（2026-09-02 由系統自己從公開紀錄拼出來的，可公開查證）
    (["統一超商股份有限公司", "統一企業股份有限公司",
      "統昶行銷股份有限公司", "統健實業股份有限公司"], False, "集團"),
    (["遠東百貨股份有限公司", "遠百企業股份有限公司",
      "遠傳電信股份有限公司"], True, "集團"),
    (["泰興交通股份有限公司", "茂興通運股份有限公司",
      "茂昕交通股份有限公司", "泰昕汽車交通股份有限公司"], True, "集團"),
    # 換殼的樣子：先後接續、小型組織、名稱不相關
    (["建豐工程行", "順昌企業社"], True, "換殼候選"),
    (["大川營造有限公司", "力新營造有限公司", "日昇工程行"], True, "換殼候選"),
    # 期間重疊 = 同時經營，定義上不是換殼
    (["甲有限公司", "乙有限公司"], False, "集團"),
    # 兩家股份有限公司、依序 —— 資訊不足，不要硬判
    (["甲股份有限公司", "乙股份有限公司"], True, "存疑"),
    # ↓ 2026-09-02 在真實輸出的前 10 名裡抓到的假陽性，兩種都會冤枉人
    #   同一家公司變更組織型態，字號沒變
    (["菜豚屋餐飲有限公司", "菜豚屋餐飲股份有限公司"], True, "組織變更"),
    #   外商在台分公司改名。分公司不是獨立法人，換不了殼
    (["香港商亞洲博聞有限公司台灣分公司",
      "香港商亞洲英富曼會展有限公司台灣分公司"], True, "分支機構"),
    #   本店與分支：一家的名字完整包含另一家
    (["訪寶得有限公司大墩營業所", "訪寶得有限公司"], True, "同一公司"),
    (["台塑石化股份有限公司", "台塑石化股份有限公司麥寮二廠"], True, "同一公司"),
    #   三家理髮店先後接續 —— 這才是換殼該有的樣子
    (["桃壢剪髮屋", "高鳳精剪屋", "唯裕誠精剪屋"], True, "換殼候選"),
]

SIM = [
    (["統一超商股份有限公司", "統一企業股份有限公司", "統昶行銷股份有限公司"], 0.6, 1.01),
    (["遠東百貨股份有限公司", "遠百企業股份有限公司", "遠傳電信股份有限公司"], 0.6, 1.01),
    (["奉茶美食館", "米塔政大有限公司", "二雪映月有限公司"], -0.01, 0.34),
    (["建豐工程行", "順昌企業社"], -0.01, 0.34),
]

FORMS = [("統一企業股份有限公司", "股份"), ("大川營造有限公司", "小型"),
         ("順昌企業社", "小型"), ("建豐工程行", "小型"),
         ("金源土木包工業", "小型"), ("漁滿昌86號", "其他")]


def main() -> int:
    use_utf8_stdout()
    bad = 0

    print("── 分類 ──")
    for names, seq, want in CASES:
        got, why = classify(names, seq, len(names))
        ok = got == want
        bad += not ok
        mark = "✓" if ok else "✗"
        print(f"  {mark} {got:<8}（期望 {want}）　{why}")
        if not ok:
            print(f"      {names}")

    print("\n── 名稱相似度 ──")
    for names, lo, hi in SIM:
        v = name_similarity(names)
        ok = lo < v < hi
        bad += not ok
        print(f"  {'✓' if ok else '✗'} {v:.2f}  應在 ({lo:.2f}, {hi:.2f})　{names[0]} …")

    print("\n── 組織型態 ──")
    for name, want in FORMS:
        got = form_of(name)
        ok = got == want
        bad += not ok
        print(f"  {'✓' if ok else '✗'} {name:<24} → {got}（期望 {want}）")

    n = len(CASES) + len(SIM) + len(FORMS)
    print(f"\n{n - bad}/{n} 正確")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
