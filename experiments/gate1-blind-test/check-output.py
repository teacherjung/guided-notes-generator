#!/usr/bin/env python3
"""機械檢查執行者的輸出（一次性實驗，非產品程式）。

檢查的是**格式與自洽**，不是挖空品質——品質只有 William 的紅筆能評。
這支存在的理由：同構性與數量比例可以算，能算的就不要用眼睛看，
不然「S 版偷偷改寫了 T 版一句話」這種錯會靜靜地過關。

用法：python3 experiments/gate1-blind-test/check-output.py run/output-jia.md（甲乙各跑一次）
"""
import difflib
import re
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
BLANK = re.compile(r"【(\d+)】＿{2,}")          # 提示詞規定全形 ＿；至少兩個才算空
HALF = re.compile(r"【\d+】[＿_]*_[＿_]*")        # 混進半形 _ 的＝格式違規（Codex PR#2 r2）
PAGE = re.compile(r"^--- 第 (\d+) 頁 ---$", re.M)   # 提示詞要求精確形式（Codex PR#2 r4：寬鬆版放行 -- 第 9 頁 ----）


def norm(s):
    # 真正逐字元（r1 收縮排、r9 收行尾）：行尾空白也不剝——兩個尾隨空格在 Markdown 是
    # 硬換行語意，剝掉會讓「--- 第 1 頁 ---  」這種帶尾空白的標記被判精確、T/S 差異假綠。
    # 只做行尾符統一與首尾空行修剪。
    return s.replace("\r\n", "\n").replace("\r", "\n").strip("\n")


def declared_originals(part_c):
    """Part C 表格的「被挖掉的原文」欄，依編號取出。"""
    found = {}
    for row in part_c.splitlines():
        row = row.strip()
        if not row.startswith("|") or re.match(r"^\|[\s\-:|]+\|$", row):
            continue
        # 先照「未跳脫的 |」切欄、再還原 \\|（Codex PR#2 r3：先 split 再還原會把 $\\|x\\|$ 切碎）
        cells = [c.strip() for c in re.split(r"(?<!\\)\|", row.strip("|"))]
        if len(cells) >= 3 and cells[0].isdigit():
            n = int(cells[0])
            if n in found:
                found.setdefault("__dupes__", set()).add(n)   # 重複編號（Grok 掃 #19：後列覆蓋前列會靜默）
            found[n] = cells[2].replace("\\|", "|")
    return found


def same_text(recovered, declared):
    """精確相等，**不 strip**（r3：兩側 strip 讓「bar\\n」對上「bar」）。
    跨行原文（B2／B5 的整塊解答本來就是一個空）在 Part C 用 ⏎ 編碼換行（r7：一律禁換行
    會把正確的多行挖空全擋掉）——解碼後仍須逐字元相等，吞了多餘的行照樣不符。"""
    return recovered == declared.replace("⏎", "\n")


def split_parts(text):
    """回傳 (parts, 出現順序)。重複標題不覆蓋、保留順序，讓主程式能判重複與亂序
    （Codex PR#2 r2：dict 覆蓋＋只查 key 存在，空的 Part E 也算有）。"""
    parts, order, cur, buf = {}, [], None, []
    for line in text.splitlines():
        m = re.match(r"^#{1,4}\s*Part\s+([A-E])\b", line.strip(), re.I)
        if m:
            if cur:
                parts.setdefault(cur, []).append("\n".join(buf))
            cur, buf = m.group(1).upper(), []
            order.append(cur)
        elif cur:
            buf.append(line)
    if cur:
        parts.setdefault(cur, []).append("\n".join(buf))
    return {k: v[0] for k, v in parts.items()}, order


