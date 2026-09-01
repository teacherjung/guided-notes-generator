#!/usr/bin/env python3
"""閘門 1 盲測套件的組裝腳本（一次性實驗，非產品程式）。

做兩件事：
  1. 從 Stewart 課本 PDF 切出 15.4 的頁 → run/stewart-15.4-body.pdf（＋習題頁另存）
  2. 把 run/blanking-rules.txt（William 當下從 Notion 貼來的正本）填進提示詞模板
     → run/prompt-filled.md

run/ 全部不進版控：課本切片是版權素材，準則副本會漂移（CLAUDE.md 鐵則 2）。

為什麼用 Python 不用 Node：切 PDF 頁需要 PDF 函式庫，本機已有 pypdf，
而本 repo 刻意沒有 node_modules。一次性腳本不值得為此開依賴。
"""
import argparse
import logging
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = HERE / "run"
TEXTBOOK = Path.home() / "Desktop" / "Multivariable Calculus (7E)pdf.pdf"

# 1-based 頁碼。README 的對照表是這裡的正本，改一邊要改兩邊。
BODY_PAGES = (24, 28)      # 書頁 1021（下半起）–1025：15.4 正文與例題
EXERCISE_PAGES = (29, 29)  # 書頁 1026：15.4 習題

SECTION_MARK = "DOUBLE INTEGRALS IN POLAR COORDINATES"
NEXT_SECTION_MARK = "APPLICATIONS OF DOUBLE INTEGRALS"  # 15.5，切過頭的話會出現


def die(msg):
    print(f"\n✗ {msg}\n", file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-exercises", action="store_true",
                    help="把習題頁併進盲測範圍（預設不併，見 README 的假設說明）")
    args = ap.parse_args()

    logging.disable(logging.CRITICAL)  # 這份課本 PDF 有大量無害的 xref 警告
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        die("找不到 pypdf。安裝：python3 -m pip install pypdf")

    if not TEXTBOOK.exists():
        die(f"找不到課本 PDF：{TEXTBOOK}")

    RUN.mkdir(exist_ok=True)
    reader = PdfReader(str(TEXTBOOK))

    def text_of(page_1based):
        return (reader.pages[page_1based - 1].extract_text() or "").upper()

    # 頁碼自檢：換一份 PDF 就會切錯，寧可大聲死掉也不要靜靜地送錯考卷
    first, last = BODY_PAGES
    if SECTION_MARK not in text_of(first):
        die(f"第 {first} 頁找不到 15.4 標題——課本 PDF 換版了？請重新核對 README 的頁碼表。")
    if NEXT_SECTION_MARK in text_of(last):
        die(f"第 {last} 頁已經進到 15.5——頁碼表過期了，請重新核對。")

    body_last = EXERCISE_PAGES[1] if args.with_exercises else last

    def write_slice(a, b, name):
        w = PdfWriter()
        for p in range(a, b + 1):
            w.add_page(reader.pages[p - 1])
        out = RUN / name
        with open(out, "wb") as f:
            w.write(f)
        print(f"  ✓ {out.name}（PDF 第 {a}–{b} 頁，共 {b - a + 1} 頁）")

    print("切課本頁：")
    write_slice(first, body_last, "stewart-15.4-body.pdf")
    if not args.with_exercises:
        write_slice(*EXERCISE_PAGES, "stewart-15.4-exercises.pdf")

    # 填提示詞
    rules_file = RUN / "blanking-rules.txt"
    template = (HERE / "prompt-template.md").read_text(encoding="utf-8")
    if not rules_file.exists() or not rules_file.read_text(encoding="utf-8").strip():
        print(f"\n⚠ 提示詞沒填成：{rules_file} 不存在或是空的。")
        print("  請把 Notion『十科及格計畫 › 引導式筆記・挖空準則』全文貼進去，再跑一次：")
        print(f"  mkdir -p '{RUN}' && open -e '{rules_file}'")
        sys.exit(2)

    rules = rules_file.read_text(encoding="utf-8").strip()
    slot = "{{" + "BLANKING_RULES" + "}}"   # 拆開寫：這支腳本自己也不該出現插槽字面
    # ⚠️ 插槽必須剛好一個。實測踩過：模板頂端的註解裡也寫了插槽字面，
    #    replace 全換 → 準則被塞進註解一份、正文一份，考題等於發了兩份準則。
    n = template.count(slot)
    if n != 1:
        die(f"prompt-template.md 裡的準則插槽出現 {n} 次，必須剛好 1 次。")
    filled = template.replace(slot, rules)
    if slot in filled or rules not in filled:
        die("模板填充失敗——插槽被改壞了？")

    out = RUN / "prompt-filled.md"
    out.write_text(filled, encoding="utf-8")
    print(f"\n填提示詞：\n  ✓ {out.name}（準則 {len(rules)} 字）")
    print("\n下一步：開一個全新的 Grok 對話 → 上傳 run/stewart-15.4-body.pdf → 貼上 run/prompt-filled.md")
    print("⚠ 那個對話裡不可以出現 CH15 (T).pdf / Calc_07 (S).pdf 的任何內容。")


if __name__ == "__main__":
    main()
