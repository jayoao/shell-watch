/**
 * 查詢頁 —— 產品的主畫面。主線負責，不是隊友的檔案。
 *
 * ══════════════════════════════════════════════════════════════
 * 這一頁的設計受紅線約束，不是純粹的 UI 決定
 * ══════════════════════════════════════════════════════════════
 *
 * 系統處理真實公司與真實人名，誤判是實質的名譽損害。所以：
 *
 *  1. **證據強度不能單獨出現。** 一個「0.75」會被當成「75% 是同一人」。
 *     每一個數字旁邊一定要有證據清單，而且清單要用完整句子。
 *
 *  2. **不下結論。** 畫面上不會出現「這家公司有風險」。
 *     只呈現「這個負責人的姓名，也出現在這些公司的公開裁處紀錄上」。
 *
 *  3. **每一筆裁處都要能查回官方公告。** 勞動部沒有單筆永久連結，
 *     所以顯示處分字號 + 查詢系統連結，讓使用者自己查得到。
 *
 *  4. **姓名相同不等於同一人**這句話要放在顯眼的地方，不是註腳。
 *
 *  5. **危害型態是規則歸類的，不是模型判的**，而且「未指明」不等於「沒有危害」。
 *     死亡災害的措辭是「本筆公告涉及死亡災害」——
 *     不能寫成「造成死亡」，因為有些是罰未依規定通報。
 */
import { useMemo, useState } from "react";
import type { LookupResult, LinkedCompany, ViolationRef } from "../types/contracts";
import sample from "../data/lookup.sample.json";

const DATA = sample as unknown as { generated_at: string; note: string; results: LookupResult[] };

const SEVERITY_COLOR: Record<string, string> = {
  輕微: "var(--sev-low)",
  中度: "var(--sev-mid)",
  重大: "var(--sev-high)",
};

/** 證據強度 → 文字描述。**數字一定要配文字**，不然會被讀成機率。 */
function strengthLabel(c: number): string {
  if (c >= 0.9) return "多項獨立佐證";
  if (c >= 0.7) return "兩項獨立佐證";
  if (c >= 0.5) return "一項獨立佐證";
  return "僅姓名相同";
}

function money(n: number): string {
  return n > 0 ? `${n.toLocaleString("zh-TW")} 元` : "未公告金額";
}

/** 這一筆是不是還在爭議中（訴願／行政救濟尚未確定）。 */
function isPending(v: ViolationRef): boolean {
  return !!v.appeal && v.appeal.includes("尚未確定");
}

/** 危害型態的小標籤。⚠ 只是「公告文字被歸到這一類」，不是災害調查結論。 */
function HazardChip({ name, onClick, active }: {
  name: string; onClick?: () => void; active?: boolean;
}) {
  return (
    <span
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}
      style={{
        display: "inline-block",
        fontSize: 12,
        lineHeight: 1.6,
        borderRadius: 20,
        padding: "1px 10px",
        marginRight: 6,
        marginTop: 4,
        cursor: onClick ? "pointer" : "default",
        background: active ? "var(--accent-soft)" : "var(--surface-2)",
        color: active ? "var(--on-accent-soft)" : "var(--ink-2)",
        border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
        fontWeight: active ? 600 : 400,
      }}
    >
      {name}
    </span>
  );
}

function Violation({ v }: { v: ViolationRef }) {
  const pending = isPending(v);
  return (
    <li style={{ marginBottom: 10, lineHeight: 1.6 }}>
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 4,
          background: SEVERITY_COLOR[v.severity] ?? "var(--ink-3)",
          marginRight: 8,
        }}
      />
      <b>{v.date}</b>{"　"}{v.law}
      {/* ⚠ 措辭固定：「涉及」不是「造成」。
          有些公告罰的是「未於八小時內通報死亡災害」，
          寫成「造成死亡」就是把通報違規講成殺人。 */}
      {v.fatal && (
        <span
          style={{
            marginLeft: 8,
            fontSize: 12,
            fontWeight: 700,
            background: "var(--sev-high)",
            color: "#fff",
            borderRadius: 20,
            padding: "1px 9px",
          }}
        >
          涉及死亡災害
        </span>
      )}
      {/* 爭議中的案子要在最顯眼的位置標出來 —— 這是紅線不是體貼。
          原處分還沒確定，把它跟已確定的案子混在一起呈現，
          對被列的公司不公平，對使用者也是誤導。 */}
      {pending && (
        <span
          style={{
            marginLeft: 8,
            fontSize: 12,
            fontWeight: 600,
            background: "var(--warn-soft)",
            color: "var(--on-warn-soft)",
            border: "1px solid var(--warn)",
            borderRadius: 20,
            padding: "1px 9px",
          }}
        >
          尚未確定
        </span>
      )}
      <div style={{ color: "var(--ink-2)", fontSize: 13, marginLeft: 16 }}>
        {v.content}
        {v.hazards && v.hazards.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {v.hazards.map((h) => (
              <HazardChip key={h.code} name={h.name} />
            ))}
          </div>
        )}
        <div style={{ marginTop: 2 }}>
          罰鍰 {money(v.fine)}
          {v.appeal ? `\u3000${v.appeal}` : ""}
          {"　"}
          <a href={v.source_url} target="_blank" rel="noreferrer">
            官方公告查詢
          </a>
        </div>
        {pending && (
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--ink-3)" }}>
            本案的行政救濟程序尚未終結，原處分是否維持仍待確定。
          </div>
        )}
      </div>
    </li>
  );
}

