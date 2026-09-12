"""違法情節嚴重度分級 —— 這是整個系統唯一用到語言模型的地方。

    set ANTHROPIC_API_KEY=...            （自己設，不要寫進檔案）
    python -m pipeline.severity_llm --in data/severity_review.csv
    python -m pipeline.severity_llm --top 2000        # 產線用：跑最常見的描述

────────────────────────────────────────────────────────────────
為什麼這一格需要模型
────────────────────────────────────────────────────────────────
現在的嚴重度是 `pipeline/export.py` 的 `severity_of()`，判準是**罰鍰級距**
（≥30 萬重大、≥5 萬中度）。問題是罰鍰欄位有 **78.6% 是空的**，
那些全部掉進「輕微」—— 一筆「未設護欄致勞工墜落死亡」只要沒填金額，
系統就說它輕微。而且它毫不猶豫。

同樣違反勞基法第 24 條，「未給付加班費」和「積欠工資三個月」差很多，
但法條號一模一樣。**只有讀懂那段文字才分得出來**，那是規則做不到的事，
也是這個專案唯一該用模型的地方。

────────────────────────────────────────────────────────────────
⚠ 送出去的東西只有違規描述，沒有任何人名或公司名
────────────────────────────────────────────────────────────────
prompt 只放三個欄位：違反法規、法規法條、違反內容。
公司名、負責人姓名、統一編號、處分字號、罰鍰金額**一律不送**。

  · 判斷嚴重度本來就不需要知道是哪一家公司 —— 需要的話那就是偏見。
  · 罰鍰不送是刻意的：系統目前的嚴重度就是從罰鍰推的，
    把金額給模型看，量到的是「模型會不會套用我們自己的門檻」，
    那是同義反覆。人工標註也是照同一條規則設計的。

這不只是隱私考量，是**方法上的必要**。

────────────────────────────────────────────────────────────────
信心等級：不確定就交給人
────────────────────────────────────────────────────────────────
模型每一筆都要給一個信心等級，產品規則是：

    高  → 直接採用
    中  → 送人工複核
    低  → 送人工複核（通常是描述本身資訊不足）

**「不確定就說不確定」比「每一筆都硬給答案」是更好的產品。**
這也符合專案的架構原則：AI 負責理解，判定的責任留給可稽核的流程。
評估的時候要分開看「高信心那一格的準確率」和「送人工的比例」——
一個把全部標成「中」的模型準確率會很好看，但它什麼忙都沒幫上。

────────────────────────────────────────────────────────────────
快取
────────────────────────────────────────────────────────────────
職安法 74,658 筆只有 34,651 種相異描述，最常見的 2,000 種就覆蓋 54.2%。
所以照**描述文字**做快取（不是照紀錄），重跑與擴大規模都很便宜。
快取檔在 data/，不進 git。
"""
from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                     # noqa: E402

RECORDS = Path("data/records.csv")
CACHE = Path("data/severity_llm_cache.json")
DEFAULT_OUT = Path("data/severity_llm.csv")

# ⚠ 換模型會讓結果變動。文件裡要寫出實際用的是哪一個，不要只寫「用了 AI」。
DEFAULT_MODEL = "claude-sonnet-4-5"

LEVELS = ("輕微", "中度", "重大", "無法判斷")
CONFIDENCE = ("高", "中", "低")

