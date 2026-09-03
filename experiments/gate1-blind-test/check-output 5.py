#!/usr/bin/env python3
"""機械檢查 Grok 的盲測輸出（一次性實驗，非產品程式）。

檢查的是**格式與自洽**，不是挖空品質——品質只有 William 的紅筆能評。
這支存在的理由：同構性與數量比例可以算，能算的就不要用眼睛看，
不然「S 版偷偷改寫了 T 版一句話」這種錯會靜靜地過關。

用法：python3 experiments/gate1-blind-test/check-output.py [run/grok-output.md]
"""
import difflib
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BLANK = re.compile(r"【(\d+)】[＿_]{1,}")
PAGE = re.compile(r"-{2,}\s*第\s*(\d+)\s*頁\s*-{2,}")


def norm(s):
    s = s.replace("　", " ")
    s = re.sub(r"[ \t]+", " ", s)
    return "\n".join(line.strip() for line in s.splitlines()).strip()


def split_parts(text):
    parts, cur, buf = {}, None, []
    for line in text.splitlines():
        m = re.match(r"^#{1,4}\s*Part\s+([A-E])\b", line.strip(), re.I)
        if m:
            if cur:
                parts[cur] = "\n".join(buf)
            cur, buf = m.group(1).upper(), []
        elif cur:
            buf.append(line)
    if cur:
        parts[cur] = "\n".join(buf)
    return parts


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "run" / "grok-output.md"
    if not src.exists():
        sys.exit(f"✗ 找不到 {src}。把 Grok 的整份輸出存成這個檔再跑。")

    parts = split_parts(src.read_text(encoding="utf-8"))
    out, fail = [], 0

    def ok(msg):
        out.append(f"✓ {msg}")

    def bad(msg):
        nonlocal fail
        fail += 1
        out.append(f"✗ {msg}")

    missing = [p for p in "ABCDE" if p not in parts]
    if missing:
        bad(f"缺少 Part {'、'.join(missing)}（提示詞要求五部分齊全）")
    if "A" not in parts or "B" not in parts:
        print("\n".join(out) + "\n\n無 T/S 版，無法繼續。")
        sys.exit(1)

    T, S = norm(parts["A"]), norm(parts["B"])

    # 1. 分頁點一致
    tp, sp = PAGE.findall(T), PAGE.findall(S)
    if tp == sp and tp:
        ok(f"分頁點一致：{len(tp)} 頁（{'、'.join(tp)}）")
    elif not tp:
        bad("T 版找不到 `--- 第 n 頁 ---` 分頁點（提示詞硬性規定 3）")
    else:
        bad(f"分頁點不一致：T={tp} vs S={sp}")

    # 2. 編號連號、不重號
    nums = [int(n) for n, in [(m.group(1),) for m in BLANK.finditer(S)]]
    if not nums:
        bad("S 版找不到任何 `【n】＿＿＿` 形式的挖空")
    else:
        dupes = {n for n in nums if nums.count(n) > 1}
        expect = list(range(1, len(nums) + 1))
        if dupes:
            bad(f"挖空編號重複：{sorted(dupes)}")
        elif nums != expect:
            bad(f"挖空編號沒連號：實際 {nums[:12]}… 應為 1–{len(nums)}")
        else:
            ok(f"挖空編號連號無重複：共 {len(nums)} 個")

    # 3. 同構：把 S 的每個空當成萬用字元，去比對 T。
    #    比對成功 = S 除了挖掉的地方，逐字元等於 T；順便把每個空的原文撈回來。
    recovered = {}
    pieces, last = [], 0
    for m in BLANK.finditer(S):
        pieces.append(re.escape(S[last:m.start()]))
        pieces.append(r"(.*?)")
        last = m.end()
    pieces.append(re.escape(S[last:]))
    hit = re.fullmatch("".join(pieces), T, re.S) if nums else None
    if hit:
        ok("同構通過：S 版除挖空處外與 T 版逐字元相同")
        recovered = list(zip(nums, hit.groups()))
        empties = [n for n, g in recovered if not g.strip()]
        if empties:
            bad(f"這些空在 T 版對應到空字串（挖了個寂寞）：{empties}")
        # 同構比對的已知弱點：萬用字元會把「S 版整段刪掉」也吞進某個空裡，
        # 於是漏字看起來像挖空。撈回來的原文異常大就是這個徵兆，要人眼確認。
        swallowed = [n for n, g in recovered if PAGE.search(g)]
        if swallowed:
            bad(f"這些空吃掉了分頁點，S 版八成漏了一整段：{swallowed}")
        fat = [(n, len(g)) for n, g in recovered
               if "\n" in g.strip() or len(g) > 200]
        for n, ln in fat:
            out.append(f"⚠ 【{n}】撈回 {ln} 字且跨行——可能是真的挖一整段，"
                       f"也可能是 S 版漏字被當成挖空。這一個要人眼看。")
    elif nums:
        bad("同構失敗：S 版在挖空以外的地方跟 T 版不一樣（改寫／漏行／多行）")
        skeleton = BLANK.sub("", S)
        diff = [d for d in difflib.unified_diff(
            norm(BLANK.sub("", T)).splitlines(), norm(skeleton).splitlines(),
            "T版", "S版（拿掉挖空標記）", n=1, lineterm="")][:24]
        out.extend("    " + d for d in diff)

    # 4. 數量與比例（Part D 是 Grok 自稱的，這裡是實測的）
    if recovered:
        blank_chars = sum(len(g) for _, g in recovered)
        body_chars = len(re.sub(r"\s", "", PAGE.sub("", T)))
        out.append("")
        out.append(f"實測：挖空 {len(nums)} 個／T 版正文 {body_chars} 字"
                   f"／挖掉 {blank_chars} 字（{blank_chars / max(body_chars, 1):.1%}）")
        if tp:
            per = []
            for i, seg in enumerate(PAGE.split(S)[2::2] or [S]):
                per.append(f"第{tp[i] if i < len(tp) else i + 1}頁 {len(BLANK.findall(seg))}")
            out.append("每頁挖空數：" + "、".join(per))

    # 5. 挖空清單列數要對得上
    if "C" in parts:
        rows = [r for r in parts["C"].splitlines()
                if r.strip().startswith("|") and not re.match(r"^\|[\s\-:|]+\|$", r.strip())]
        rows = [r for r in rows if not re.search(r"編號.*原文", r)]
        if nums and len(rows) != len(nums):
            bad(f"Part C 挖空清單 {len(rows)} 列，對不上 S 版的 {len(nums)} 個空")
        elif nums:
            ok(f"Part C 清單列數對得上（{len(rows)} 列）")

    report = "\n".join(out)
    print(report)
    print("\n" + ("— 機械檢查全過，可以送 William 紅筆。" if not fail
                  else f"— {fail} 項不合格。格式沒過就退回重做，不要拿去佔用 William 的紅筆時間。"))
    (HERE / "run").mkdir(exist_ok=True)
    (HERE / "run" / "check-report.md").write_text(
        f"# 機械檢查報告\n\n來源：`{src}`\n\n```\n{report}\n```\n", encoding="utf-8")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
