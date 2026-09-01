# 閘門 1 盲測套件（Stewart 15.4 極座標雙重積分）

一次性實驗，**不是產品程式**（依 CLAUDE.md 鐵則 1，`experiments/` 下的腳本不算動工）。

盲測要回答兩個問題，兩個要分開評：

1. **準則問題**：挖空準則 v1 寫得夠不夠清楚，讓一個沒教過這門課的模型能照著做出接近 William 的挖空？
2. **人事問題**：Grok 能不能當本專案的實作者？（PLAN.md 閘門 1 註明：這同時是 Grok 的試鏡）

## 盲性規則（這套東西唯一的價值來源）

| 角色 | 可以看 | **不可以看** |
|---|---|---|
| Grok（應試者） | 挖空準則正本、Stewart 15.4 課本頁 | CH15 (T).pdf、Calc_07 (S).pdf 的**任何**內容 |
| Claude（出題與評分表設計） | 準則、課本 | 同上 |
| William（閱卷） | 全部 | — |

- 盲測**必須開新對話**跑。同一個對話裡先聊過 15.4 的真筆記，這場就作廢。
- 提示詞裡禁止 Grok 上網找「不簡單筆記」風格樣本——它要從準則推，不是從樣本仿。
- 已知的破口，誠實寫在這裡：**沒有機械保證，靠的是規矩**。跟分支保護那份紀錄同一個誠實劃界（`docs/branch-protection.md`）。

### 本輪盲性聲明（Claude，2026-09-01）

出題與評分表由 Claude 撰寫。撰寫期間**未讀取** `CH15 (T).pdf`、`Calc_07 (S).pdf` 之任何頁面內容；
定位課本 15.4 頁碼時只讀 Stewart 課本 PDF。此聲明可查：本輪沒有任何一次工具呼叫開過那兩份真筆記。

## 素材與版權

| 檔 | 位置 | 進版控？ |
|---|---|---|
| Stewart 課本（74 頁節錄） | `~/Desktop/Multivariable Calculus (7E)pdf.pdf` | 否 |
| 切出來的 15.4 頁（本套件產物） | `run/`（gitignore） | **否** |
| 挖空準則正本 | Notion「十科及格計畫 › 引導式筆記・挖空準則」 | **否**（鐵則 2 防漂移：動工才凍結進 `docs/blanking-rules.md`） |
| 真筆記 T/S 版 | `~/Desktop/CH15 (T).pdf`、`Calc_07 (S).pdf` | 否 |

版權紅線（PLAN.md 五之一）：這些切片只給 William 個人評測用，不散布、不進 repo。

## 15.4 在課本 PDF 的位置（已核對）

| PDF 頁（1-based） | 書頁 | 內容 |
|---|---|---|
| 24 | 1021 | 上半＝15.3 習題尾（**忽略**）；下半＝15.4 標題起 |
| 25–28 | 1022–1025 | 15.4 正文與例題 |
| 29 | 1026 | 15.4 習題 |
| 30 | 1027 | 15.5 起（**不在範圍**） |

⚠️ **我做的一個假設，William 要確認**：盲測範圍取 **24–28（正文＋例題）**，習題頁 29 另切一份備用、預設不做。
理由：真筆記是「課本節的筆記」而非題本。若 William 的 15.4 真筆記其實含習題，改用 `--with-exercises` 重切。
（這個假設我無法自己驗證——驗證就要翻真筆記，那會破壞盲性。）

## 執行程序

1. 把 Notion 挖空準則正本全文，貼進 `run/blanking-rules.txt`（`run/` 不進版控；每次重跑重貼，確保用的是當下正本）：

```bash
mkdir -p "experiments/gate1-blind-test/run" && open -e "experiments/gate1-blind-test/run/blanking-rules.txt"
```

2. 組裝：切課本頁 ＋ 把準則填進提示詞模板。

```bash
python3 experiments/gate1-blind-test/build-kit.py
```

3. 開一個**全新的** Grok 對話，上傳 `run/stewart-15.4-body.pdf`，貼上 `run/prompt-filled.md`。
4. Grok 的輸出整份存成 `run/grok-output.md`，先過機械檢查：

```bash
python3 experiments/gate1-blind-test/check-output.py
```

   檢查的是格式與自洽（S/T 同構、編號連號、清單列數、實測挖空比例），**不是挖空品質**。
   沒過就把報告貼回去要 Grok 重做——格式沒過就不該佔用 William 的紅筆時間。

5. William 紅筆：`cp experiments/gate1-blind-test/grading-sheet.md experiments/gate1-blind-test/run/grading-filled.md`，
   **先填第 0 節的及格線，再看 Grok 的輸出**（看完才訂門檻＝沒有門檻）。
6. 判定寫回 PLAN.md 閘門表（通過／不通過），Grok 試鏡結論寫回 CLAUDE.md 分工節；
   準則要補的條文，William 自己改在 Notion 正本（本 repo 不代改）。

## 檔案

| 檔 | 做什麼 |
|---|---|
| `prompt-template.md` | 考題模板。準則正文**不在裡面**（鐵則 2），留 `{{BLANKING_RULES}}` 插槽 |
| `build-kit.py` | 切課本頁 ＋ 填準則 → `run/`。頁碼有自檢，換版會大聲死掉 |
| `check-output.py` | 機械檢查 Grok 的輸出（同構、編號、比例）。已用壞掉的樣本實測會叫 |
| `grading-sheet.md` | William 的紅筆評分表（準則的成績／Grok 的試鏡／準則要不要改，三段分開） |
| `run/` | 全部產物與素材，**不進版控** |

## 為什麼輸入是 PDF 頁而不是抽出來的純文字

實測過：`pdftotext` 抽這幾頁，數學符號整組錯碼（`=` 變 `!`、`|` 變 `"`），
pypdf 則整段掉字。**數學筆記的盲測餵錯碼的文字＝測不出東西**。所以直接給頁面本身。
這件事本身是閘門 3 的技術情報：真做管線時，數學 PDF 的解析不能靠文字抽取。