def main():
    if len(sys.argv) < 2:
        sys.exit("用法：check-output.py <輸出檔>（例：run/output-jia.md；甲乙各跑一次，報告檔依輸入檔命名）")
    src = Path(sys.argv[1])
    if not src.exists():
        sys.exit(f"✗ 找不到 {src}。把執行者的整份輸出存成這個檔再跑。")

    parts, order = split_parts(src.read_text(encoding="utf-8"))
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
    dupes = sorted({p for p in order if order.count(p) > 1})
    if dupes:
        bad(f"Part {'、'.join(dupes)} 出現不只一次（重複標題＝歧義，不接受）")
    if order != sorted(order) or [p for p in "ABCDE" if p in order] != [p for p in order if p in "ABCDE"]:
        bad(f"Part 順序不對：實得 {'→'.join(order)}，應為 A→B→C→D→E")
    empty = [p for p in "ABCDE" if p in parts and not parts[p].strip()]
    if empty:
        bad(f"Part {'、'.join(empty)} 是空的（有標題沒內容；Part E 是這份工作最重要的產出之一，空白不接受）")
    # 混進半形底線的空＝格式違規（提示詞硬性規定全形 ＿）
    half = HALF.findall(parts.get("B", ""))
    if half:
        bad(f"S 版有 {len(half)} 個空混用半形底線（提示詞規定全形 ＿）：{half[:4]}")
    spaced = re.findall(r"【\d+】[ \t　]+[＿_]", parts.get("B", ""))
    if spaced:
        bad(f"S 版有 {len(spaced)} 個空在【n】與底線之間夾了空白（Grok 掃 #17：這種寫法既不算合法空、也不進半形檢查，會靜默漏計）")
    # 三色標記（提示詞硬性規定 5；Grok 掃 #16 立、Codex r11 修）：
    # 用**單一堆疊**驗整條標記序列——藍紅分開驗會放過異色交錯 [藍][紅]AB[/藍][/紅]。
    # 規則：開必配關、同色配對、不巢狀（堆疊深度 ≤1）；T 與 S 的標記序列必須完全相同
    # （空挖在標記裡面，標記是結構）；挖空撈回的原文不得含任何標記（S 版吞掉整組標記＝結構被挖掉）。
    TAG = re.compile(r"\[/?(藍|紅)\]")
    def tag_problems(text):
        stack = []
        for m in TAG.finditer(text):
            tok, color = m.group(0), m.group(1)
            if tok.startswith("[/"):
                if not stack or stack[-1] != color:
                    return f"「{tok}」沒有對應的開標記（或與前一個開標記異色）"
                stack.pop()
            else:
                if stack:
                    return f"「{tok}」出現在「[{stack[-1]}]」還沒關閉時（標記不可巢狀或交錯）"
                stack.append(color)
        return f"「[{stack[-1]}]」沒有關閉" if stack else None
    for part_name in ("A", "B"):
        err = tag_problems(parts.get(part_name, ""))
        if err:
            bad(f"Part {part_name} 的三色標記序列不合法：{err}")
    seqA = TAG.findall(parts.get("A", "")); seqB = TAG.findall(parts.get("B", ""))
    if seqA != seqB:
        bad(f"T 版與 S 版的三色標記序列不同（T {len(seqA)} 個、S {len(seqB)} 個）——標記是結構，S 版不得增刪或被挖空吞掉")

    if "A" not in parts or "B" not in parts:
        print("\n".join(out) + "\n\n無 T/S 版，無法繼續。")
        sys.exit(1)

    T, S = norm(parts["A"]), norm(parts["B"])

    # 1. 分頁點一致
    tp, sp = PAGE.findall(T), PAGE.findall(S)
    # 疑似分頁行（有「第 n 頁」＋橫線）卻不是精確形式＝格式違規，不能當普通文字放過
    # （Codex PR#2 r5：合法與錯誤標記並存時，錯誤的那行被當成一般文字、頁數還報錯）。
    # 「第 n 頁」＋任何橫線類字元（ASCII 或全形）的行，就是分頁標記的嘗試——
    # 不精確就退回，**不 strip**（Codex PR#2 r6：行首多一格空白被 strip 洗掉、
    # 全形橫線又不在 ASCII 橫線集裡，兩種都溜過）。
    # 橫線類字元改按 Unicode 一般類別 Pd 判定（r7：列舉八種被 U+FE58 穿過——列舉補不完）
    def dashy(line):
        return re.search(r"第\s*\d+\s*頁", line) and any(unicodedata.category(c) == "Pd" for c in line)
    malformed = [l for l in (T + "\n" + S).splitlines() if dashy(l) and not PAGE.fullmatch(l)]
    if malformed:
        bad(f"有 {len(malformed)} 行像分頁標記但不是精確的 `--- 第 n 頁 ---`：{malformed[:3]}")
    if tp == sp and tp:
        if tp != [str(i) for i in range(1, len(tp) + 1)]:
            bad(f"頁碼必須從 1 連號且不重複，實得：{'、'.join(tp)}")
        else:
            ok(f"分頁點一致：{len(tp)} 頁（{'、'.join(tp)}）")
    elif not tp:
        bad("T 版找不到 `--- 第 n 頁 ---` 分頁點（提示詞硬性規定 3）")
    else:
        bad(f"分頁點不一致：T={tp} vs S={sp}")

    # ── r5 #3：T 版不得含任何挖空標記——T 是完整答案版，出現【n】＿＿就根本沒有答案 ──
    t_blanks = BLANK.findall(T) + HALF.findall(T)
    if t_blanks:
        bad(f"T 版含 {len(t_blanks)} 個挖空標記——T 版必須是完整筆記，不可有【n】＿＿")

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
        # 萬用字元會把「S 版整段刪掉」也吞進某個空裡——漏字看起來像挖空。
        # 關門（Codex PR#2 r1）：每個空撈回的原文必須**等於 Part C 申報的原文**。
        # 吞了多餘文字＝撈回的比申報的多＝不符＝不通過；不再用「跨行只警告」放水。
        swallowed = [n for n, g in recovered if PAGE.search(g)]
        if swallowed:
            bad(f"這些空吃掉了分頁點，S 版漏了一整段：{swallowed}")
        tagged = [n for n, g in recovered if TAG.search(g)]
        if tagged:
            bad(f"這些空把三色標記吞進去了（空要挖在標記裡面，標記留在 S 版）：{tagged}")
        declared = declared_originals(parts.get("C", ""))
        if declared.get("__dupes__"):
            bad(f"Part C 有重複編號的列：{sorted(declared['__dupes__'])}（同號兩列＝申報歧義）")
        mismatch = []
        for n, g in recovered:
            if n not in declared:
                mismatch.append(f"【{n}】Part C 沒有申報原文")
            elif not same_text(g, declared[n]):
                mismatch.append(f"【{n}】撈回「{g.strip()[:30]}…」≠ 申報「{declared[n][:30]}…」")
        if mismatch:
            bad("挖空原文與 Part C 申報不符（S 版吞了不該刪的字，或清單填錯）：\n      "
                + "\n      ".join(mismatch[:8]))
        else:
            ok("每個空撈回的原文都與 Part C 申報一致")
    elif nums:
        bad("同構失敗：S 版在挖空以外的地方跟 T 版不一樣（改寫／漏行／多行）")
        skeleton = BLANK.sub("", S)
        diff = [d for d in difflib.unified_diff(
            norm(BLANK.sub("", T)).splitlines(), norm(skeleton).splitlines(),
            "T版", "S版（拿掉挖空標記）", n=1, lineterm="")][:24]
        out.extend("    " + d for d in diff)

    # 4. 數量與比例：印實測值供 William 對照 Part D 自評；不核對 Part D、不因不符而 fail（自評數字是它的功課，不是閘）
    if recovered:
        # 分子分母同一算法（r9：分子含換行與空白、分母不含，多行挖空可算出 >100%）
        blank_chars = sum(len(re.sub(r"\s", "", g)) for _, g in recovered)
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
    # 報告檔名跟輸入檔走（Codex PR#2 r4：甲乙依序跑會互相覆寫）
    (HERE / "run" / f"check-report-{src.stem}.md").write_text(
        f"# 機械檢查報告\n\n來源：`{src}`\n\n```\n{report}\n```\n", encoding="utf-8")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
