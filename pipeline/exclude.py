"""排除規則 —— 擋掉兩種會產生荒謬結論的資料。

這不是可選的清理步驟，是必要的。實際資料裡有這兩筆：

    國立臺灣大學醫學院附設醫院(吳明賢)   工會法第35條   罰鍰 100,000
    台灣積體電路製造股份有限公司(魏哲家)  職安法       罰鍰 150,000

吳明賢是台大醫院院長，魏哲家是台積電董事長。他們都不是「換殼的小老闆」，
不排除的話系統會產出「台大醫院院長是慣性違法雇主」這種會上新聞的錯誤。

排除清單一定要留紀錄（exclusions 表），決賽會被問「你們怎麼處理誤判」。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# ── 公部門、學校、醫院、法人 ──────────────────────────────
# 這些機構的「負責人」是機關首長，不是企業主。
_PUBLIC_PATTERNS = [
    r"^國立", r"^市立", r"^縣立", r"^公立", r"^省立",
    r"財團法人", r"社團法人", r"行政法人",
    r"大學", r"學院", r"高級中學", r"國民中學", r"國民小學", r"^.{0,6}學校$",
    r"附設醫院", r"衛生所", r"衛生局",
    r"^.{0,8}(縣|市)政府", r"議會", r"^.{0,10}公所$",
    r"農會$", r"漁會$", r"水利會$", r"合作社$",
    r"^.{0,10}(署|局|處|委員會|管理局|管理處)$",
]
_PUBLIC = re.compile("|".join(_PUBLIC_PATTERNS))


@dataclass
class ExclusionResult:
    excluded: bool
    reason: str = ""


def is_public_sector(company: str) -> bool:
    """公部門／學校／法人。只看名稱，之後可用商工登記的組織別再確認一次。"""
    return bool(_PUBLIC.search(company or ""))


def is_large_enterprise(
    *,
    paid_in_capital: int | None = None,
    established_year: int | None = None,
    current_year: int = 2026,
    is_listed: bool = False,
    director_count: int | None = None,
) -> bool:
    """大企業的代表人是專業經理人，名下有多家關係企業是正常的公司治理。

    換殼的特徵本來就是「小公司、短命、快速解散重開」，
    所以這個過濾不是額外工作 —— 它等於在定義我們要找的對象。
    """
    if is_listed:
        return True
    if paid_in_capital is not None and paid_in_capital >= 100_000_000:   # 一億
        return True
    if established_year is not None and current_year - established_year >= 20:
        return True
    if director_count is not None and director_count >= 7:
        return True
    return False


def screen(company: str, **company_facts) -> ExclusionResult:
    """單一入口。回傳要不要排除以及理由（理由一定要存下來）。"""
    if is_public_sector(company):
        return ExclusionResult(True, "公部門／學校／法人：負責人為機關首長，非企業主")
    if is_large_enterprise(**company_facts):
        return ExclusionResult(True, "大型企業：代表人為專業經理人，多重董事席位屬正常治理")
    return ExclusionResult(False)


if __name__ == "__main__":
    cases = [
        ("國立臺灣大學醫學院附設醫院", {}),
        ("臺北市政府警察局", {}),
        ("新北市三重區公所", {}),
        ("台灣積體電路製造股份有限公司", {"paid_in_capital": 259_323_700_670}),
        ("宏達營造股份有限公司", {"paid_in_capital": 5_000_000, "established_year": 2019}),
        ("翔昇金屬工業股份有限公司", {"paid_in_capital": 3_000_000, "established_year": 2021}),
        ("某某農會", {}),
        ("中山中心有限公司", {}),   # 不能誤殺
    ]
    for name, facts in cases:
        r = screen(name, **facts)
        mark = "排除" if r.excluded else "保留"
        print(f"  [{mark}] {name:<28} {r.reason}")