# ⚠ 這段判準跟《嚴重度標註判準.pdf》是**同一份**。人跟模型要用同一把尺，
#   不然量到的是「兩份判準的差異」而不是「模型準不準」。
#   改這裡就要同步改 PDF，反之亦然。
RUBRIC = """你在為台灣的勞動法令裁處公告判斷「違法情節嚴重度」。

# 四個等級

- 重大：危及人身安全，或長期／大規模侵害
- 中度：勞工權益有實質損失，但沒有立即危險
- 輕微：程序或紀錄問題，沒有人受到實質損害
- 無法判斷：描述沒有指明是哪一種危害，看不出嚴重度

# 職業安全衛生法的判準

## 重大
（甲）描述中已經發生職業災害 —— 出現「死亡」「罹災」「發生職業災害」「住院」等字樣。
（乙）缺的是直接防止立即致命危害的措施，而且勞工已經在那個環境作業：
  - 高度二公尺以上未設護欄、護蓋、安全網，或未使用安全帶、母索
  - 局限空間未測氧氣／硫化氫濃度、未通風換氣、未設監視人員
  - 感電：活線作業未斷電、電氣設備未接地、未設漏電斷路器、帶電部分未設護圍或絕緣
  - 倒塌崩塌：模板支撐、擋土支撐、開挖、隧道未依規定辦理
  - 危險性機械或設備未經檢查合格即使用

## 中度
防護不足，但危害通常不是立即致命；或屬於個人防護具與設備防護層級：
  - 未提供或未使正確戴用安全帽
  - 機械的轉軸、齒輪、傳動帶未設護罩、護圍
  - 暴露鋼筋未彎曲尖端／加蓋／加裝護套；物料堆置不當、有飛落之虞
  - 通道、地板、階梯、坡道未保持不致跌倒滑倒的安全狀態
  - 機械掃除、上油、修理未停止運轉、未上鎖標示
  - 已經發生災害但未於八小時內通報 —— 罰的是通報義務，不是災害本身

## 輕微
管理、訓練、文件義務，沒有直接的物理危害：
  - 未實施安全衛生教育訓練；未僱用具合格證照的作業主管或操作人員
  - 未設安全衛生管理單位／人員、未訂定管理計畫、未實施自動檢查
  - 未辦理體格檢查、健康檢查、臨場健康服務
  - 未備置文件、未公告、未報備、未訂定工作守則

## 無法判斷
「未符合規定之必要安全衛生設備及措施」「未依規定辦理」
「未妥為規劃及採取必要之安全衛生措施」這類沒有指明危害型態的描述。

# 勞動基準法與其他法規

- 重大：積欠工資（尤其達數個月）、違法解僱、強制勞動、使童工從事危險工作、
        性騷擾或職場霸凌未依規定處理、長期或大規模的權益侵害
- 中度：未給付延長工時工資、超時工作、未給例假或休息日、拒絕特休或生理假、
        未依規定提繳勞工退休金（有實際金錢損失）
- 輕微：出勤紀錄未記載到分鐘、未置備勞工名卡、未公告工作規則、
        未按時繳納致加徵滯納金（已補繳、勞工權益未受損）

# 三條原則

一、你看不到罰鍰金額，也不要去猜。金額受法條上限影響，同樣嚴重的事在
    不同法條下可以差十倍。只看描述說了什麼。
二、判斷兩件事：有沒有人真的受害，以及這項防護缺失會不會立刻致命。
三、一筆描述裡有多項違規時，取最嚴重的那一項，不要平均。

# 容易判錯的地方

- 出現「死亡」不等於重大。先看是「致發生死亡災害」還是「未通報死亡災害」。
  前者重大，後者中度 —— 後者罰的是通報義務。
- 「未提供安全帽」是中度不是重大。安全帽是個人防護具，缺了會讓傷害變嚴重，
  但它本身不是「讓人掉下去」的原因。
- **承攬管理**（未設協議組織、未巡視工作場所、未採取承攬管理必要措施）：
  描述同時提到具體危害時，跟著那個危害標；**只寫了管理義務本身就標「輕微」**，
  不要標「無法判斷」。那句話已經指明了違反的是哪一項義務，只是沒說後果。
- **「無法判斷」只留給看不出違反了什麼義務的描述**（例如「未符合規定之必要
  安全衛生設備及措施」「未依規定辦理」這種法條原文照抄）。
  只要描述指明了具體的義務或行為，就照那項義務的性質分級 ——
  「沒有寫出後果」不等於「無法判斷」。
- 描述裡出現**「情節重大」「致發生職業災害」「罹災」**等字樣時，
  那是來源機關自己的判斷，要往上調一級，不要忽略。
- **勞工已經身處危險環境**（在快速道路上作業、在未防護的高處、在運轉中的
  機械旁）而防護缺失時，即使描述沒寫「已發生災害」也算重大 ——
  判準（乙）看的是暴露，不是後果。
- 高差 1.5 公尺以上未設安全上下設備：屬於墜落家族，但未達二公尺的門檻，
  單獨出現時標中度；與二公尺以上的墜落防護缺失並列時，跟著標重大。

# 信心等級

⚠ 這一格實測失敗過一次：模型把 98% 的案例標成「高」，而高信心那一格的
準確率（86.2%）跟整體（85.1%）一樣 —— 等於模型認不出自己哪裡會錯，
「送人工複核」這個機制完全沒有作用。

所以請嚴格照下面判斷，**「高」是需要理由的，不是預設值**：

- 高：描述**逐字對得上**上面某一條具體判準（例如明確寫了「二公尺以上未設
  護欄」「已發生死亡災害」「未提供安全帽」），不需要推論就能歸類。
- 中：**只要符合下列任何一項就給中**，不要給高 ——
    · 描述同時涉及多個危害，而它們分屬不同等級
    · 你用了「屬於…層級」「通常不…」這類推論才得出結論
    · 判準沒有直接涵蓋這種情形，你是用類比套過去的
    · 你在兩個相鄰等級之間猶豫過
- 低：描述過於籠統、只是法條原文照抄，或資訊不足。

給「中」或「低」不是失敗，那些會送人工複核，**那正是這個欄位存在的目的**。
硬給一個「高」然後判錯，比誠實地說不確定糟糕得多 ——
因為高信心的結果會被直接採用，沒有人會再看一眼。

# 輸出

只輸出一個 JSON 物件，不要有其他文字、不要用 markdown 圍籬：
{"level": "重大|中度|輕微|無法判斷", "confidence": "高|中|低", "reason": "一句話，說明這一筆的具體原因，不要複製等級定義"}"""