function Linked({ c }: { c: LinkedCompany }) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 10,
        padding: "14px 16px",
        marginBottom: 12,
        background: "var(--surface-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 15 }}>{c.name}</b>
        <span className="sw-muted" style={{ fontSize: 13 }}>
          {c.status || "登記狀態不明"}
          {c.established ? `\u3000設立 ${c.established}` : ""}
        </span>
      </div>

      {/* 數字與文字一起出現，不能只有數字 */}
      <div style={{ margin: "8px 0 6px", fontSize: 13 }}>
        <span
          style={{
            background: "var(--accent-soft)",
            color: "var(--on-accent-soft)",
            borderRadius: 20,
            padding: "2px 10px",
            fontWeight: 600,
          }}
        >
          證據強度 {c.confidence.toFixed(2)}{"　"}{strengthLabel(c.confidence)}
        </span>
      </div>

      <ul style={{ margin: "6px 0 10px", paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
        {c.evidence.map((e, i) => (
          <li key={i} style={{ color: e.kind === "same_name" ? "var(--ink-3)" : "var(--ink-2)" }}>
            {e.detail}
          </li>
        ))}
      </ul>

      {c.violations.length > 0 && (
        <>
          <div className="sw-muted" style={{ fontSize: 12, marginBottom: 6 }}>
            這家公司的公開裁處紀錄（{c.violations.length} 筆）
          </div>
          <ul style={{ margin: 0, paddingLeft: 4, listStyle: "none", fontSize: 13 }}>
            {c.violations.slice(0, 5).map((v, i) => (
              <Violation key={i} v={v} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * 危害型態面板 —— 「視覺化防災」與「素養提升」就是這一塊。
 *
 * 「這家公司違反職業安全衛生法」對求職者沒有用；
 * 「這個負責人名下的公司被罰過 4 次墜落防護不足，而法規要求雇主在
 *  二公尺以上作業設置護欄或母索」才是可以拿去現場對照的資訊。
 *
 * ⚠ 三件事不能省：
 *   1. 各類加總會大於公告筆數（一筆可能同時屬於多類），不要拿它當分母。
 *   2. 沒有標籤的職安法公告是「公告文字未指明」，不是「沒有危害」。
 *   3. 法規義務那段文字是給人看的教育內容，不是對這家公司的認定。
 */
function HazardPanel({ hit }: { hit: LookupResult }) {
  const [open, setOpen] = useState<string | null>(null);
  const list = hit.summary.hazards ?? [];

  // duty 只掛在每一筆違規上，這裡把它收集起來當字典
  const duty = useMemo(() => {
    const m: Record<string, string> = {};
    const all = [
      ...hit.company.own_violations,
      ...hit.principals.flatMap((p) => p.linked_companies.flatMap((c) => c.violations)),
    ];
    for (const v of all) for (const h of v.hazards ?? []) m[h.code] = h.duty;
    return m;
  }, [hit]);

  if (list.length === 0) return null;
  const fatal = hit.summary.fatal_count ?? 0;

  return (
    <section
      style={{
        border: "1px solid var(--line)",
        borderRadius: 10,
        padding: "12px 14px",
        margin: "0 0 18px",
        background: "var(--surface-2)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>
        這些公司被罰過的職安危害型態
      </div>
      <p className="sw-muted" style={{ fontSize: 12, margin: "4px 0 2px", lineHeight: 1.7 }}>
        依公告文字的關鍵字歸類（規則比對，非模型判定）。
        一筆公告可能同時屬於多類，所以各類次數相加會大於公告筆數。
        點一下可以看法規要求雇主做什麼。
      </p>

      {fatal > 0 && (
        <p
          style={{
            fontSize: 13,
            lineHeight: 1.7,
            background: "var(--warn-soft)",
            color: "var(--on-warn-soft)",
            border: "1px solid var(--warn)",
            borderRadius: 8,
            padding: "8px 12px",
            margin: "8px 0 4px",
          }}
        >
          <b>其中 {fatal} 筆公告涉及死亡災害。</b>
          ⚠ 「涉及」指公告文字提到死亡災害，包含未依規定通報的情形，
          不等於該公司造成死亡。詳情請以處分字號查閱原始公告。
        </p>
      )}

      <div style={{ marginTop: 4 }}>
        {list.map((h) => (
          <HazardChip
            key={h.code}
            name={`${h.name}\u3000${h.count}`}
            active={open === h.code}
            onClick={() => setOpen(open === h.code ? null : h.code)}
          />
        ))}
      </div>

      {open && duty[open] && (
        <div
          style={{
            marginTop: 10,
            fontSize: 13,
            lineHeight: 1.8,
            borderLeft: "3px solid var(--accent)",
            paddingLeft: 12,
            color: "var(--ink-2)",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--ink)" }}>法規要求雇主做什麼</div>
          {duty[open]}
          <div className="sw-muted" style={{ fontSize: 12, marginTop: 4 }}>
            這是法規的一般性要求，不是對上述任何一家公司的認定。
          </div>
        </div>
      )}
    </section>
  );
}

export default function Home() {
  const [q, setQ] = useState("");

  const hit = useMemo<LookupResult | null>(() => {
    const t = q.trim();
    if (!t) return null;
    return (
      DATA.results.find((r) => r.query.includes(t) || r.company.name.includes(t)) ?? null
    );
  }, [q]);

  return (
    <div>
      <div className="sw-card">
        <h1 style={{ marginTop: 0, fontSize: 24 }}>求職安全雷達</h1>
        <p style={{ color: "var(--ink-2)", marginBottom: 14 }}>
          輸入一家公司，查它的負責人是否曾在其他公司留下違反勞動法令的公開紀錄。
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="輸入公司名稱"
          style={{
            width: "100%",
            padding: "10px 14px",
            fontSize: 15,
            borderRadius: 10,
            border: "1px solid var(--line-strong)",
            background: "var(--surface)",
            color: "var(--ink)",
          }}
        />
        <p className="sw-muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          目前是去識別化的展示資料（{DATA.results.length} 筆）。
          試著輸入「○」看看結果長什麼樣。
        </p>
      </div>

      {hit && (
        <div className="sw-card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 19 }}>{hit.company.name}</h2>
          <p className="sw-muted" style={{ marginTop: -6 }}>
            {hit.company.status || "登記狀態不明"}
            {hit.company.established ? `\u3000設立 ${hit.company.established}` : ""}
            {hit.company.address ? `\u3000${hit.company.address}` : ""}
          </p>

          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              margin: "12px 0 18px",
            }}
          >
            {[
              ["本身的裁處紀錄", hit.summary.own_violation_count],
              ["關聯公司的裁處紀錄", hit.summary.linked_violation_count],
              ["其中職安相關", hit.summary.linked_osha_count],
            ].map(([label, n]) => (
              <div
                key={label as string}
                style={{
                  flex: "1 1 140px",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: "var(--surface-2)",
                }}
              >
                <div className="sw-muted" style={{ fontSize: 12 }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{n as number}</div>
              </div>
            ))}
          </div>

          <HazardPanel hit={hit} />

          {hit.company.own_violations.length > 0 && (
            <>
              <h3 style={{ fontSize: 15 }}>這家公司自己的紀錄</h3>
              <ul style={{ paddingLeft: 4, listStyle: "none" }}>
                {hit.company.own_violations.map((v, i) => (
                  <Violation key={i} v={v} />
                ))}
              </ul>
            </>
          )}

          {hit.principals.map((p) => (
            <section key={p.name} style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 15, marginBottom: 4 }}>
                負責人 {p.name} 的姓名，也出現在這些公司的公開紀錄上
              </h3>
              {/* 這句話是紅線，不能拿掉也不能縮成註腳 */}
              <p
                style={{
                  fontSize: 13,
                  color: "var(--ink-2)",
                  background: "var(--warn-soft)",
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  margin: "0 0 12px",
                }}
              >
                <b>姓名相同不等於同一人。</b>
                公開資料沒有身分證字號，本系統不判定身分，
                只呈現「這個連結有多少獨立佐證」，判斷請自行進一步查證。
              </p>
              {p.linked_companies.map((c, i) => (
                <Linked key={i} c={c} />
              ))}
            </section>
          ))}

          <p className="sw-muted" style={{ marginTop: 18, fontSize: 12, lineHeight: 1.7 }}>
            資料來源：勞動部違反勞動法令事業單位（雇主）查詢系統、
            經濟部商工登記公示資料。本頁僅呈現主管機關已公告之裁處紀錄與其關聯，
            不對任何事業單位或個人作出評價或認定。
          </p>
        </div>
      )}

      {q.trim() && !hit && (
        <div className="sw-card" style={{ marginTop: 16 }}>
          <p style={{ margin: 0 }}>查無「{q.trim()}」。</p>
          <p className="sw-muted" style={{ marginBottom: 0 }}>
            查無紀錄<b>不代表這家公司沒有問題</b> ——
            可能是名稱寫法不同，也可能是該縣市的資料尚未公開。
            各縣市的資料保存期間差異很大。
          </p>
        </div>
      )}
    </div>
  );
}
