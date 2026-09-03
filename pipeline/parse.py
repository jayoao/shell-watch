"""解析「事業單位名稱(負責人)／自然人姓名」這個合併欄位。

────────────────────────────────────────────────────────────────
2026-09-02 用職安署（CA）全部 43,437 筆真實資料跑過。分布：
────────────────────────────────────────────────────────────────

    公司(負責人)         19,533 筆  44.97%   七福營造有限公司(官建昌)
    只有機構名           19,389 筆  44.64%   脇酩安全工程有限公司
    某某即某商號          2,734 筆   6.29%   王宇傑即衍寶企業社
    自然人雇主            1,015 筆   2.34%   方信和
    ─────────────────────────────────────
    以上四種                        98.24%
    其餘 765 筆（1.76%）是下面這些邊角，這支程式一條一條處理過。

**一開始只寫了「公司(負責人)」那一條 regex，成功率 37%，看起來像資料很髒。
  其實不是 —— 剩下的 60% 是另外三種格式，而且都拆得開。**

而且對「換殼追蹤」來說，「即」字與自然人雇主這兩種**反而最有價值**：
獨資商號與自然人雇主本來就是最容易換個名字重新登記的一群。
把它們當解析失敗丟掉，等於把最該追的對象丟掉。

────────────────────────────────────────────────────────────────
真實邊角（全部來自實際資料，tests/fixtures/hard_employers.txt）
────────────────────────────────────────────────────────────────
  多層括號   台灣電力股份有限公司(台南區營業處)(曾文生)   分支機構＋負責人
  重複       蕭廣義(自然人)(蕭廣義)                    同一個人寫兩次
  合夥       明台鋼製傢俱行(合夥負責人劉素珍)
  法人代表   大陸工程股份有限公司(欣陸投資控股股份有限公司(法定代理人:殷琪))
  法人股東   聲寶股份有限公司(財團法人陳茂榜工商發展基金會)  ← 括號內不是人
  反過來寫   郭哲男(奕冠企業社)、廖淑美(福長76號漁船)     ← 人在前、機構在後
  書名號     寗志雄〈即建維工程行〉、洪義翔〈自然人〉
  造字括號   永(金歷)營造股份有限公司、鼎(金勇)機電股份有限公司
  罕用字     蔡振𥪕、阮𥡪葶、朱家㯋、徐已𦍻（Unicode 增補平面）
  原住民名   阿汎思．狄翁、日卡．比洛、梅根.浮士德
  外國人名   CHEN HAO、Dr. Andreas Klaus Oswald Raps、Ｐｈｕａｎ Ｌｉｎｇ
  中外並列   呂敏志LOOI MIIN TZE、Mahinder Kumar Wadhwa 馬行德
  日式空格   田村 隆幸、吳 健、深井亨 FUKAI TORU
  去識別化   吳OO(自然人)
  漁船       漁滿昌86號、忠豐基2號、金宏發122號
  被截斷     夏都國際開發股份有限公、新生代消防工程有限公 司
  多人       郭富山及曾麗花等2人、陳晏誠等5人、王正富、吳耀崑等二人
  資料錯置   職業安全衛生法第27條第1項  ← 法條跑到雇主欄

**不要用語言模型做這件事** —— regex 夠、可驗證、免費、可重現。
語言模型只用在「違法情節嚴重度分級」那一個地方。
拆不出來的不要硬猜，丟到 unparsed 清單交給人工標註（任務 T3）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

Kind = Literal[
    "company_with_principal",  # 公司(負責人)
    "sole_prop",               # 某某即某商號 / 郭哲男(奕冠企業社)
    "natural_person",          # 自然人雇主
    "company_only",            # 只有機構名，或括號內是法人股東
    "unparsed",
]

# ── 字元類 ──────────────────────────────────────────────────
# 中文字要含增補平面。真實資料裡有 蔡振𥪕(U+25A55)、阮𥡪葶、朱家㯋、徐已𦍻，
# 只寫 [一-鿿] 會把這些人整個丟掉。
_HAN = r"㐀-䶿一-鿿豈-﫿\U00020000-\U0003ffff"
_NAME_SEP = r"·‧・．\."          # 原住民姓名的分隔點
_ZERO_WIDTH = re.compile(r"[​-‏  ﻿]")

# 台灣的中文姓名幾乎都是 2–4 字。放到 5 字會把「外省牛肉麵」「醇品咖啡屋」
# 這種店名收進來。5 字以上的原住民姓名走 _HAN_NAME_SEP（有分隔點）。
_HAN_NAME = re.compile(rf"^[{_HAN}]{{2,4}}$")
_HAN_NAME_SEP = re.compile(rf"^[{_HAN}]{{1,6}}[{_NAME_SEP}][{_HAN}]{{1,6}}$")
_LATIN_NAME = re.compile(r"^[A-Za-z][A-Za-z .'’\-]{1,60}$")
_REDACTED = re.compile(rf"^[{_HAN}]{{1,3}}[Oo○〇]{{1,3}}$")   # 吳OO

# 機構字尾。實測補齊的，尤其是「土木包工業」與各種公所、學校、分署。
_ORG_TAIL = (
    "公司|企業社|企業行|工程行|工程社|工程|工作室|工作所|事務所|商行|商號|商店|"
    "土木包工業|包工業|實業社|加工所|製材廠|鐵工廠|工場|工廠|廠|企業|"
    "銀行|農會|漁會|合作社|診所|醫院|療養院|護理之家|養護之家|衛生所|漁船|"
    "藥局|農場|牧場|漁場|林場|飯店|旅館|餐廳|餐飲業|火鍋店|甜品|檳榔|"
    "補習班|幼兒園|國民小學|國民中學|小學|國中|高中|中學|學校|大學|學院|"
    # 書院／學堂：四個字又剛好以姓氏開頭時（例如「康明書院」），
    # 沒有這個字尾就會被判成人名。假名化 fixture 時撞出來的真漏洞。
    # ⚠ 只加實際撞到的三個。一開始順手加了「宮|寺|廟|教堂」，
    #   結果把日籍姓名「◯◯ ◯宮」判成機構 —— 沒有證據就不要加字尾。
    "書院|學堂|私塾|"
    "研究所|研究院|試驗所|繁殖場|分裝場|屠宰場|加油站|營業所|服務所|事業處|"
    "集散站|貨櫃場|清潔隊|稽查大隊|工程隊|服務中心|中心|"
    "公所|區公所|分署|分局|分所|分院|分場|分店|分公司|辦事處|"
    "協會|公會|工會|基金會|管理委員會|委員會|電臺|電台|城堡|園藝造景|"
    "處|局|署|部|會|社|行|店|坊|舖|鋪|館|苑|園|隊|站|所"
)
_ORG_SUFFIX = re.compile(rf"({_ORG_TAIL})$")

# 括號裡不是人、而是機構屬性或分支的字樣。
# 「臺北市私立三園老人長期照顧中心(養護型)」的「養護型」是照顧型態，
# 不查這個的話會變成一位叫「養護型」的負責人，而且因為它在全台
# 出現幾十次，還會被當成「同一人名下 13 家公司」的重大發現。實測踩過。
_NOT_A_NAME = re.compile(
    r"(分公司|營業所|辦事處|工廠|廠|分店|籌備處|工作站|服務所|事業處|"
    r"型|部|課|組|隊|站|場|所|處|中心)$")

# 名稱中段就看得出是機構的（分公司、營業所之類接在後面）
_ORG_INSIDE = re.compile(
    r"(股份有限公司|有限公司|國民小學|國民中學|榮民總醫院|附設醫院|"
    r"鄉公所|鎮公所|市公所|區公所|土木包工業|管理局|研究院|研究所|"
    r"財團法人|社團法人|醫院|大學|學校|教會)"
)
# 被截斷：「…有限公」「…股份有限公」。不要當成解析失敗，但要標出來。
_TRUNCATED_ORG = re.compile(r"(有限公|股份有限|企業股份有限公)$")
# 漁船：漁滿昌86號、忠豐基2號、金宏發122號
_VESSEL = re.compile(rf"^[{_HAN}]{{2,6}}\d+號(漁船)?$")
# 工程標案名稱跑到雇主欄
_PROJECT = re.compile(r"(工程|標案|勞務|採購|案)$")
# 法條跑到雇主欄
_LAW_TEXT = re.compile(r"法第\s*\d+\s*條")


# ── 姓氏表 ────────────────────────────────────────────────────
# 中文姓氏是一個封閉集合。沒有這張表，程式沒辦法判斷一串沒有括號的字
# 到底是人名還是店名：「外省牛肉麵」「轉角鍋物」「街口飯糰」「醇品咖啡屋」
# 都是 3–5 個中文字、都不以「公司」結尾，長得跟人名一模一樣。
#
# 實測後果：`外省牛肉麵(陳木元)` 被判成「負責人=外省牛肉麵」的自然人雇主，
# 真正的負責人陳木元被丟掉，而一個不存在的「人」進了關聯圖。
# 真實資料裡這樣的「姓氏」有 813 種（只出現 1–2 次），全部是這種噪音。
#
# ⚠ 這張表只用在**沒有括號**的情況。括號裡的內容位置本身就說明它是負責人，
#   那裡不查姓氏表 —— 否則 奥田実、伏見茂男（日籍）、禤惠儀（罕見漢姓）
#   這些真的負責人會被誤殺。
SURNAMES = set(
    "趙錢孫李周吳鄭王馮陳褚衛蔣沈韓楊朱秦尤許何呂施張孔曹嚴華金魏陶姜"
    "戚謝鄒喻柏水竇章雲蘇潘葛奚范彭郎魯韋昌馬苗鳳花方俞任袁柳酆鮑史唐"
    "費廉岑薛雷賀倪湯滕殷羅畢郝鄔安常樂于時傅皮卞齊康伍余元卜顧孟平黃"
    "和穆蕭尹姚邵湛汪祁毛禹狄米貝明臧計伏成戴談宋茅龐熊紀舒屈項祝董梁"
    "杜阮藍閔席季麻強賈路婁危江童顏郭梅盛林刁鍾徐邱駱高夏蔡田樊胡凌霍"
    "虞萬支柯昝管盧莫經房裘繆干解應宗丁宣賁鄧郁單杭洪包諸左石崔吉鈕龔"
    "程嵇邢滑裴陸榮翁荀羊於惠甄麴家封芮羿儲靳汲邴糜松井段富巫烏焦巴弓"
    "牧隗山谷車侯宓蓬全郗班仰秋仲伊宮寧仇欒暴甘鈄厲戎祖武符劉景詹束龍"
    "葉幸司韶郜黎薊薄印宿白懷蒲邰從鄂索咸籍賴卓藺屠蒙池喬陰鬱胥能蒼雙"
    "聞莘黨翟譚貢勞逄姬申扶堵冉宰酈雍卻璩桑桂濮牛壽通邊扈燕冀郟浦尚農"
    "溫別莊晏柴瞿閻充慕連茹習宦艾魚容向古易慎戈廖庾終暨居衡步都耿滿弘"
    "匡國文寇廣祿闕東歐殳沃利蔚越夔隆師鞏厙聶晁勾敖融冷訾辛闞那簡饒空"
    "曾毋沙乜養鞠須豐巢關蒯相查后荊紅游竺權逯蓋益桓公仉督岳帥緱亢況郈"
    "有琴牟商牫佴伯賞墨哈譙笪年愛陽佟"
    "巫馬淳于單于太叔申屠公孫仲孫軒轅令狐鍾離宇文長孫慕容鮮于閭丘司徒"
    "司空亓官司寇仉督子車顓孫端木巫馬公西漆雕樂正壤駟公良拓跋夾谷宰父"
    "穀梁晉楚閆法汝鄢涂欽段干百里東郭南門呼延歸海羊舌微生梁丘左丘東門"
    "西門南宮第五"
) | set("田卜倪么邸寗甯寧游閰閻凃涂粘藍卲卲翁")

# 括號內的角色標記
_MARKER_ONLY = re.compile(r"^(自然人|負責人|雇主|合夥|為合夥人)$")
_PARTNER = re.compile(r"^(?:合夥)?負責人\s*[:：]?\s*(?P<name>.+)$")
_LEGAL_REP = re.compile(r"^.*法定代理人\s*[:：]?\s*(?P<name>[^()（）]+)\)?$")

# 括號裡是**外國法人**，不是自然人：
#   明鏡有限公司(薩摩亞商)
#   鋐博生技股份有限公司(薩摩亞商 KST INVESTMENT LTD.)
# 「薩摩亞商」是三個中文字、不以「公司」結尾，會被當成一個叫這個名字的人。
# 它在全台出現很多次，於是變成「同一人名下多家公司」的假訊號。實測踩過。
_FOREIGN_ENTITY = re.compile(
    r"^(薩摩亞|香港|日|美|英|法|德|韓|新加坡|開曼群島|英屬維京群島|貝里斯|"
    r"荷|瑞士|瑞典|丹麥|挪威|馬來西亞|泰|越南|菲律賓|印尼|義|西班牙|"
    r"加拿大|澳|紐西蘭|巴拿馬|盧森堡|愛爾蘭|以色列|印度|中國大陸)商")
# 外文的公司字尾。⚠ 不要把外籍負責人的姓名誤殺 ——
# 「Vilhelm Robert Wessman」「David James Webster」必須留著，
# 所以這裡只列公司型態字，不列一般英文字。
_LATIN_CORP = re.compile(
    r"\b(LTD|LIMITED|INC|INCORPORATED|CORP|CORPORATION|LLC|LLP|PLC|"
    r"GMBH|PTE|PTY)\b\.?", re.I)
# 「正暉土木包工業合夥負責人林玉玲」—— 沒有括號的合夥寫法
_PARTNER_INLINE = re.compile(r"^(?P<org>.+?)合夥負責人\s*[:：]?\s*(?P<name>.+)$")
# 「自然人姚志屏」「自營作業者周孟諺」
_PERSON_PREFIX = re.compile(r"^(自然人|自營作業者)\s*(?P<name>.+)$")
# 「某某即某商號」。原住民姓名較長，放寬到 8 字。
_JI = re.compile(r"^(?P<principal>[^即]{2,8})即(?P<company>.+)$")
# 多人：郭富山及曾麗花等2人、陳晏誠等5人、王正富、吳耀崑等二人
_MULTI = re.compile(r"(等\s*[0-9一二三四五六七八九十]+\s*人$|[、,，]|及)")


@dataclass
class Parsed:
    raw: str
    company: str | None
    principal: str | None
    kind: Kind
    ok: bool
    reason: str = ""
    note: str = ""          # 拆得開、但有值得知道的事（截斷、外國名、去識別化）


# ── 小工具 ──────────────────────────────────────────────────


def normalize(raw: str) -> str:
    s = _ZERO_WIDTH.sub("", raw or "")
    s = s.replace("〈", "(").replace("〉", ")")     # 書名號當括號用的
    s = s.replace("（", "(").replace("）", ")")
    s = re.sub(r"\s+", " ", s).strip()
    # 「輝鷹企業股份有限公司〈」這種結尾多一個括號的，砍掉比留著好
    if s.endswith("(") and s.count("(") > s.count(")"):
        s = s[:-1].strip()
    return s


def _is_org(s: str) -> bool:
    t = s.replace(" ", "")
    return bool(
        _ORG_SUFFIX.search(t) or _ORG_INSIDE.search(t)
        or _TRUNCATED_ORG.search(t) or _VESSEL.match(t)
    )


def _clean_person(s: str) -> tuple[str | None, str]:
    """把括號裡那一坨整理成人名。回傳 (人名 or None, 註記)。"""
    t = s.strip().strip("。，,;；")
    if not t:
        return None, ""
    # 「Jared David Wiener 中譯：魏傑瑞」→ 取中譯
    m = re.search(rf"中譯\s*[:：]\s*([{_HAN}]{{2,5}})", t)
    if m:
        return m.group(1), "原文為外國姓名"
    # 中外並列：呂敏志LOOI MIIN TZE / Nitin Dhawan尼廷 / 深井亨 FUKAI TORU
    han = re.findall(rf"[{_HAN}]+", t)
    latin = re.findall(r"[A-Za-z][A-Za-z .'’\-]*", t)
    if han and latin:
        joined = "".join(han)
        if _HAN_NAME.match(joined):
            return joined, "原文中外並列"
    if han and not latin:
        joined = "".join(han) if " " in t else t   # 田村 隆幸 → 田村隆幸
        if _HAN_NAME.match(joined):
            return joined, "" if joined == t else "原文姓名中有空格"
        if _HAN_NAME_SEP.match(t):
            return t, ""
    if _HAN_NAME.match(t) or _HAN_NAME_SEP.match(t):
        return t, ""
    if _REDACTED.match(t):
        return t, "來源已去識別化"
    if _LATIN_NAME.match(t):
        return t, "外國姓名"
    # 全形英數：Ｐｈｕａｎ Ｌｉｎｇ Ｆｏｎｇ
    if re.fullmatch(r"[Ａ-ｚ０-９ .'\-]+", t):
        return t, "全形英文姓名"
    return None, ""


def _looks_like_person(s: str, *, require_surname: bool = False) -> bool:
    """像不像人名。

    require_surname=True 用在**沒有括號**的情況 —— 那時只有姓氏表能
    分辨「陳木元」與「外省牛肉麵」。括號裡的內容不查姓氏表，因為位置
    本身已經說明它是負責人（日籍、罕見漢姓的負責人才不會被誤殺）。
    """
    if _is_org(s):
        return False
    name = _clean_person(s)[0]
    if name is None:
        return False
    if require_surname:
        # 原住民姓名（阿汎思．狄翁）沒有漢姓，用分隔點辨識，不查姓氏表
        if _HAN_NAME_SEP.match(name):
            return True
        return name[:2] in COMPOUND_SURNAMES_LOCAL or name[:1] in SURNAMES
    return True


COMPOUND_SURNAMES_LOCAL = {"歐陽", "司馬", "諸葛", "上官", "皇甫", "尉遲",
                           "范姜", "張簡", "張廖", "澹臺", "令狐", "慕容",
                           "宇文", "長孫", "司徒", "夏侯", "東方", "獨孤"}


def _peel(s: str) -> tuple[str, list[str]]:
    """從字串尾端一層一層剝括號。

        台灣電力股份有限公司(台南區營業處)(曾文生)
            → ("台灣電力股份有限公司", ["台南區營業處", "曾文生"])
        花王(台灣)股份有限公司(胡英錦)
            → ("花王(台灣)股份有限公司", ["胡英錦"])   ← 中段括號不會被剝掉
    """
    groups: list[str] = []
    while s.endswith(")"):
        depth = 0
        for i in range(len(s) - 1, -1, -1):
            if s[i] == ")":
                depth += 1
            elif s[i] == "(":
                depth -= 1
                if depth == 0:
                    groups.insert(0, s[i + 1:-1].strip())
                    s = s[:i].strip()
                    break
        else:
            break                      # 括號沒配對，不要無限迴圈
    return s, groups


# ── 主函式 ──────────────────────────────────────────────────


def parse_employer(raw: str) -> Parsed:
    s = normalize(raw)
    if not s:
        return Parsed(raw, None, None, "unparsed", False, "空值")

    if _LAW_TEXT.search(s):
        return Parsed(raw, None, None, "unparsed", False, "欄位內容是法條，不是雇主名稱")

    # 「黃竹億(自然人)黃竹億」：中段的角色標記先拿掉，拿掉後常常前後重複
    m = re.match(r"^(?P<a>.+?)\((自然人|負責人|雇主)\)(?P<b>.+)$", s)
    if m and m.group("a").strip() == m.group("b").strip():
        s = m.group("a").strip()

    head, groups = _peel(s)

    # 括號沒配對：不要猜（「合水…有限公司(潘書鴻」「崧富…(林其霖))」）
    if head.count("(") != head.count(")"):
        return Parsed(raw, None, None, "unparsed", False, "括號沒有配對，需人工確認")

    # 多人共同雇主：交人工，不要自己挑一個
    if _MULTI.search(head) and not _is_org(head):
        return Parsed(raw, None, None, "unparsed", False, f"多名雇主：{head}")

    # 「自然人姚志屏」「自營作業者周孟諺」
    pm = _PERSON_PREFIX.match(head)
    if pm:
        name, note = _clean_person(pm.group("name"))
        if name:
            return Parsed(raw, None, name, "natural_person", True, note=note)

    # 「正暉土木包工業合夥負責人林玉玲」（沒有括號的合夥寫法）
    pi = _PARTNER_INLINE.match(head)
    if pi and _is_org(pi.group("org")):
        name, note = _clean_person(pi.group("name"))
        if name:
            return Parsed(raw, pi.group("org").strip(), name,
                          "company_with_principal", True, note=note)

    # 「某某即某商號」
    principal_from_head = None
    company_from_head = head
    jm = _JI.match(head)
    if (jm and _looks_like_person(jm.group("principal"), require_surname=True)
            and jm.group("company").strip()):
        principal_from_head = jm.group("principal").strip()
        company_from_head = jm.group("company").strip()

    # 括號從後往前找負責人
    principal, note = None, ""
    leftover_org = None
    for g in reversed(groups):
        if not g or _MARKER_ONLY.match(g):
            continue
        lr = _LEGAL_REP.match(g)
        if lr:
            principal, note = _clean_person(lr.group("name"))
            if principal:
                break
        pt = _PARTNER.match(g)
        if pt:
            principal, note = _clean_person(pt.group("name"))
            if principal:
                break
        g = re.sub(r"^即\s*", "", g)      # 〈即建維工程行〉
        if _FOREIGN_ENTITY.match(g) or _LATIN_CORP.search(g):
            # 外國法人負責人（薩摩亞商 KST INVESTMENT LTD.）—— 不是自然人。
            # 「薩摩亞商」三個中文字、不以公司結尾，不擋的話會變成
            # 一個叫這個名字的「人」，而且全台出現很多次 → 假的跨公司關聯。
            leftover_org = leftover_org or g
            continue
        if _NOT_A_NAME.search(g):
            # 「…老人長期照顧中心(養護型)」的「養護型」是機構屬性，不是人
            leftover_org = leftover_org or None
            continue
        if _is_org(g):
            # 分支機構、法人股東、工程標案 —— 都不是自然人負責人
            leftover_org = leftover_org or g
            continue
        cand, cnote = _clean_person(g)
        if cand:
            principal, note = cand, cnote
            break

    if principal_from_head and not principal:
        principal = principal_from_head
    if principal_from_head:
        # 「阿汎思．狄翁即廣竑工程行(阿汎思．狄翁)」括號只是重複
        return Parsed(raw, company_from_head, principal_from_head,
                      "sole_prop", True, note=note)

    head_is_org = _is_org(head)
    # ⚠ 這裡一定要查姓氏表。head 是「沒有括號的那一段」，
    #   「外省牛肉麵」「轉角鍋物」「街口飯糰」都是 3–5 個中文字、
    #   不以「公司」結尾，長得跟人名一模一樣。不查姓氏表的話，
    #   `外省牛肉麵(陳木元)` 會被判成「負責人=外省牛肉麵」的自然人雇主 ——
    #   真正的負責人被丟掉，而一個不存在的人進了關聯圖。實測踩過。
    head_is_person = (not head_is_org) and _looks_like_person(
        head, require_surname=True)

    if head_is_org:
        company = head
        n = note
        if _TRUNCATED_ORG.search(head.replace(" ", "")):
            n = (n + "；" if n else "") + "名稱疑似被截斷"
        if principal:
            return Parsed(raw, company, principal, "company_with_principal", True, note=n)
        return Parsed(raw, company, None, "company_only", True, note=n)

    if head_is_person:
        hp, hnote = _clean_person(head)
        # 「郭哲男(奕冠企業社)」「廖淑美(福長76號漁船)」人在前、機構在後
        if leftover_org:
            return Parsed(raw, leftover_org, hp, "sole_prop", True, note=hnote)
        # 「蕭廣義(自然人)(蕭廣義)」「簡孝羽(自然人)」
        if principal is None or principal == hp:
            return Parsed(raw, None, hp, "natural_person", True, note=hnote or note)
        return Parsed(raw, None, hp, "natural_person", True,
                      note=(hnote or "") + f"；括號內另有姓名 {principal}")

    if principal:
        return Parsed(raw, head or None, principal, "company_with_principal", True, note=note)

    if _PROJECT.search(head):
        return Parsed(raw, head, None, "company_only", True, note="名稱像工程標案，非公司名")

    # 到這裡表示：沒有括號、不以機構字尾結尾、第一個字也不是姓氏。
    # 實際上多半是店名（總舖師、醇品咖啡屋、忠豐基2號）。
    # **一律當機構處理**，不要當人名 —— 兩種錯的代價不一樣：
    #   多一個機構名 = 一筆紀錄的事業單位欄位怪怪的，沒有後果；
    #   多一個「人」 = 憑空長出一個節點，會產生假的跨公司關聯。
    return Parsed(raw, head, None, "company_only", True,
                  note="無法判定是機構或人名，以機構處理，不進負責人關聯")


def parse_many(rows: list[str]) -> tuple[list[Parsed], list[Parsed]]:
    """回傳 (拆得開的, 拆不開的)。拆不開的寫成 unparsed.csv 交人工標註。"""
    out = [parse_employer(r) for r in rows]
    return [p for p in out if p.ok], [p for p in out if not p.ok]
