"""自動更新：重抓一輪，跟上一輪比對，說出「這次變了什麼」。

    python -m pipeline.refresh --baseline     # 第一次：把現在的 data/raw 存成基準快照
    python -m pipeline.refresh                # 重抓 → 比對 → 出報告（**不動 data/raw**）
    python -m pipeline.refresh --promote      # 檢查過了，把 raw_new 換上去
    python -m pipeline.refresh --diff-only    # 不重抓，只比 data/raw 與 data/raw_new

────────────────────────────────────────────────────────────────
為什麼這支值得存在
────────────────────────────────────────────────────────────────
決賽的「資料使用度」占 30%。抓一次資料做一個網站，是「用了資料」；
**持續追蹤同一批公告的生滅與變更**，才是「把資料用起來」。

而且這件事在這個題目上不是裝飾，是本來就該做的：

  1. 各縣市的公告**會下架**。台北市勞基法涵蓋 12 年，有些縣市不到 2 年。
     「這筆公告上個月還在、這個月不見了」是真實會發生的事，
     而我們的網站如果只是靜態快照，就會顯示已經被撤下的紀錄。

  2. **訴願結果會變。** 備註欄實際出現過「提起訴願」→「訴願駁回(原處分維持)」。
     我們的查詢頁會把「尚未確定」標出來，那個標示會過期。
     比對出「這 N 筆的訴願狀態變了」，網站才有辦法跟著更新。

  3. 新增的公告才是使用者真正要的。「上一輪到這一輪之間新增 N 筆」
     是這個系統唯一能證明自己還活著的數字。

────────────────────────────────────────────────────────────────
⚠ 三個一定要守的規則
────────────────────────────────────────────────────────────────

**⚠ 一、重抓不可以直接蓋掉 data/raw。**
抓一輪要 300 次請求、約半小時，中間可能斷線、可能被擋、網站可能改版。
直接蓋的話，抓壞的那一刻你就同時失去了舊資料與比對的能力。
所以：抓進 data/raw_new/ → 比對 → 檢查 → 才 promote。

**⚠ 二、筆數變少要當成可疑，不是當成事實。**
「查詢系統少報違規紀錄」是這個專案最不能犯的錯。某一組（單位×法規）
這次抓回來比上次少，有兩種可能：真的下架了，或是這次抓壞了。
程式分不出來，所以**一律擋下來讓人看**。要接受縮水得自己加 --accept-shrink。

**⚠ 三、「編號」欄不可以參與比對。**
第 0 欄「編號」是結果集裡的流水號（1..N）。只要中間插進一筆新公告，
它後面每一筆的編號全部往後移。把它算進內容雜湊的話，
新增 1 筆會被報成「43,436 筆內容變更」——整份報告就廢了。

────────────────────────────────────────────────────────────────
怎麼認出「同一筆公告」
────────────────────────────────────────────────────────────────
來源沒有主鍵。用這幾欄組出識別碼：

    單位代碼 + 法規代碼 + 處分字號 + 事業單位名稱(負責人) + 處分日期 + 違反法規條款

實測（職安署 × 職安法，43,437 筆）這樣還是有 84 筆（0.19%）撞在一起，
所以再加一個**組內出現序號**。副作用要講清楚：如果某個重複組多了或少了
一筆，該組後面的序號會跟著移位，那幾筆會被誤報成「消失＋新增」。
0.19% 的量級可以接受，但報告裡要標出來，不要假裝沒有。

⚠ 這也是為什麼識別碼**不含**罰鍰、備註、法條敘述：
  那些欄位會被更新（訴願結果就是），含進去的話「內容變更」會變成
  「舊的消失了、新的出現了」，正好把最有價值的訊號丟掉。
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import shutil
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from common import use_utf8_stdout

from crawler.constants import LAW_CODES, LAWS, UNIT_CODES, UNITS
from crawler.mol import crawl, read_rows, write_coverage

RAW = Path("data/raw")
RAW_NEW = Path("data/raw_new")
RAW_PREV = Path("data/raw_prev")
SNAP_DIR = Path("data/snapshots")
OUT_DIR = Path("data/refresh")
LOG_PATH = Path("data/refresh_log.csv")

# ⚠⚠ **欄位不是固定的。** 下載回來的 CSV 有四種欄位佈局，
#    差別在後半段（職安法多三個災害欄位、勞退是「處分金額／滯納金」、
#    有些法規連罰鍰欄都沒有）。實測 300 個檔案：
#
#      13 欄（＋災害三欄）   職業安全衛生法          13 檔
#      10 欄（罰鍰金額）     勞基法、性平法…          有
#      10 欄（處分金額／滯納金）勞退、勞職災保        有
#       9 欄（連罰鍰都沒有） 就業服務法…             有
#      （另有 166 個檔是查無資料的空檔）
#
#    所以**罰鍰與備註一律用欄位名稱去找，不可以寫死位置**。
#    寫死 12 當備註的話，10 欄的勞退每一列都會被當成「欄位不足」丟掉 ——
#    實測就是這樣少掉 55 萬筆，而且程式不會報錯，只會安靜地少。
#
#    前 8 欄（編號～法條敘述）在四種佈局裡完全一致，所以那幾個可以寫死，
#    但還是會在 _columns() 裡驗一次名稱，改版時要吵。
C_SEQ, C_UNIT, C_ANNOUNCED, C_EMPLOYER = 0, 1, 2, 3
C_DISP_DATE, C_DOC_NO, C_LAW_ART, C_LAW_TEXT = 4, 5, 6, 7

HEAD8 = ("編號", "縣市／單位別", "公告日期", "事業單位名稱(負責人)自然人姓名",
         "處分日期", "處分字號", "違反法規條款", "法條敘述")
FINE_NAMES = ("罰鍰金額", "處分金額／滯納金")
NOTE_NAME = "備註"

# 識別碼用的欄位。⚠ 不含罰鍰／備註／法條敘述 —— 那些是「會被更新的內容」。
IDENT_COLS = (C_DOC_NO, C_EMPLOYER, C_DISP_DATE, C_LAW_ART)

# 一組（單位×法規）縮水超過這個比例就當成可疑
SHRINK_ALERT = 0.02      # 2%
SHRINK_MIN_ROWS = 5      # 少於 5 筆的變動不值得叫（小組別本來就會抖）


def _clean(name: str) -> str:
    """欄位名裡真的有換行字元（「事業單位名稱(負責人)\n自然人姓名」）。"""
    return name.replace("\n", "").replace("\r", "").strip()


def _columns(header: list[str], where: str) -> tuple[int, int | None, int]:
    """回傳 (備註欄位置, 罰鍰欄位置或 None, 內容欄位的結束位置)。

    ⚠ 前 8 欄的名稱對不上就直接吵。那代表網站改版了，
      這時候安靜地繼續跑會產生一份「全部都變了」的假報告。
    """
    names = [_clean(c) for c in header]
    got = tuple(names[:8])
    if got != HEAD8:
        raise RuntimeError(
            f"{where} 的欄位名稱跟預期不符，網站可能改版了。\n"
            f"      預期前 8 欄：{HEAD8}\n"
            f"      實際前 8 欄：{got}"
        )
    if NOTE_NAME not in names:
        raise RuntimeError(f"{where} 找不到「{NOTE_NAME}」欄：{names}")
    note = names.index(NOTE_NAME)
    fine = next((names.index(n) for n in FINE_NAMES if n in names), None)
    return note, fine, len(names)


def _h(*parts: str) -> str:
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class Row:
    key: str        # 識別碼（含組內序號）
    digest: str     # 內容雜湊
    unit_code: str
    law_code: str
    doc_no: str
    employer: str
    announced: str
    note: str       # 備註（訴願狀態住在這裡）
    fine: str


def read_dir(d: Path) -> dict[str, Row]:
    """把一個 raw 目錄讀成 {key: Row}。"""
    out: dict[str, Row] = {}
    for path in sorted(d.glob("*.csv")):
        stem = path.stem
        if "_" not in stem:
            print(f"  跳過看不懂的檔名：{path.name}", file=sys.stderr)
            continue
        unit_code, law_code = stem.split("_", 1)
        header, data = read_rows(path.read_bytes())
        if not header:
            continue          # 查無資料的空檔，正常
        note_i, fine_i, end = _columns(header, path.name)
        seen: Counter[str] = Counter()
        for r in data:
            base = _h(unit_code, law_code, *(r[i].strip() for i in IDENT_COLS))
            n = seen[base]
            seen[base] = n + 1
            key = f"{base}:{n}"
            out[key] = Row(
                key=key,
                # ⚠ 內容雜湊 = 第 1 欄到最後一個**標題欄**為止。
                #   起點是 1 不是 0：第 0 欄「編號」是流水號，含進去的話
                #   新增一筆就會讓它後面每一筆都被報成「內容變更」。
                #   終點用 end 不用 len(r)：資料列尾端多一個空欄。
                digest=_h(*(c.strip() for c in r[1:end])),
                unit_code=unit_code,
                law_code=law_code,
                doc_no=r[C_DOC_NO].strip(),
                employer=r[C_EMPLOYER].strip(),
                announced=r[C_ANNOUNCED].strip(),
                note=r[note_i].strip() if note_i < len(r) else "",
                fine=r[fine_i].strip() if fine_i is not None and fine_i < len(r) else "",
            )
    return out


# ─────────────────────────── 快照 ───────────────────────────

SNAP_FIELDS = ["key", "digest", "unit_code", "law_code"]


def write_snapshot(rows: dict[str, Row], day: str) -> Path:
    """歷史索引。⚠ **只存 key 與 digest，不存公司名。**

    兩個理由：一是大小（63 萬筆，存了公司名就是幾十 MB 一份），
    二是這份檔案的用途只是「幾個月後回答：那天這筆公告在不在」，
    要看細節的時候去比 data/raw_prev 與 data/raw_new，那邊本來就有。
    """
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    path = SNAP_DIR / f"{day}.csv.gz"
    with gzip.open(path, "wt", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(SNAP_FIELDS)
        for r in rows.values():
            w.writerow([r.key, r.digest, r.unit_code, r.law_code])
    return path


# ─────────────────────────── 比對 ───────────────────────────


@dataclass
class Diff:
    added: list[Row]
    removed: list[Row]
    changed: list[tuple[Row, Row]]     # (舊, 新)
    unchanged: int


def diff(old: dict[str, Row], new: dict[str, Row]) -> Diff:
    added = [new[k] for k in new.keys() - old.keys()]
    removed = [old[k] for k in old.keys() - new.keys()]
    changed, same = [], 0
    for k in old.keys() & new.keys():
        if old[k].digest != new[k].digest:
            changed.append((old[k], new[k]))
        else:
            same += 1
    added.sort(key=lambda r: (r.announced, r.doc_no))
    removed.sort(key=lambda r: (r.announced, r.doc_no))
    changed.sort(key=lambda p: (p[1].announced, p[1].doc_no))
    return Diff(added, removed, changed, same)


def appeal_changes(changed: list[tuple[Row, Row]]) -> list[tuple[Row, Row]]:
    """備註欄變了的那些。訴願狀態住在備註欄，這是最有價值的一類變更。"""
    return [(a, b) for a, b in changed if a.note != b.note]


def group_counts(rows: dict[str, Row]) -> Counter[tuple[str, str]]:
    c: Counter[tuple[str, str]] = Counter()
    for r in rows.values():
        c[(r.unit_code, r.law_code)] += 1
    return c


@dataclass
class Shrink:
    unit_code: str
    law_code: str
    before: int
    after: int

    @property
    def lost(self) -> int:
        return self.before - self.after

    @property
    def pct(self) -> float:
        return self.lost / self.before * 100 if self.before else 0.0


def suspicious(old: dict[str, Row], new: dict[str, Row]) -> list[Shrink]:
    """⚠ 哪幾組縮水了。程式分不出「真的下架」與「這次抓壞了」，所以一律報出來。"""
    a, b = group_counts(old), group_counts(new)
    out = []
    for g in a.keys() | b.keys():
        before, after = a.get(g, 0), b.get(g, 0)
        lost = before - after
        if lost >= SHRINK_MIN_ROWS and before and lost / before >= SHRINK_ALERT:
            out.append(Shrink(g[0], g[1], before, after))
    out.sort(key=lambda s: -s.lost)
    return out


# ─────────────────────────── 報告 ───────────────────────────

_UNIT_NAME = {v: k for k, v in UNIT_CODES.items()}
_LAW_NAME = {v: k for k, v in LAW_CODES.items()}


def _name(unit_code: str, law_code: str) -> str:
    return (f"{_UNIT_NAME.get(unit_code, unit_code)} × "
            f"{_LAW_NAME.get(law_code, law_code)}")


def write_report(d: Diff, shrinks: list[Shrink], day: str,
                 n_old: int, n_new: int) -> Path:
    """⚠ 報告裡有真實公司名與真實人名，所以寫在 data/refresh/ 底下（.gitignore 全擋）。
    只有不含姓名的 data/refresh_log.csv 會進 git。"""
    out = OUT_DIR / day
    out.mkdir(parents=True, exist_ok=True)

    appeals = appeal_changes(d.changed)
    lines: list[str] = []
    A = lines.append
    A(f"# 資料更新報告 {day}\n")
    A(f"- 上一輪 **{n_old:,}** 筆 → 這一輪 **{n_new:,}** 筆"
      f"（{n_new - n_old:+,}）")
    A(f"- 新增 **{len(d.added):,}**　消失 **{len(d.removed):,}**　"
      f"內容變更 **{len(d.changed):,}**　沒動 {d.unchanged:,}")
    A(f"- 其中**備註欄（訴願狀態）變更 {len(appeals):,} 筆**\n")

    if shrinks:
        A("## ⚠ 這幾組筆數變少了，先確認是真的下架還是這次抓壞了\n")
        A("| 單位 × 法規 | 上一輪 | 這一輪 | 少了 | 比例 |")
        A("|---|---:|---:|---:|---:|")
        for s in shrinks:
            A(f"| {_name(s.unit_code, s.law_code)} | {s.before:,} | "
              f"{s.after:,} | {s.lost:,} | {s.pct:.1f}% |")
        A("\n確認過是真的下架，再用 `--promote --accept-shrink`。"
          "**不要因為程式叫你就直接加參數。**\n")
    else:
        A("## 沒有任何一組筆數異常縮水\n")

    if appeals:
        A("## 備註欄變更（訴願狀態）\n")
        A("| 公告日期 | 事業單位 | 處分字號 | 舊 | 新 |")
        A("|---|---|---|---|---|")
        for a, b in appeals[:200]:
            A(f"| {b.announced} | {b.employer} | {b.doc_no} | "
              f"{a.note or '（空）'} | {b.note or '（空）'} |")
        if len(appeals) > 200:
            A(f"\n…另外 {len(appeals) - 200:,} 筆見 changes.csv\n")

    if d.removed:
        A("\n## 消失的公告（前 50 筆）\n")
        A("| 公告日期 | 事業單位 | 處分字號 | 單位 × 法規 |")
        A("|---|---|---|---|")
        for r in d.removed[:50]:
            A(f"| {r.announced} | {r.employer} | {r.doc_no} | "
              f"{_name(r.unit_code, r.law_code)} |")

    A("\n---\n")
    A("⚠ 識別碼用「處分字號＋事業單位＋處分日期＋違反法規條款＋組內序號」組成。"
      "來源有極少數完全重複的列（實測 0.19%），那些列的序號會因為組內增減而移位，"
      "可能被誤報成一筆消失、一筆新增。看到成對出現的同一家公司請以此為優先解釋。")

    path = out / "report.md"
    path.write_text("\n".join(lines), encoding="utf-8")

    # 明細
    with (out / "changes.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["kind", "unit_code", "law_code", "announced",
                    "employer", "doc_no", "old_note", "new_note",
                    "old_fine", "new_fine"])
        for r in d.added:
            w.writerow(["新增", r.unit_code, r.law_code, r.announced,
                        r.employer, r.doc_no, "", r.note, "", r.fine])
        for r in d.removed:
            w.writerow(["消失", r.unit_code, r.law_code, r.announced,
                        r.employer, r.doc_no, r.note, "", r.fine, ""])
        for a, b in d.changed:
            w.writerow(["變更", b.unit_code, b.law_code, b.announced,
                        b.employer, b.doc_no, a.note, b.note, a.fine, b.fine])
    return path


def append_log(day: str, n_old: int, n_new: int, d: Diff,
               shrinks: list[Shrink]) -> None:
    """⚠ 這張表**只有數字，沒有任何公司名或人名**，所以可以進 git。
    它就是「這個系統持續在追資料」的證據，簡報要放。"""
    new = not LOG_PATH.exists()
    with LOG_PATH.open("a", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["date", "rows_before", "rows_after", "added",
                        "removed", "changed", "appeal_changed",
                        "shrinking_groups"])
        w.writerow([day, n_old, n_new, len(d.added), len(d.removed),
                    len(d.changed), len(appeal_changes(d.changed)),
                    len(shrinks)])


# ─────────────────────────── promote ───────────────────────────


def promote(accept_shrink: bool, shrinks: list[Shrink]) -> int:
    if shrinks and not accept_shrink:
        print("有縮水的組別，不換。看過 report.md 確認是真的下架之後，"
              "再加 --accept-shrink。", file=sys.stderr)
        return 1
    if not RAW_NEW.exists():
        print(f"沒有 {RAW_NEW}，沒有東西可以換。", file=sys.stderr)
        return 1
    # ⚠ 舊的先留著。換錯了要救得回來。
    if RAW_PREV.exists():
        shutil.rmtree(RAW_PREV)
    if RAW.exists():
        RAW.rename(RAW_PREV)
    RAW_NEW.rename(RAW)
    print(f"已換上新資料。舊的留在 {RAW_PREV}（下一次 refresh 會蓋掉）。")
    print("接下來要重跑管線：pipeline.build → parse → join → publish")
    return 0


# ─────────────────────────── 主流程 ───────────────────────────


def main(argv: list[str] | None = None) -> int:
    use_utf8_stdout()
    p = argparse.ArgumentParser(description="重抓一輪並跟上一輪比對")
    p.add_argument("--baseline", action="store_true",
                   help="只把現在的 data/raw 存成基準快照，不抓任何東西")
    p.add_argument("--diff-only", action="store_true",
                   help="不重抓，直接比 data/raw 與 data/raw_new")
    p.add_argument("--promote", action="store_true",
                   help="把 data/raw_new 換成 data/raw（舊的移到 data/raw_prev）")
    p.add_argument("--accept-shrink", action="store_true",
                   help="⚠ 已經人工確認縮水是真的下架，才加這個")
    p.add_argument("--unit", action="append", choices=UNITS)
    p.add_argument("--law", action="append", choices=LAWS)
    p.add_argument("--delay", type=float, default=2.0)
    a = p.parse_args(argv)

    day = date.today().isoformat()

    if a.baseline:
        if not RAW.exists():
            print(f"沒有 {RAW}，先跑 python -m crawler.mol", file=sys.stderr)
            return 1
        print(f"讀 {RAW} …")
        rows = read_dir(RAW)
        path = write_snapshot(rows, day)
        print(f"基準快照 {len(rows):,} 筆 → {path} "
              f"（{path.stat().st_size / 1e6:.1f} MB）")
        return 0

    if not a.diff_only and not a.promote:
        units = a.unit or UNITS
        laws = a.law or LAWS
        n = len(units) * len(laws)
        print(f"重抓 {n} 組到 {RAW_NEW}（**不會動到 {RAW}**），"
              f"大約 {n * (a.delay + 2) / 60:.0f} 分鐘\n")
        # ⚠ force=True：重抓的意義就是要新的。不 force 會全部「已有檔案，跳過」。
        cov = crawl(units, laws, force=True, delay=a.delay, dest=RAW_NEW)
        write_coverage(cov)
        got = len(cov)
        if got < n:
            print(f"\n⚠ 只成功 {got}/{n} 組。**不要 promote** —— "
                  f"缺的那幾組會被當成「整組消失」。", file=sys.stderr)

    if not RAW_NEW.exists():
        print(f"沒有 {RAW_NEW}。", file=sys.stderr)
        return 1

    print(f"\n讀 {RAW} …")
    old = read_dir(RAW)
    print(f"讀 {RAW_NEW} …")
    new = read_dir(RAW_NEW)

    d = diff(old, new)
    shrinks = suspicious(old, new)

    if a.promote:
        return promote(a.accept_shrink, shrinks)

    path = write_report(d, shrinks, day, len(old), len(new))
    append_log(day, len(old), len(new), d, shrinks)
    write_snapshot(new, day)

    print(f"\n上一輪 {len(old):,} → 這一輪 {len(new):,}（{len(new) - len(old):+,}）")
    print(f"新增 {len(d.added):,}　消失 {len(d.removed):,}　"
          f"內容變更 {len(d.changed):,}"
          f"（其中訴願狀態 {len(appeal_changes(d.changed)):,}）")
    if shrinks:
        print(f"\n⚠ {len(shrinks)} 組筆數變少，**先看報告**再決定要不要 promote：")
        for s in shrinks[:10]:
            print(f"    {_name(s.unit_code, s.law_code)}　"
                  f"{s.before:,} → {s.after:,}（少 {s.lost:,}，{s.pct:.1f}%）")
    print(f"\n報告：{path}")
    print(f"明細：{path.parent / 'changes.csv'}")
    print("確認沒問題之後：python -m pipeline.refresh --promote")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