def rubric_version() -> str:
    """判準的指紋。

    ⚠ 這裡踩過一次坑：快取的鍵原本只算「法規＋法條＋描述」，沒有算判準。
      改了 RUBRIC 之後重跑，舊結果還是從快取拿出來用 ——
      **改了等於沒改，而且畫面上看不出來**。
      把判準算進鍵值，判準一動舊快取自動失效。
    """
    return hashlib.sha1(RUBRIC.encode("utf-8")).hexdigest()[:8]


def key_of(law: str, article: str, violation: str) -> str:
    raw = f"{rubric_version()}\x1f{law}\x1f{article}\x1f{violation}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def load_cache() -> dict:
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"⚠ {CACHE} 壞了，這次重新開始", file=sys.stderr)
    return {}


def save_cache(cache: dict) -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=0),
                     encoding="utf-8")


def grade_one(client, model: str, law: str, article: str, violation: str) -> dict:
    """問一筆。回傳 {level, confidence, reason}。

    ⚠ 這裡送出去的**只有這三個欄位**。呼叫端不准把公司名、負責人姓名、
      統一編號、處分字號或罰鍰塞進來 —— 見檔頭說明。
    """
    user = (f"違反法規：{law}\n"
            f"法規法條：{article}\n"
            f"違反內容：{violation}")
    msg = client.messages.create(
        model=model,
        max_tokens=300,
        system=RUBRIC,
        messages=[{"role": "user", "content": user}],
    )
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```")
    out = json.loads(text)
    if out.get("level") not in LEVELS:
        raise ValueError(f"level 不在允許的四個值裡：{out.get('level')!r}")
    if out.get("confidence") not in CONFIDENCE:
        raise ValueError(f"confidence 不在允許的三個值裡：{out.get('confidence')!r}")
    return {"level": out["level"], "confidence": out["confidence"],
            "reason": str(out.get("reason", ""))[:200]}


def rows_from_review(path: Path) -> list[dict]:
    """從標註檔讀。⚠ 判斷欄（如果有值）**不讀進來** —— 不能讓模型看到答案。"""
    out = []
    with path.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if (r.get("編號") or "").strip():
                out.append({"id": r["編號"],
                            "law": r.get("違反法規", ""),
                            "article": r.get("法規法條", ""),
                            "violation": r.get("違反內容", "")})
    return out


def rows_from_records(top: int) -> list[dict]:
    """產線用：取最常見的 N 種**相異描述**，不是前 N 筆紀錄。"""
    counter: collections.Counter = collections.Counter()
    sample: dict[tuple, dict] = {}
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            v = (r.get("violation") or "").strip()
            if not v:
                continue
            k = (r.get("law", ""), r.get("law_article", ""), v)
            counter[k] += 1
            sample.setdefault(k, {"law": k[0], "article": k[1], "violation": k[2]})
    out = []
    for i, (k, n) in enumerate(counter.most_common(top), 1):
        d = dict(sample[k]); d["id"] = f"R{i:05d}"; d["n"] = n
        out.append(d)
    return out


def main(argv=None) -> int:
    use_utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", type=Path,
                    help="標註檔（含 編號/違反法規/法規法條/違反內容）")
    ap.add_argument("--top", type=int,
                    help="改從 records.csv 取最常見的 N 種相異描述")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--delay", type=float, default=0.2, help="每次呼叫之間的間隔（秒）")
    a = ap.parse_args(argv)

    if not a.src and not a.top:
        print("要給 --in 或 --top 其中一個", file=sys.stderr)
        return 1
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("沒有 ANTHROPIC_API_KEY。\n"
              "  Windows:  set ANTHROPIC_API_KEY=你的金鑰\n"
              "⚠ 金鑰不要寫進任何檔案，也不要貼進對話。", file=sys.stderr)
        return 1
    try:
        import anthropic
    except ModuleNotFoundError:
        print("要先裝：pip install anthropic", file=sys.stderr)
        return 1

    # 會讓整輪都跑不動的錯誤，一出現就停。
    FATAL_ERRORS = tuple(
        getattr(anthropic, n) for n in
        ("AuthenticationError", "PermissionDeniedError", "NotFoundError")
        if hasattr(anthropic, n)
    ) or ()

    rows = rows_from_review(a.src) if a.src else rows_from_records(a.top)
    cache = load_cache()
    client = anthropic.Anthropic()

    results, hit, new, fail = [], 0, 0, 0
    t0 = time.time()
    for i, r in enumerate(rows, 1):
        k = key_of(r["law"], r["article"], r["violation"])
        if k in cache:
            res = cache[k]; hit += 1
        else:
            try:
                res = grade_one(client, a.model, r["law"], r["article"], r["violation"])
                cache[k] = res
                new += 1
                time.sleep(a.delay)
            except FATAL_ERRORS as e:                   # noqa: BLE001
                # ⚠ 認證／權限／額度不足**不是單筆的問題**，是整輪都跑不動。
                #   第一版把它們當成一般失敗，結果金鑰打錯時硬跑了 150 次
                #   註定失敗的呼叫，還在螢幕上刷了 150 行一模一樣的錯誤。
                #   這種錯誤要立刻停，並且把原因講清楚。
                print(f"\n✗ 停止：{type(e).__name__}\n   {e}\n\n"
                      f"這不是單筆的問題，整輪都會失敗，所以不繼續了。\n"
                      f"已經問到的結果都存進快取了，修好之後重跑會接著做。\n",
                      file=sys.stderr)
                save_cache(cache)
                return 1
            except Exception as e:                      # noqa: BLE001
                # 暫時性的（逾時、限流、單筆回傳格式壞掉）才記成失敗並繼續。
                print(f"  ✗ {r['id']}：{type(e).__name__} {e}", file=sys.stderr)
                res = {"level": "無法判斷", "confidence": "低",
                       "reason": f"模型呼叫失敗：{type(e).__name__}"}
                fail += 1
            if new and new % 25 == 0:
                save_cache(cache)
        results.append({**r, **res})
        if i % 25 == 0 or i == len(rows):
            print(f"  {i}/{len(rows)}　快取命中 {hit}　新問 {new}　失敗 {fail}")
    save_cache(cache)

    a.out.parent.mkdir(parents=True, exist_ok=True)
    cols = ["編號", "違反法規", "法規法條", "違反內容",
            "模型分級", "信心", "理由"] + (["出現筆數"] if a.top else [])
    with a.out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in results:
            row = [r["id"], r["law"], r["article"], r["violation"],
                   r["level"], r["confidence"], r["reason"]]
            if a.top:
                row.append(r.get("n", ""))
            w.writerow(row)

    lv = collections.Counter(r["level"] for r in results)
    cf = collections.Counter(r["confidence"] for r in results)
    n = len(results)
    print(f"\n{n} 筆 → {a.out}　（{time.time() - t0:.0f} 秒）")
    print("\n  分級      " + "　".join(f"{k} {lv.get(k, 0)}" for k in LEVELS))
    print("  信心      " + "　".join(f"{k} {cf.get(k, 0)}" for k in CONFIDENCE))
    review = cf.get("中", 0) + cf.get("低", 0)
    print(f"\n  可直接採用（高信心）　{cf.get('高', 0):>5}　{100 * cf.get('高', 0) / n:.1f}%")
    print(f"  送人工複核（中／低）　{review:>5}　{100 * review / n:.1f}%")
    if a.top:
        cover = sum(r.get("n", 0) for r in results)
        print(f"\n  這 {n} 種描述覆蓋 {cover:,} 筆紀錄")
    print("""
⚠ 這份**還沒有被驗證**。要知道模型準不準，拿它跟人工標準答案比：
     python -m tools.severity_eval data/severity_llm.csv 人工標註檔.csv

   評估時一定要分開看「高信心那一格的準確率」和「送人工的比例」——
   一個把全部標成「中」的模型準確率會很好看，但它什麼忙都沒幫上。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
