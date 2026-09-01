#!/usr/bin/env python3
"""閘門 1 盲測套件的組裝腳本（一次性實驗，非產品程式）。

做兩件事：
  1. 從 Stewart 課本 PDF 切出 15.4 的頁 → run/stewart-15.4-body.pdf（＋習題頁另存）
  2. 把 docs/blanking-rules.md 的 A–D 四節填進提示詞模板 → run/prompt-filled.md

run/ 全部不進版控：課本切片是版權素材，組裝出來的提示詞是衍生物（正本在 docs/）。

⚠️ **只取 A–D 四節，不整份餵**：準則檔還有「出處」與「待辦：盲測」兩段，
   前者點名真筆記是反向工程來源、後者直說這是一場對答案的測驗——
   讓應試模型看到，它就知道自己在被考、而且有標準答案存在，這會改變它的作答。

為什麼用 Python 不用 Node：切 PDF 頁需要 PDF 函式庫，本機已有 pypdf，
而本 repo 刻意沒有 node_modules。一次性腳本不值得為此開依賴。
"""
import argparse
import logging
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = HERE / "run"
TEXTBOOK = Path.home() / "Desktop" / "Multivariable Calculus (7E)pdf.pdf"
RULES = HERE.parent.parent / "docs" / "blanking-rules.md"

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
    ap.add_argument("--rules", default=str(RULES),
                    help="改用另一份準則檔（試跑「準則改這樣會不會比較好」用，不必先 commit）")
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
    rules_path = Path(args.rules)
    if not rules_path.exists():
        die(f"找不到準則正本：{rules_path}")
    rules_doc = rules_path.read_text(encoding="utf-8")

    # 只取 A–D 四節。整份餵會連「出處」與「待辦：盲測」一起送出去＝告訴應試模型它在被考。
    sections = re.findall(r"^## [ABCD]\. .*?(?=^## |\Z)", rules_doc, re.M | re.S)
    if len(sections) != 4:
        die(f"準則檔裡找到 {len(sections)} 個 A–D 節，應該是 4 個——標題格式被改了？")
    rules = "\n".join(sec.strip() for sec in sections)
    n_rules = len(re.findall(r"^- \*\*[ABCD]\d", rules, re.M))
    if n_rules < 4:
        die(f"A–D 四節裡只解析出 {n_rules} 條規則，條列格式被改了？")
    template = (HERE / "prompt-template.md").read_text(encoding="utf-8")
    slot = "{{" + "BLANKING_RULES" + "}}"   # 拆開寫：這支腳本自己也不該出現插槽字面
    # ⚠️ 插槽必須剛好一個。實測踩過：模板頂端的註解裡也寫了插槽字面，
    #    replace 全換 → 準則被塞進註解一份、正文一份，考題等於發了兩份準則。
    n = template.count(slot)
    if n != 1:
        die(f"prompt-template.md 裡的準則插槽出現 {n} 次，必須剛好 1 次。")
    filled = template.replace(slot, rules)
    if slot in filled or rules not in filled:
        die("模板填充失敗——插槽被改壞了？")

    # ⚠️ 剝掉 HTML 註解。實測踩過：模板頂端的註解寫著「盲測提示詞模板」，
    #    組裝出來的提示詞開頭就是它——貼給應試模型，它第一行就知道自己在被考。
    #    模板裡的註解是寫給我們自己看的，一律不出門。
    filled = re.sub(r"<!--.*?-->\n?", "", filled, flags=re.S).lstrip()

    # 禁詞掃的是**最終要送出去的整份**，不是只掃準則段落——洩題可以從模板漏，也可以從註解漏。
    for banned in ("盲測", "真筆記", "試鏡", "評分", "Grok"):
        if banned in filled:
            die(f"要送出去的提示詞裡出現「{banned}」——應試模型看到就知道自己在被考。"
                f"那句話應該留在 README 或註解裡（註解會被剝掉）。")

    out = RUN / "prompt-filled.md"
    out.write_text(filled, encoding="utf-8")

    # 這一輪用的是哪一版準則、哪一版考題——之後回歸語料庫要對得上，靠這份清單
    def blob(p):
        return subprocess.run(["git", "hash-object", str(p)], capture_output=True,
                              text=True).stdout.strip()[:12] or "（不在 git 裡）"
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "status", "--porcelain", "--", str(rules_path),
                                 str(HERE / "prompt-template.md")],
                                capture_output=True, text=True).stdout.strip())
    manifest = (
        f"準則檔：{rules_path}\n"
        f"準則內容 hash：{blob(rules_path)}（{n_rules} 條）\n"
        f"考題模板 hash：{blob(HERE / 'prompt-template.md')}\n"
        f"repo HEAD：{head}{'（工作區有未 commit 的改動，這一輪的數字不可重現）' if dirty else ''}\n"
        f"課本範圍：PDF 第 {first}–{body_last} 頁\n")
    (RUN / "kit-manifest.txt").write_text(manifest, encoding="utf-8")

    print(f"\n填提示詞：\n  ✓ {out.name}（準則 A–D 四節、{n_rules} 條）")
    print(f"  ✓ kit-manifest.txt（這一輪用的準則版本與考題版本）")
    print("\n" + manifest.rstrip())
    print("\n下一步：開一個全新的 Grok 對話 → 上傳 run/stewart-15.4-body.pdf → 貼上 run/prompt-filled.md")
    print("⚠ 那個對話裡不可以出現 CH15 (T).pdf / Calc_07 (S).pdf 的任何內容。")


if __name__ == "__main__":
    main()
